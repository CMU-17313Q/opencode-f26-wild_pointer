import { describe, expect, test } from "bun:test"
import type { Message, Task, TaskState } from "a2a"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { ConversationStore, createAskTool } from "../src/ask.ts"
import type { Canceller } from "../src/cancel.ts"
import type { A2AConfig } from "../src/config.ts"

const AGENT_CARD = {
  name: "Fake peer",
  description: "Test peer",
  version: "1.0.0",
  supportedInterfaces: [{ url: "http://localhost", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "chat", name: "Chat", description: "Talk", tags: ["chat"] }],
}

type PeerCall = { method: string; params: Record<string, unknown> }

function createPeer(
  options: {
    replies?: string[]
    streaming?: boolean
    silent?: boolean
    state?: TaskState
    states?: TaskState[]
    holdStream?: boolean
  } = {},
) {
  const replies = options.replies ?? ["ok"]
  const calls: PeerCall[] = []
  const history: Message[] = []
  const taskId = "task-1"
  let replyIndex = 0
  let currentState = options.states?.[0] ?? options.state ?? "TASK_STATE_COMPLETED"

  function record(message: Message): Message | undefined {
    history.push(message)
    if (options.silent) return undefined
    const text = replies[Math.min(replyIndex, replies.length - 1)] ?? "ok"
    replyIndex++
    if (options.states) currentState = options.states[Math.min(replyIndex - 1, options.states.length - 1)]
    const agent: Message = {
      messageId: `agent-${history.length}`,
      role: "ROLE_AGENT",
      parts: [{ text }],
      taskId,
    }
    history.push(agent)
    return agent
  }

  function snapshot(): Task {
    const last = history.at(-1)
    return {
      id: taskId,
      status: {
        state: currentState,
        ...(options.silent || !last ? {} : { message: last }),
      },
      contextId: "ctx-1",
      history: [...history],
    }
  }

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/.well-known/agent-card.json")
        return Response.json({ ...AGENT_CARD, capabilities: options.streaming ? { streaming: true } : {} })
      const body = (await request.json()) as { id: unknown; method: string; params?: Record<string, unknown> }
      const params = body.params ?? {}
      calls.push({ method: body.method, params })
      if (body.method === "message/send") {
        record(params.message as Message)
        return Response.json({ jsonrpc: "2.0", id: body.id, result: snapshot() })
      }
      if (body.method === "message/stream") {
        if (options.holdStream) {
          // A peer that accepts the request but never settles its turn: the
          // client buffers SSE, so only an abort/deadline can free the tool.
          return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
        }
        const agent = record(params.message as Message)
        const events = [
          { taskId, contextId: "ctx-1", status: { state: "TASK_STATE_WORKING" } },
          ...(agent ? [agent] : []),
          {
            taskId,
            contextId: "ctx-1",
            status: { state: currentState, ...(agent ? { message: agent } : {}) },
          },
        ]
        const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
        return new Response(payload, { headers: { "content-type": "text/event-stream" } })
      }
      if (body.method === "tasks/get") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: snapshot() })
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } })
    },
  })

  return {
    url: server.url.origin,
    calls,
    stop: () => server.stop(true),
  }
}

function configFor(url: string, overrides: Partial<A2AConfig> = {}): A2AConfig {
  return {
    enabled: true,
    listenPort: 0,
    allowedPeers: { "peer-a": url },
    maxTurns: 4,
    turnTimeoutMs: 120_000,
    ...overrides,
  }
}

function context(signal?: AbortSignal): ToolContext {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: signal ?? new AbortController().signal,
    metadata() {},
    ask: async () => {},
  }
}

function toolFor(input: {
  url: string
  store?: ConversationStore
  cancel?: Canceller
  overrides?: Partial<A2AConfig>
  timeoutMs?: number
  pollMs?: number
}) {
  return createAskTool({
    config: configFor(input.url, input.overrides),
    store: input.store ?? new ConversationStore(),
    cancel: input.cancel,
    timeoutMs: input.timeoutMs,
    pollMs: input.pollMs,
  })
}

async function call(
  toolDef: ReturnType<typeof createAskTool>,
  args: { peer: string; message: string; taskId?: string },
  signal?: AbortSignal,
) {
  const result = await toolDef.execute(args, context(signal))
  if (typeof result === "string") return { title: "", output: result, metadata: undefined }
  return result
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("condition not met in time")
}

describe("a2a_ask", () => {
  test("keeps one task across turns and stops at the cap", async () => {
    const peer = createPeer({
      replies: ["4", "because 2+2 is 4"],
      states: ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_COMPLETED"],
    })
    try {
      const toolDef = createAskTool({ config: configFor(peer.url), store: new ConversationStore() })
      const first = await call(toolDef, { peer: "peer-a", message: "What is 2+2?" })
      expect(first.output).toContain("Task: task-1")
      expect(first.output).toContain("Reply: 4")
      expect(first.metadata?.turn).toBe(2)
      expect(first.metadata?.firstTurn).toBe(0)

      const second = await call(toolDef, { peer: "peer-a", message: "Why?", taskId: "task-1" })
      expect(second.output).toContain("Reply: because 2+2 is 4")
      expect(second.metadata?.turn).toBe(4)
      expect(second.metadata?.firstTurn).toBe(2)

      const sent = peer.calls.filter((entry) => entry.method === "message/send")
      expect(sent.length).toBe(2)
      expect((sent[1].params.message as Message).taskId).toBe("task-1")

      const third = await call(toolDef, { peer: "peer-a", message: "One more?", taskId: "task-1" })
      expect(third.output).toContain("max turns reached without verdict")
      expect(third.metadata?.state).toBe("TASK_STATE_COMPLETED")
      expect(third.metadata?.firstTurn).toBeUndefined()
      expect(peer.calls.filter((entry) => entry.method === "message/send").length).toBe(2)
    } finally {
      peer.stop()
    }
  })

  test("streams when the agent card advertises streaming", async () => {
    const peer = createPeer({ streaming: true, replies: ["streamed reply"] })
    try {
      const toolDef = createAskTool({ config: configFor(peer.url), store: new ConversationStore() })
      const result = await call(toolDef, { peer: "peer-a", message: "hello" })
      expect(result.output).toContain("Reply: streamed reply")
      expect(result.metadata?.state).toBe("TASK_STATE_COMPLETED")
      expect(result.metadata?.taskId).toBe("task-1")
      expect(result.metadata?.firstTurn).toBe(0)
      expect(peer.calls[0]?.method).toBe("message/stream")
    } finally {
      peer.stop()
    }
  })

  test("surfaces a terminal failure on the streaming path", async () => {
    const peer = createPeer({ streaming: true, silent: true, state: "TASK_STATE_FAILED" })
    try {
      const toolDef = createAskTool({ config: configFor(peer.url), store: new ConversationStore() })
      await expect(call(toolDef, { peer: "peer-a", message: "hello" })).rejects.toThrow("TASK_STATE_FAILED")
    } finally {
      peer.stop()
    }
  })

  test("errors when the stream ends without a reply", async () => {
    const peer = createPeer({ streaming: true, silent: true, state: "TASK_STATE_WORKING" })
    try {
      const toolDef = createAskTool({ config: configFor(peer.url), store: new ConversationStore() })
      await expect(call(toolDef, { peer: "peer-a", message: "hello" })).rejects.toThrow(
        "ended the stream without a reply",
      )
    } finally {
      peer.stop()
    }
  })

  test("counts prior turns when resuming a task in a fresh plugin", async () => {
    const peer = createPeer({
      replies: ["4", "because", "third"],
      states: ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_COMPLETED"],
    })
    try {
      const config = configFor(peer.url)
      const first = createAskTool({ config, store: new ConversationStore() })
      await call(first, { peer: "peer-a", message: "What is 2+2?" })
      await call(first, { peer: "peer-a", message: "Why?", taskId: "task-1" })

      const fresh = createAskTool({ config, store: new ConversationStore() })
      const resumed = await call(fresh, { peer: "peer-a", message: "One more?", taskId: "task-1" })
      expect(resumed.output).toContain("max turns reached without verdict")
      expect(peer.calls.filter((entry) => entry.method === "message/send").length).toBe(2)
      expect(peer.calls.filter((entry) => entry.method === "tasks/get").length).toBe(1)
    } finally {
      peer.stop()
    }
  })

  test("rejects peers outside the allowlist without contacting them", async () => {
    const peer = createPeer()
    try {
      const toolDef = createAskTool({ config: configFor(peer.url), store: new ConversationStore() })
      await expect(call(toolDef, { peer: "peer-z", message: "hello" })).rejects.toThrow('Unknown A2A peer "peer-z"')
      expect(peer.calls.length).toBe(0)
    } finally {
      peer.stop()
    }
  })

  test("refuses to reuse a task with a different peer", async () => {
    const peer = createPeer({ replies: ["4"] })
    try {
      const config = configFor(peer.url, { allowedPeers: { "peer-a": peer.url, "peer-b": peer.url } })
      const toolDef = createAskTool({ config, store: new ConversationStore() })
      const first = await call(toolDef, { peer: "peer-a", message: "What is 2+2?" })
      expect(first.metadata?.taskId).toBe("task-1")

      const sends = peer.calls.filter((entry) => entry.method === "message/send").length
      await expect(call(toolDef, { peer: "peer-b", message: "again", taskId: "task-1" })).rejects.toThrow(
        'belongs to peer "peer-a"',
      )
      expect(peer.calls.filter((entry) => entry.method === "message/send").length).toBe(sends)
    } finally {
      peer.stop()
    }
  })

  test("times out when the peer never replies and cancels the remote task", async () => {
    const peer = createPeer({ silent: true, state: "TASK_STATE_WORKING" })
    const canceled: Array<string | undefined> = []
    try {
      const toolDef = toolFor({
        url: peer.url,
        timeoutMs: 150,
        pollMs: 20,
        cancel: async (taskId) => {
          canceled.push(taskId)
        },
      })
      await expect(call(toolDef, { peer: "peer-a", message: "anyone there?" })).rejects.toThrow("Timed out waiting")
      expect(canceled).toEqual(["task-1"])
    } finally {
      peer.stop()
    }
  })

  test("surfaces a terminal failure", async () => {
    const peer = createPeer({ silent: true, state: "TASK_STATE_FAILED" })
    try {
      const toolDef = createAskTool({ config: configFor(peer.url), store: new ConversationStore() })
      await expect(call(toolDef, { peer: "peer-a", message: "hello" })).rejects.toThrow("TASK_STATE_FAILED")
    } finally {
      peer.stop()
    }
  })

  test("rejects an empty message", async () => {
    const peer = createPeer()
    try {
      const toolDef = createAskTool({ config: configFor(peer.url), store: new ConversationStore() })
      await expect(call(toolDef, { peer: "peer-a", message: "   " })).rejects.toThrow("non-empty")
      expect(peer.calls.length).toBe(0)
    } finally {
      peer.stop()
    }
  })

  test("a follow-up on a finished task is answered locally without touching the peer", async () => {
    const peer = createPeer({ replies: ["done"] })
    try {
      const toolDef = toolFor({ url: peer.url })
      const first = await call(toolDef, { peer: "peer-a", message: "go" })
      expect(first.metadata?.state).toBe("TASK_STATE_COMPLETED")

      const callsBefore = peer.calls.length
      const second = await call(toolDef, { peer: "peer-a", message: "again", taskId: "task-1" })
      expect(second.output).toContain("already finished")
      expect(second.metadata?.state).toBe("TASK_STATE_COMPLETED")
      expect(second.metadata?.firstTurn).toBeUndefined()
      expect(peer.calls.length).toBe(callsBefore)
    } finally {
      peer.stop()
    }
  })

  test("aborting the turn cancels the remote task and rejects promptly", async () => {
    const peer = createPeer({ silent: true, state: "TASK_STATE_WORKING" })
    const canceled: Array<string | undefined> = []
    const controller = new AbortController()
    try {
      const toolDef = toolFor({
        url: peer.url,
        timeoutMs: 5_000,
        pollMs: 10,
        cancel: async (taskId) => {
          canceled.push(taskId)
        },
      })
      const running = toolDef.execute({ peer: "peer-a", message: "hello" }, context(controller.signal))
      await waitFor(() => peer.calls.some((entry) => entry.method === "tasks/get"))
      controller.abort()
      await expect(running).rejects.toThrow("a2a_ask aborted")
      expect(canceled).toEqual(["task-1"])
    } finally {
      peer.stop()
    }
  })

  test("abort rejects a buffered stream and cancels a resumable task", async () => {
    const peer = createPeer({ streaming: true, holdStream: true })
    const canceled: Array<string | undefined> = []
    const controller = new AbortController()
    try {
      const toolDef = toolFor({
        url: peer.url,
        timeoutMs: 60_000,
        cancel: async (taskId) => {
          canceled.push(taskId)
        },
      })
      const running = toolDef.execute(
        { peer: "peer-a", message: "again", taskId: "task-1" },
        context(controller.signal),
      )
      await waitFor(() => peer.calls.some((entry) => entry.method === "message/stream"))
      controller.abort()
      await expect(running).rejects.toThrow("a2a_ask aborted")
      expect(canceled).toEqual(["task-1"])
    } finally {
      peer.stop()
    }
  })
})
