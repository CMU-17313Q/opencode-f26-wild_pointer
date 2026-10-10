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
import { CAP_MESSAGE, type A2AConfig } from "./config.ts"
import type { Canceller } from "./cancel.ts"
import { noopEmitter, type A2AEventEmitter } from "./events.ts"
import type { ConversationOrigin, Registry } from "./registry.ts"

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS = 300

const TERMINAL_STATES: readonly TaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]
const INTERRUPTED_STATES: readonly TaskState[] = ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]

// A conversation's config is read on every turn so a peer added through the
// local control API is usable without restarting the host. Tests pass a plain
// object; the plugin passes a getter over the live resolved config.
export type ConfigProvider = A2AConfig | (() => A2AConfig)

export function readConfig(config: ConfigProvider): A2AConfig {
  return typeof config === "function" ? config() : config
}

export type Conversation = {
  peerId: string
  client: A2AClient
  streaming: boolean
  contextId?: string
  tracker?: ConversationTracker
  // Set once the task reaches a terminal state so a follow-up cannot appear to
  // reopen a finished conversation (late replies stay ignored).
  terminal?: TaskState
  // The registry-aware emitter for this conversation, kept on the record so the
  // shared canceller emits its terminal event through the same code path that
  // keeps the session registry in sync.
  emit?: A2AEventEmitter
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

export type ConversationDeps = {
  config: ConfigProvider
  store: ConversationStore
  emit?: A2AEventEmitter
  cancel?: Canceller
  timeoutMs?: number
  pollMs?: number
  registry?: Registry
}

type Deps = {
  config: ConfigProvider
  store: ConversationStore
  emit: A2AEventEmitter
  cancel: Canceller
  timeoutMs: number
  pollMs: number
  registry?: Registry
}

export type ConversationOptions = {
  // Continue an existing task instead of starting a new one.
  taskId?: string
  // The remote peer; required to start, derived from the store for continue.
  peer?: string
  origin?: ConversationOrigin
  // The host session that initiated the call, when there is one.
  sessionId?: string
  signal?: AbortSignal
}

// The structured turn outcome shared by the tool renderer, the local control
// API, and the session registry.
export type ConversationResult = {
  peerId: string
  taskId?: string
  turn?: number
  firstTurn?: number
  reply?: string
  artifact?: string
  message?: string
  state: TaskState
  capped?: boolean
  terminal?: boolean
}

// The conversation machinery without the tool/model layer: `a2a_ask`, the local
// control API, and any future UI all drive the same three entry points.
export type ConversationCore = {
  startConversation: (peer: string, text: string, opts?: ConversationOptions) => Promise<ConversationResult>
  continueConversation: (taskId: string, text: string, opts?: ConversationOptions) => Promise<ConversationResult>
  cancelConversation: (taskId: string, reason?: string) => Promise<void>
}

export function createConversationCore(input: ConversationDeps): ConversationCore {
  const deps: Deps = {
    config: input.config,
    store: input.store,
    emit: input.emit ?? noopEmitter,
    cancel: input.cancel ?? (async () => undefined),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollMs: input.pollMs ?? DEFAULT_POLL_MS,
    registry: input.registry,
  }
  return {
    startConversation: (peer, text, opts) => runTurn(deps, peer, text, opts ?? {}),
    continueConversation: (taskId, text, opts) => {
      const peer = opts?.peer ?? deps.store.get(taskId)?.peerId
      if (peer === undefined || peer === "") throw new Error(`Unknown A2A task "${taskId}"`)
      return runTurn(deps, peer, text, { ...opts, taskId })
    },
    cancelConversation: async (taskId, reason) => {
      await deps.cancel(taskId, reason)
    },
  }
}

type TaskIdRef = { current?: string }

type Outcome = {
  reply?: string
  artifact?: string
  state: TaskState
}

// Start (or, when `opts.taskId` is set, resume) a conversation turn. The flow is
// the one A2A-004..013 established: resolve the task, honor the cap and terminal
// states, send one message, then stream or poll until the turn settles.
async function runTurn(deps: Deps, peer: string, text: string, opts: ConversationOptions): Promise<ConversationResult> {
  const config = readConfig(deps.config)
  if (!config.enabled) throw new Error("a2a_ask is unavailable: A2A is disabled")
  const message = text.trim()
  if (!message) throw new Error("a2a_ask requires a non-empty message")
  const baseUrl = config.allowedPeers[peer]
  if (!baseUrl) throw new Error(`Unknown A2A peer "${peer}". Allowed peers: ${allowedNames(config)}`)

  // The registry records every task and turn through the emitter, so a UI
  // reading events and a UI reading the registry can never disagree.
  const emit = attachEmitter(deps, {
    direction: "outbound",
    origin: opts.origin ?? "tool",
    peerId: peer,
    sessionId: opts.sessionId,
  })
  const scoped: Deps = { ...deps, emit }

  // A2A-012: an interrupted turn (the human pressed cancel/stop) must stop the
  // peer's task too. The listener races every network await below and cancels
  // the conversation as soon as its task id is known; the turn functions write
  // ids into `taskId` as they discover them.
  const signal = opts.signal
  const taskId = { current: opts.taskId }
  const onAbort = () => void deps.cancel(taskId.current, "canceled by user").catch(() => undefined)
  if (signal?.aborted) throw abortError()
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const conversation = await raceAbort(signal, resolveConversation(scoped, peer, opts.taskId, baseUrl))
    conversation.emit = emit
    taskId.current = conversation.tracker?.taskId ?? taskId.current
    const tracker = conversation.tracker
    if (tracker && tracker.history().length >= config.maxTurns) return capResult(scoped, peer, tracker)
    if (conversation.terminal !== undefined) return terminalResult(peer, conversation)

    // The index this run's first turn will occupy. The inline UI anchors one
    // box per a2a_ask call on it, so each box shows only its own turns.
    const firstTurn = tracker?.history().length ?? 0
    const outgoing: Message = {
      messageId: crypto.randomUUID(),
      role: "ROLE_USER",
      parts: [{ text: message }],
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(conversation.contextId ? { contextId: conversation.contextId } : {}),
    }
    const priorRemote = remoteCount(tracker)
    const turn = conversation.streaming
      ? streamTurn(scoped, conversation, outgoing, priorRemote, taskId, signal)
      : pollTurn(scoped, conversation, outgoing, priorRemote, taskId, signal)
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
    return outcomeResult(conversation, outcome, firstTurn)
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

function attachEmitter(deps: Deps, ctx: Parameters<Registry["attach"]>[1]): A2AEventEmitter {
  if (deps.registry === undefined) return deps.emit
  return deps.registry.attach(deps.emit, ctx)
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
async function resolveConversation(
  deps: Deps,
  peer: string,
  taskId: string | undefined,
  baseUrl: string,
): Promise<Conversation> {
  if (taskId) {
    const cached = deps.store.get(taskId)
    if (cached) {
      if (cached.peerId !== peer) throw new Error(`Task "${taskId}" belongs to peer "${cached.peerId}", not "${peer}"`)
      return cached
    }
    const client = new A2AClient({ baseUrl, headers: peerHeaders(readConfig(deps.config)) })
    const task = await request(peer, () => client.getTask(taskId))
    const tracker = new ConversationTracker({ taskId: task.id })
    tracker.sync(task, speakerOf)
    const conversation: Conversation = {
      peerId: peer,
      client,
      streaming: await supportsStreaming(client),
      contextId: task.contextId,
      tracker,
    }
    deps.store.save(task.id, conversation)
    return conversation
  }
  const client = new A2AClient({ baseUrl, headers: peerHeaders(readConfig(deps.config)) })
  return { peerId: peer, client, streaming: await supportsStreaming(client) }
}

// Self-identify to the peer so its session record can name who is calling.
function peerHeaders(config: A2AConfig): Record<string, string> | undefined {
  return config.name === undefined ? undefined : { [A2A_PEER_HEADER]: config.name }
}

async function pollTurn(
  deps: Deps,
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
  deps: Deps,
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

function outcomeResult(conversation: Conversation, outcome: Outcome, firstTurn: number): ConversationResult {
  const tracker = conversation.tracker
  return {
    peerId: conversation.peerId,
    ...(tracker ? { taskId: tracker.taskId, turn: tracker.history().length } : {}),
    firstTurn,
    ...(outcome.reply === undefined ? {} : { reply: outcome.reply }),
    ...(outcome.artifact === undefined ? {} : { artifact: outcome.artifact }),
    state: outcome.state,
  }
}

function terminalResult(peer: string, conversation: Conversation): ConversationResult {
  const state = conversation.terminal ?? "TASK_STATE_COMPLETED"
  const tracker = conversation.tracker
  return {
    peerId: peer,
    ...(tracker ? { taskId: tracker.taskId } : {}),
    state,
    terminal: true,
  }
}

function capResult(deps: Deps, peer: string, tracker: ConversationTracker): ConversationResult {
  deps.emit("a2a.task.completed", {
    taskId: tracker.taskId,
    peerId: peer,
    state: "TASK_STATE_COMPLETED",
    content: CAP_MESSAGE,
  })
  return {
    peerId: peer,
    taskId: tracker.taskId,
    turn: tracker.history().length,
    state: "TASK_STATE_COMPLETED",
    message: CAP_MESSAGE,
    capped: true,
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
function noteTurn(deps: Deps, conversation: Conversation, message: Message, speaker: Speaker): void {
  const tracker = conversation.tracker
  if (!tracker) {
    // A peer answering with a bare Message may carry no task at all; still
    // emit the turn so the UI thread shows it.
    deps.emit("a2a.conversation.turn", {
      speaker,
      turn: speaker === "local" ? 0 : 1,
      taskId: message.taskId,
      peerId: speaker === "local" ? readConfig(deps.config).name : conversation.peerId,
      content: messageText(message),
    })
    return
  }
  const note = tracker.note(message, speaker)
  if (note.kind === "added") emitTurn(deps, conversation, note.turn)
}

function syncTurns(deps: Deps, conversation: Conversation, task: Task): void {
  const tracker = conversation.tracker
  if (!tracker) return
  for (const note of tracker.sync(task, speakerOf)) {
    if (note.kind === "added") emitTurn(deps, conversation, note.turn)
  }
}

function emitTurn(deps: Deps, conversation: Conversation, turn: Turn): void {
  deps.emit("a2a.conversation.turn", {
    speaker: turn.speaker,
    turn: turn.index,
    taskId: turn.taskId,
    peerId: turn.speaker === "local" ? readConfig(deps.config).name : conversation.peerId,
    content: turn.text,
  })
}

// Terminal states map to their own event types; everything else is a generic
// a2a.task.updated, which also carries TASK_STATE_CANCELED.
function emitTaskState(
  deps: Deps,
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
