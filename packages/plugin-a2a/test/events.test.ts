// A2A-008: the plugin emits one a2a.conversation.turn per message on either
// side plus a2a.task.* lifecycle events, so the UI can render the full thread
// from events alone.
import { describe, expect, test } from "bun:test"
import { GlobalBus } from "opencode/bus/global"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { ConversationStore, createAskTool } from "../src/ask.ts"
import { createEventEmitter } from "../src/events.ts"
import type { A2AConfig } from "../src/config.ts"
import {
  agentReplies,
  awaitState,
  configFor,
  eventLog,
  fakeRunner,
  send,
  startBridge,
  userMessage,
  type EmittedEvent,
} from "./bridge.ts"

function context(): ToolContext {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  }
}

function types(events: EmittedEvent[]): string[] {
  return events.map((event) => event.type)
}

async function call(
  toolDef: ReturnType<typeof createAskTool>,
  args: { peer: string; message: string; taskId?: string },
) {
  const result = await toolDef.execute(args, context())
  if (typeof result === "string") return { title: "", output: result, metadata: undefined }
  return result
}

describe("inbound a2a events", () => {
  test("dispatched, turns, and status events fire for a full exchange", async () => {
    const log = eventLog()
    const bridge = startBridge(fakeRunner({ replies: ["pong"] }).runner, undefined, log.emit)
    try {
      const task = await send(bridge.client, userMessage("ping"))
      await awaitState(bridge.client, task.id, "TASK_STATE_INPUT_REQUIRED")

      expect(types(log.events)).toEqual([
        "a2a.task.dispatched",
        "a2a.conversation.turn",
        "a2a.task.updated",
        "a2a.conversation.turn",
        "a2a.task.updated",
      ])
      const [dispatched, incoming, working, reply, waiting] = log.events
      expect(dispatched.properties).toMatchObject({ taskId: task.id, state: "TASK_STATE_SUBMITTED" })
      expect(incoming.properties).toMatchObject({ speaker: "remote", turn: 0, taskId: task.id, content: "ping" })
      expect(typeof incoming.properties.peerId).toBe("string")
      expect(working.properties).toMatchObject({ taskId: task.id, state: "TASK_STATE_WORKING" })
      expect(reply.properties).toMatchObject({ speaker: "local", turn: 1, taskId: task.id, content: "pong" })
      expect(waiting.properties).toMatchObject({ taskId: task.id, state: "TASK_STATE_INPUT_REQUIRED" })
    } finally {
      bridge.stop()
    }
  })

  test("turn numbering continues and the cap emits task.completed", async () => {
    const log = eventLog()
    const bridge = startBridge(fakeRunner({ replies: ["one", "two"] }).runner, { maxTurns: 4 }, log.emit)
    try {
      const task = await send(bridge.client, userMessage("first"))
      await awaitState(bridge.client, task.id, "TASK_STATE_INPUT_REQUIRED")
      await send(bridge.client, userMessage("second", { taskId: task.id }))
      const done = await awaitState(bridge.client, task.id, "TASK_STATE_COMPLETED")
      expect(agentReplies(done)).toEqual(["one", "two"])

      const turns = log.events.filter((event) => event.type === "a2a.conversation.turn")
      expect(turns.map((event) => [event.properties.speaker, event.properties.turn])).toEqual([
        ["remote", 0],
        ["local", 1],
        ["remote", 2],
        ["local", 3],
      ])
      const completed = log.events.find((event) => event.type === "a2a.task.completed")
      expect(completed?.properties).toMatchObject({ taskId: task.id, state: "TASK_STATE_COMPLETED" })
    } finally {
      bridge.stop()
    }
  })

  test("cancel emits a2a.task.updated with TASK_STATE_CANCELED", async () => {
    const log = eventLog()
    const bridge = startBridge(fakeRunner({ gate: new Promise(() => {}) }).runner, undefined, log.emit)
    try {
      const task = await send(bridge.client, userMessage("work"))
      await awaitState(bridge.client, task.id, "TASK_STATE_WORKING")
      await bridge.client.cancelTask(task.id)
      const canceled = log.events.find(
        (event) => event.type === "a2a.task.updated" && event.properties.state === "TASK_STATE_CANCELED",
      )
      expect(canceled?.properties.taskId).toBe(task.id)
    } finally {
      bridge.stop()
    }
  })

  test("a failed run emits a2a.task.failed with the reason", async () => {
    const log = eventLog()
    const bridge = startBridge(fakeRunner({ error: "model exploded" }).runner, undefined, log.emit)
    try {
      const task = await send(bridge.client, userMessage("boom"))
      await awaitState(bridge.client, task.id, "TASK_STATE_FAILED")
      const failed = log.events.find((event) => event.type === "a2a.task.failed")
      expect(failed?.properties).toMatchObject({ taskId: task.id, state: "TASK_STATE_FAILED" })
      expect(failed?.properties.content).toContain("model exploded")
    } finally {
      bridge.stop()
    }
  })
})

describe("outbound a2a events", () => {
  test("a2a_ask emits dispatched, both turn sides, and terminal status", async () => {
    const log = eventLog()
    const bridge = startBridge(fakeRunner({ replies: ["pong"] }).runner, undefined, eventLog().emit)
    try {
      const config: A2AConfig = { ...configFor(), allowedPeers: { "agent-b": bridge.baseUrl } }
      const toolDef = createAskTool({ config, store: new ConversationStore(), emit: log.emit })
      const result = await call(toolDef, { peer: "agent-b", message: "ping" })
      expect(result.output).toContain("Reply: pong")

      const taskId = String(result.metadata?.taskId)
      const dispatched = log.events.find((event) => event.type === "a2a.task.dispatched")
      expect(dispatched?.properties).toMatchObject({ taskId, peerId: "agent-b" })
      const turns = log.events.filter((event) => event.type === "a2a.conversation.turn")
      expect(turns.map((event) => [event.properties.speaker, event.properties.turn])).toEqual([
        ["local", 0],
        ["remote", 1],
      ])
      expect(turns[0]?.properties.content).toBe("ping")
      expect(turns[1]?.properties.content).toBe("pong")
      expect(
        log.events.some(
          (event) =>
            (event.type === "a2a.task.updated" || event.type === "a2a.task.completed") &&
            event.properties.state === "TASK_STATE_INPUT_REQUIRED",
        ),
      ).toBe(true)
    } finally {
      bridge.stop()
    }
  })
})

describe("createEventEmitter", () => {
  test("publishes a2a.* events onto the opencode global bus", () => {
    const seen: Array<{ type?: string; properties?: unknown }> = []
    const listener = (event: { payload: { type?: string; properties?: unknown } }) => {
      if (event.payload.type?.startsWith("a2a.")) seen.push(event.payload)
    }
    GlobalBus.on("event", listener)
    try {
      const emit = createEventEmitter("/dir")
      emit("a2a.task.updated", { taskId: "t1", state: "TASK_STATE_WORKING" })
      emit("a2a.conversation.turn", { speaker: "local", turn: 0, taskId: "t1", content: "hi" })
      expect(seen.map((event) => event.type)).toEqual(["a2a.task.updated", "a2a.conversation.turn"])
    } finally {
      GlobalBus.off("event", listener)
    }
  })
})
