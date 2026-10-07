import {
  A2AClient,
  A2AError,
  A2A_PEER_HEADER,
  ConversationTracker,
  type Artifact,
  type Message,
  type Part,
  type Speaker,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskState,
  type TaskStatus,
  type TaskStatusUpdateEvent,
  type Turn,
} from "a2a"
import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin/tool"
import { CAP_MESSAGE, type A2AConfig } from "./config.ts"
import type { Canceller } from "./cancel.ts"
import { noopEmitter, type A2AEventEmitter } from "./events.ts"

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS = 300

const TERMINAL_STATES: readonly TaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]
const INTERRUPTED_STATES: readonly TaskState[] = ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]

export type Conversation = {
  peerId: string
  client: A2AClient
  streaming: boolean
  contextId?: string
  tracker?: ConversationTracker
  // Set once the task reaches a terminal state so a follow-up cannot appear to
  // reopen a finished conversation (late replies stay ignored).
  terminal?: TaskState
}

// One entry per A2A task id. The tracker is created once the task id is known,
// so every recorded turn carries the real task id.
export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>()

  get(taskId: string): Conversation | undefined {
    return this.conversations.get(taskId)
  }

  save(taskId: string, conversation: Conversation): void {
    this.conversations.set(taskId, conversation)
  }
}

type AskDeps = {
  config: A2AConfig
  store: ConversationStore
  emit: A2AEventEmitter
  cancel: Canceller
  timeoutMs: number
  pollMs: number
}

type AskArgs = {
  peer: string
  message: string
  taskId?: string
}

// A fresh task id only becomes known mid-turn; the turn functions write it
// here so an abort (or timeout) can cancel the right remote task.
type TaskIdRef = { current?: string }

type Outcome = {
  reply?: string
  artifact?: string
  state: TaskState
}

export function createAskTool(input: {
  config: A2AConfig
  store: ConversationStore
  emit?: A2AEventEmitter
  cancel?: Canceller
  timeoutMs?: number
  pollMs?: number
}) {
  const deps: AskDeps = {
    config: input.config,
    store: input.store,
    emit: input.emit ?? noopEmitter,
    cancel: input.cancel ?? (async () => undefined),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollMs: input.pollMs ?? DEFAULT_POLL_MS,
  }
  return tool({
    description:
      "Ask an allowed A2A peer agent a question and read its reply. " +
      "To follow up in the same conversation, pass the task id returned by the previous call.",
    args: {
      peer: tool.schema.string().describe("Peer name from the allowedPeers config"),
      message: tool.schema.string().describe("Text question or message to send to the peer"),
      taskId: tool.schema
        .string()
        .optional()
        .describe("Task id from a previous a2a_ask call; pass it to continue the same task"),
    },
    execute: (args, context) => ask(deps, args, context),
  })
}

async function ask(deps: AskDeps, args: AskArgs, context?: ToolContext): Promise<ToolResult> {
  if (!deps.config.enabled) throw new Error("a2a_ask is unavailable: A2A is disabled")
  const text = args.message.trim()
  if (!text) throw new Error("a2a_ask requires a non-empty message")
  const baseUrl = deps.config.allowedPeers[args.peer]
  if (!baseUrl) throw new Error(`Unknown A2A peer "${args.peer}". Allowed peers: ${allowedNames(deps.config)}`)

  // A2A-012: an interrupted turn (the human pressed cancel/stop) must stop the
  // peer's task too. The listener races every network await below and cancels
  // the conversation as soon as its task id is known; the turn functions write
  // ids into `taskId` as they discover them.
  const signal = context?.abort
  const taskId = { current: args.taskId }
  const onAbort = () => void deps.cancel(taskId.current, "canceled by user").catch(() => undefined)
  if (signal?.aborted) throw abortError()
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const conversation = await raceAbort(signal, resolveConversation(deps, args, baseUrl))
    taskId.current = conversation.tracker?.taskId ?? taskId.current
    const tracker = conversation.tracker
    if (tracker && tracker.history().length >= deps.config.maxTurns) return capResult(deps, args, tracker)
    if (conversation.terminal !== undefined) return terminalResult(args, conversation)

    const outgoing: Message = {
      messageId: crypto.randomUUID(),
      role: "ROLE_USER",
      parts: [{ text }],
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(conversation.contextId ? { contextId: conversation.contextId } : {}),
    }
    const priorRemote = remoteCount(tracker)
    const turn = conversation.streaming
      ? streamTurn(deps, conversation, outgoing, priorRemote, taskId, signal)
      : pollTurn(deps, conversation, outgoing, priorRemote, taskId, signal)
    // The A2A client buffers SSE bodies, so a peer that never settles its turn
    // would hang the tool past the deadline: bound the streamed turn and cancel
    // the remote task on timeout so the peer stops working too (A2A-012
    // hardening for the A2A-004 review's buffered-SSE gap).
    const bounded = conversation.streaming
      ? withDeadline(turn, deps.timeoutMs, () => {
          void deps.cancel(taskId.current, `turn timed out after ${deps.timeoutMs}ms`).catch(() => undefined)
          return new Error(`Timed out waiting for A2A peer "${conversation.peerId}" to reply`)
        })
      : turn
    const outcome = await raceAbort(signal, bounded)
    if (TERMINAL_STATES.includes(outcome.state)) conversation.terminal = outcome.state
    return renderResult(deps, args, conversation, outcome)
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

// The tool turn itself was aborted by the host; throwing an AbortError lets
// opencode mark the turn interrupted instead of failed.
function abortError(): Error {
  const error = new Error("a2a_ask aborted")
  error.name = "AbortError"
  return error
}

function raceAbort<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

// Reject after `ms` even if the wrapped promise never settles. The caller's
// onTimeout supplies the error and any cleanup (for example cancelling the
// remote task) so the peer cannot keep working on a turn we gave up on.
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// A task id we have not seen before can still be resumed: fetch the task,
// rebuild the turn history from it, and count it toward the cap.
async function resolveConversation(deps: AskDeps, args: AskArgs, baseUrl: string): Promise<Conversation> {
  if (args.taskId) {
    const cached = deps.store.get(args.taskId)
    if (cached) {
      if (cached.peerId !== args.peer)
        throw new Error(`Task "${args.taskId}" belongs to peer "${cached.peerId}", not "${args.peer}"`)
      return cached
    }
    const client = new A2AClient({ baseUrl, headers: peerHeaders(deps.config) })
    const task = await request(args.peer, () => client.getTask(args.taskId!))
    const tracker = new ConversationTracker({ taskId: task.id })
    tracker.sync(task, speakerOf)
    const conversation: Conversation = {
      peerId: args.peer,
      client,
      streaming: await supportsStreaming(client),
      contextId: task.contextId,
      tracker,
    }
    deps.store.save(task.id, conversation)
    return conversation
  }
  const client = new A2AClient({ baseUrl, headers: peerHeaders(deps.config) })
  return { peerId: args.peer, client, streaming: await supportsStreaming(client) }
}

// Self-identify to the peer so its session record can name who is calling.
function peerHeaders(config: A2AConfig): Record<string, string> | undefined {
  return config.name === undefined ? undefined : { [A2A_PEER_HEADER]: config.name }
}

async function pollTurn(
  deps: AskDeps,
  conversation: Conversation,
  outgoing: Message,
  priorRemote: number,
  taskIdRef: TaskIdRef,
  signal?: AbortSignal,
): Promise<Outcome> {
  const response = await request(conversation.peerId, () => conversation.client.sendMessage(outgoing))

  // A synchronous peer can answer with a Message instead of a Task.
  if (isMessage(response)) {
    ensureTracker(conversation, response.taskId)
    taskIdRef.current = response.taskId ?? taskIdRef.current
    noteTurn(deps, conversation, outgoing, "local")
    noteTurn(deps, conversation, response, "remote")
    if (conversation.tracker && response.taskId) deps.store.save(response.taskId, conversation)
    return { reply: messageText(response), state: "TASK_STATE_COMPLETED" }
  }

  const fresh = conversation.tracker === undefined
  const tracker = ensureTracker(conversation, response.id)
  if (!tracker) throw new Error(`A2A peer "${conversation.peerId}" did not create a task`)
  taskIdRef.current = response.id
  if (fresh)
    deps.emit("a2a.task.dispatched", {
      taskId: response.id,
      peerId: conversation.peerId,
      state: response.status.state,
    })
  noteTurn(deps, conversation, outgoing, "local")
  syncTurns(deps, conversation, response)
  conversation.contextId ??= response.contextId
  deps.store.save(response.id, conversation)

  let task = response
  // A fresh task's first state already rode out on a2a.task.dispatched — but
  // terminal states keep their dedicated event, so only dedupe interim ones.
  let last: TaskState | undefined =
    fresh && !TERMINAL_STATES.includes(response.status.state) ? response.status.state : undefined
  const emitState = () => {
    if (task.status.state === last) return
    last = task.status.state
    emitTaskState(
      deps,
      task.id,
      conversation.peerId,
      task.status.state,
      statusText(task.status),
      task.artifacts?.at(-1),
    )
  }
  emitState()
  let outcome = taskOutcome(task, tracker, priorRemote)
  const deadline = Date.now() + deps.timeoutMs
  while (!outcome.reply && !outcome.artifact && !settled(outcome.state) && Date.now() < deadline) {
    if (signal?.aborted) throw abortError()
    await Bun.sleep(deps.pollMs)
    task = await request(conversation.peerId, () => conversation.client.getTask(task.id))
    syncTurns(deps, conversation, task)
    emitState()
    conversation.contextId ??= task.contextId
    outcome = taskOutcome(task, tracker, priorRemote)
  }

  if (outcome.state === "TASK_STATE_FAILED" || outcome.state === "TASK_STATE_CANCELED") {
    conversation.terminal = outcome.state
    throw new Error(`A2A peer "${conversation.peerId}" ended task ${task.id} with ${outcome.state}`)
  }
  if (!outcome.reply && !outcome.artifact && !settled(outcome.state)) {
    // The turn outlived the deadline: stop the peer from working on a task we
    // are no longer waiting for, then surface the timeout as before. The
    // cancel is fire-and-forget so an unresponsive peer cannot hang the tool.
    void deps.cancel(taskIdRef.current, "turn timed out").catch(() => undefined)
    throw new Error(`Timed out waiting for A2A peer "${conversation.peerId}" to reply (task ${task.id})`)
  }
  return outcome
}

async function streamTurn(
  deps: AskDeps,
  conversation: Conversation,
  outgoing: Message,
  priorRemote: number,
  taskIdRef: TaskIdRef,
  signal?: AbortSignal,
): Promise<Outcome> {
  const peer = conversation.peerId
  const deadline = Date.now() + deps.timeoutMs
  const fresh = conversation.tracker === undefined
  let task: Task | undefined
  let taskId: string | undefined
  let contextId: string | undefined
  let reply: string | undefined
  let replyMessage: Message | undefined
  const streamed: Message[] = []
  let artifact: string | undefined
  let lastArtifact: Artifact | undefined
  let state: TaskState | undefined
  let last: TaskState | undefined
  let dispatched = false
  const seeTaskId = (id: string | undefined) => {
    if (id === undefined) return
    taskId = id
    taskIdRef.current = id
  }
  const emitState = (next: TaskState, id: string | undefined, content?: string, seen?: Artifact) => {
    if (!id || next === last) return
    last = next
    emitTaskState(deps, id, peer, next, content, seen)
  }
  const markDispatched = (id: string | undefined, next: TaskState | undefined) => {
    if (!fresh || !id || dispatched) return
    dispatched = true
    const initial = next ?? "TASK_STATE_SUBMITTED"
    // The dispatch event already carries this state; dedupe it from updated —
    // unless it is terminal, which still needs its dedicated event type.
    if (!TERMINAL_STATES.includes(initial)) last = initial
    deps.emit("a2a.task.dispatched", { taskId: id, peerId: peer, state: initial })
  }

  try {
    for await (const event of conversation.client.streamMessage(outgoing)) {
      if (signal?.aborted) throw abortError()
      if (Date.now() > deadline) throw new Error(`Timed out waiting for A2A peer "${peer}" to reply`)
      if (isStatusUpdate(event)) {
        taskId ??= event.taskId
        seeTaskId(taskId)
        contextId ??= event.contextId
        state = event.status.state
        markDispatched(taskId, state)
        emitState(state, taskId, statusText(event.status), lastArtifact)
        if (event.status.message) {
          reply = messageText(event.status.message)
          replyMessage = event.status.message
        }
        continue
      }
      if (isArtifactUpdate(event)) {
        taskId ??= event.taskId
        seeTaskId(taskId)
        contextId ??= event.contextId
        artifact = partsText(event.artifact.parts)
        lastArtifact = event.artifact
        continue
      }
      if (isTask(event)) {
        task = event
        taskId ??= event.id
        seeTaskId(taskId)
        contextId ??= event.contextId
        state = event.status.state
        markDispatched(taskId, state)
        lastArtifact = event.artifacts?.at(-1) ?? lastArtifact
        emitState(state, taskId, statusText(event.status), lastArtifact)
        continue
      }
      reply = messageText(event)
      replyMessage = event
      streamed.push(event)
    }
  } catch (error) {
    if (error instanceof A2AError) throw new Error(`A2A peer "${peer}" error ${error.code}: ${error.message}`)
    throw error instanceof Error ? error : new Error(String(error))
  }

  if (fresh && taskId && !dispatched) {
    seeTaskId(taskId)
    deps.emit("a2a.task.dispatched", { taskId, peerId: peer, state: state ?? "TASK_STATE_SUBMITTED" })
  }
  const tracker = ensureTracker(conversation, taskId)
  noteTurn(deps, conversation, outgoing, "local")
  if (task) syncTurns(deps, conversation, task)
  // The task snapshot is written before the host appends its reply, so the
  // reply only shows up as a stream event: note it or the turn cap would
  // under-count every streamed reply and let extra asks through.
  for (const message of streamed) noteTurn(deps, conversation, message, "remote")
  if (!task && replyMessage) noteTurn(deps, conversation, replyMessage, "remote")
  conversation.contextId ??= contextId
  if (tracker && taskId) deps.store.save(taskId, conversation)

  const outcome: Outcome = {
    reply: reply ?? (tracker && remoteCount(tracker) > priorRemote ? lastRemoteText(tracker) : undefined),
    artifact: artifact ?? (task ? artifactText(task) : undefined),
    state: state ?? task?.status.state ?? (reply ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING"),
  }

  // Mirror pollTurn: a failed, canceled, or truncated stream must surface as an
  // error instead of a successful turn with "Reply: (none)".
  if (outcome.state === "TASK_STATE_FAILED" || outcome.state === "TASK_STATE_CANCELED") {
    conversation.terminal = outcome.state
    throw new Error(`A2A peer "${peer}" ended task ${taskId ?? task?.id ?? "unknown"} with ${outcome.state}`)
  }
  if (!outcome.reply && !outcome.artifact && !settled(outcome.state))
    throw new Error(`A2A peer "${peer}" ended the stream without a reply (task ${taskId ?? "unknown"})`)
  return outcome
}

async function request<T>(peer: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof A2AError) throw new Error(`A2A peer "${peer}" error ${error.code}: ${error.message}`)
    throw new Error(`A2A peer "${peer}" request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function supportsStreaming(client: A2AClient): Promise<boolean> {
  try {
    const card = await client.fetchAgentCard()
    return card.capabilities.streaming === true
  } catch {
    // A peer without a readable card can still be driven with send + poll.
    return false
  }
}

function renderResult(deps: AskDeps, args: AskArgs, conversation: Conversation, outcome: Outcome): ToolResult {
  const tracker = conversation.tracker
  const lines = [`Peer: ${args.peer}`]
  if (tracker) lines.push(`Task: ${tracker.taskId}`, `Turn: ${tracker.history().length}/${deps.config.maxTurns}`)
  lines.push(outcome.reply ? `Reply: ${outcome.reply}` : "Reply: (none)")
  if (outcome.artifact) lines.push(`Artifact: ${outcome.artifact}`)
  return {
    title: tracker ? `${args.peer} turn ${tracker.history().length}/${deps.config.maxTurns}` : `${args.peer} reply`,
    output: lines.join("\n"),
    metadata: {
      peerId: args.peer,
      ...(tracker ? { taskId: tracker.taskId, turn: tracker.history().length } : {}),
      state: outcome.state,
    },
  }
}

function terminalResult(args: AskArgs, conversation: Conversation): ToolResult {
  const state = conversation.terminal
  const tracker = conversation.tracker
  const lines = [`Peer: ${args.peer}`]
  if (tracker) lines.push(`Task: ${tracker.taskId}`)
  lines.push(
    `State: ${state}`,
    "This task is already finished; send a new message without a taskId to start a new task.",
  )
  return {
    title: `task ${state}`,
    output: lines.join("\n"),
    metadata: {
      peerId: args.peer,
      ...(tracker ? { taskId: tracker.taskId } : {}),
      state,
    },
  }
}

function capResult(deps: AskDeps, args: AskArgs, tracker: ConversationTracker): ToolResult {
  deps.emit("a2a.task.completed", {
    taskId: tracker.taskId,
    peerId: args.peer,
    state: "TASK_STATE_COMPLETED",
    content: CAP_MESSAGE,
  })
  return {
    title: `max turns reached (${args.peer})`,
    output: [
      `Peer: ${args.peer}`,
      `Task: ${tracker.taskId}`,
      `Turn: ${tracker.history().length}/${deps.config.maxTurns}`,
      CAP_MESSAGE,
    ].join("\n"),
    metadata: {
      peerId: args.peer,
      taskId: tracker.taskId,
      turn: tracker.history().length,
      state: "TASK_STATE_COMPLETED",
    },
  }
}

function allowedNames(config: A2AConfig): string {
  const names = Object.keys(config.allowedPeers)
  return names.length ? names.join(", ") : "(none configured)"
}

function ensureTracker(conversation: Conversation, taskId: string | undefined): ConversationTracker | undefined {
  if (conversation.tracker) return conversation.tracker
  if (!taskId) return undefined
  conversation.tracker = new ConversationTracker({ taskId })
  return conversation.tracker
}

function speakerOf(message: Message): Speaker {
  return message.role === "ROLE_USER" ? "local" : "remote"
}

// A2A-008 fan-out: every recorded turn leaves as one a2a.conversation.turn
// event so the UI can render the thread without polling tasks/get.
function noteTurn(deps: AskDeps, conversation: Conversation, message: Message, speaker: Speaker): void {
  const tracker = conversation.tracker
  if (!tracker) {
    // A peer answering with a bare Message may carry no task at all; still
    // emit the turn so the UI thread shows it.
    deps.emit("a2a.conversation.turn", {
      speaker,
      turn: speaker === "local" ? 0 : 1,
      taskId: message.taskId,
      peerId: speaker === "local" ? deps.config.name : conversation.peerId,
      content: messageText(message),
    })
    return
  }
  const note = tracker.note(message, speaker)
  if (note.kind === "added") emitTurn(deps, conversation, note.turn)
}

function syncTurns(deps: AskDeps, conversation: Conversation, task: Task): void {
  const tracker = conversation.tracker
  if (!tracker) return
  for (const note of tracker.sync(task, speakerOf)) {
    if (note.kind === "added") emitTurn(deps, conversation, note.turn)
  }
}

function emitTurn(deps: AskDeps, conversation: Conversation, turn: Turn): void {
  deps.emit("a2a.conversation.turn", {
    speaker: turn.speaker,
    turn: turn.index,
    taskId: turn.taskId,
    peerId: turn.speaker === "local" ? deps.config.name : conversation.peerId,
    content: turn.text,
  })
}

// Terminal states map to their own event types; everything else is a generic
// a2a.task.updated, which also carries TASK_STATE_CANCELED.
function emitTaskState(
  deps: AskDeps,
  taskId: string,
  peerId: string,
  state: TaskState,
  content?: string,
  artifact?: Artifact,
): void {
  const properties = {
    taskId,
    peerId,
    state,
    ...(content === undefined ? {} : { content }),
    ...(artifact === undefined ? {} : { artifact }),
  }
  if (state === "TASK_STATE_COMPLETED") deps.emit("a2a.task.completed", properties)
  else if (state === "TASK_STATE_FAILED") deps.emit("a2a.task.failed", properties)
  else deps.emit("a2a.task.updated", properties)
}

function statusText(status: TaskStatus): string | undefined {
  return status.message ? messageText(status.message) : undefined
}

function remoteCount(tracker: ConversationTracker | undefined): number {
  return tracker ? tracker.history().filter((turn) => turn.speaker === "remote").length : 0
}

function lastRemoteText(tracker: ConversationTracker): string | undefined {
  const turns = tracker.history()
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (turn.speaker === "remote") return turn.text
  }
  return undefined
}

function taskOutcome(task: Task, tracker: ConversationTracker, priorRemote: number): Outcome {
  return {
    reply: remoteCount(tracker) > priorRemote ? lastRemoteText(tracker) : undefined,
    artifact: artifactText(task),
    state: task.status.state,
  }
}

function messageText(message: Message): string {
  return partsText(message.parts)
}

function partsText(parts: Part[]): string {
  return parts.map((part) => part.text).join("\n")
}

function artifactText(task: Task): string | undefined {
  const artifact = task.artifacts?.at(-1)
  if (!artifact) return undefined
  return partsText(artifact.parts)
}

function settled(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state) || INTERRUPTED_STATES.includes(state)
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    typeof value.messageId === "string" &&
    typeof value.role === "string" &&
    Array.isArray(value.parts)
  )
}

function isTask(value: unknown): value is Task {
  return isRecord(value) && typeof value.id === "string" && isRecord(value.status)
}

function isStatusUpdate(value: unknown): value is TaskStatusUpdateEvent {
  return isRecord(value) && typeof value.taskId === "string" && isRecord(value.status)
}

function isArtifactUpdate(value: unknown): value is TaskArtifactUpdateEvent {
  return isRecord(value) && typeof value.taskId === "string" && isRecord(value.artifact)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
