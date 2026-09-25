import {
  A2AServer,
  ConversationTracker,
  type AgentCard,
  type Message,
  type Task,
  type TaskState,
  type TaskStatus,
} from "a2a"
import { CAP_MESSAGE, type A2AConfig } from "./config.ts"
import { noopEmitter, type A2AEventEmitter } from "./events.ts"
import type { SessionRunner } from "./session.ts"

// One entry per A2A task id. sessionID lands here after the first successful
// run, the tracker owns dedupe plus the turn count behind the cap, and the
// queue serializes turns so messages arriving mid-run wait their turn.
type InboundState = {
  sessionID?: string
  tracker: ConversationTracker
  queue: Promise<void>
}

// Serves inbound A2A tasks through local opencode sessions: the A2A server
// records work and notifies, this bridge runs it (fire-and-forget, because
// onMessage is synchronous) and writes replies and status transitions back via
// appendMessage/setStatus so open streams and tasks/get observe them.
export function startInboundServer(input: {
  config: A2AConfig
  runner: SessionRunner
  emit?: A2AEventEmitter
}): {
  stop: () => void
  port: number
} {
  const emit = input.emit ?? noopEmitter
  const states = new Map<string, InboundState>()
  let server: A2AServer

  // Every task transition the bridge writes also leaves as an a2a.task.* event
  // so the UI thread view tracks the wire state without polling.
  const notify = (task: Task, status: TaskStatus) => {
    server.setStatus(task.id, status)
    const properties = {
      taskId: task.id,
      peerId: peerOf(task),
      state: status.state,
      ...(status.message ? { content: messageText(status.message) } : {}),
    }
    if (status.state === "TASK_STATE_COMPLETED") emit("a2a.task.completed", properties)
    else if (status.state === "TASK_STATE_FAILED") emit("a2a.task.failed", properties)
    else emit("a2a.task.updated", properties)
  }

  const respond = async (state: InboundState, task: Task, message: Message) => {
    if (settled(task.status.state)) return
    const text = messageText(message).trim()
    if (!text) {
      notify(task, failed("message contained no text"))
      return
    }
    notify(task, { state: "TASK_STATE_WORKING" })
    let run: { sessionID: string; text: string }
    try {
      run = await input.runner.run(task.id, text, peerOf(task))
    } catch (error) {
      if (!settled(task.status.state)) notify(task, failed(reason(error)))
      return
    }
    // A cancel may have settled the task while the session ran; never write a
    // late reply onto a settled task.
    if (settled(task.status.state)) return
    state.sessionID = run.sessionID
    const reply: Message = {
      messageId: crypto.randomUUID(),
      role: "ROLE_AGENT",
      parts: [{ text: run.text }],
    }
    server.appendMessage(task.id, reply)
    const note = state.tracker.note(reply, "local")
    if (note.kind === "added")
      emit("a2a.conversation.turn", {
        speaker: "local",
        turn: note.turn.index,
        taskId: task.id,
        peerId: input.config.name,
        content: note.turn.text,
      })
    // Multi-turn needs INPUT_REQUIRED between turns: a COMPLETED task rejects
    // follow-ups with -32602. Only the cap closes the conversation.
    if (state.tracker.history().length >= input.config.maxTurns)
      notify(task, {
        state: "TASK_STATE_COMPLETED",
        message: { messageId: crypto.randomUUID(), role: "ROLE_AGENT", parts: [{ text: CAP_MESSAGE }] },
      })
    else notify(task, { state: "TASK_STATE_INPUT_REQUIRED" })
  }

  const onMessage = (task: Task, message: Message) => {
    const known = states.has(task.id)
    const state: InboundState = states.get(task.id) ?? {
      tracker: new ConversationTracker({ taskId: task.id }),
      queue: Promise.resolve(),
    }
    states.set(task.id, state)
    if (!known) emit("a2a.task.dispatched", { taskId: task.id, peerId: peerOf(task), state: task.status.state })
    const note = state.tracker.note(message, "remote")
    if (note.kind === "added")
      emit("a2a.conversation.turn", {
        speaker: "remote",
        turn: note.turn.index,
        taskId: task.id,
        peerId: peerOf(task),
        content: note.turn.text,
      })
    if (note.kind === "duplicate") {
      // The server recorded the duplicate and reset an INPUT_REQUIRED task to
      // SUBMITTED; put it back so the retried delivery sees the same settled
      // turn without re-running the session or appending the reply twice.
      if (task.status.state === "TASK_STATE_SUBMITTED") notify(task, { state: "TASK_STATE_INPUT_REQUIRED" })
      return
    }
    state.queue = state.queue.then(() => respond(state, task, message))
  }

  server = new A2AServer({
    // Deferred so the card reports the port Bun.serve actually bound (0 asks
    // for an ephemeral port, which peers only learn from the card).
    card: () => cardFor(port),
    onMessage,
    onCancel: (task) => {
      // The server already transitioned the task; echo it so CANCELED reaches
      // the UI stream like every other state change.
      emit("a2a.task.updated", { taskId: task.id, peerId: peerOf(task), state: "TASK_STATE_CANCELED" })
      return input.runner.abort(task.id)
    },
  })
  // The socket address is the identity fallback when the peer does not send
  // the x-a2a-peer header; the server prefers the header when present.
  const listener = Bun.serve({
    port: input.config.listenPort,
    fetch: (request, self) => server.fetch(request, self.requestIP(request)?.address),
  })
  const port = listener.port ?? input.config.listenPort
  return { stop: () => listener.stop(true), port }
}

function cardFor(port: number): AgentCard {
  return {
    name: "opencode",
    description: "Hold a multi-turn conversation with a local opencode agent",
    version: "1.0.0",
    supportedInterfaces: [{ url: `http://localhost:${port}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "chat",
        name: "Chat",
        description: "Answer questions and continue a task-scoped conversation",
        tags: ["chat"],
      },
    ],
  }
}

// Terminal states only. A settled task must never be resurrected by a queued
// message, a late reply, or a failing run.
function settled(state: TaskState): boolean {
  return (
    state === "TASK_STATE_COMPLETED" ||
    state === "TASK_STATE_FAILED" ||
    state === "TASK_STATE_CANCELED" ||
    state === "TASK_STATE_REJECTED"
  )
}

function failed(text: string): TaskStatus {
  return {
    state: "TASK_STATE_FAILED",
    message: { messageId: crypto.randomUUID(), role: "ROLE_AGENT", parts: [{ text }] },
  }
}

function messageText(message: Message): string {
  return message.parts.map((part) => part.text).join("\n")
}

function peerOf(task: Task): string | undefined {
  const peer = task.metadata?.peerId
  return typeof peer === "string" ? peer : undefined
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
