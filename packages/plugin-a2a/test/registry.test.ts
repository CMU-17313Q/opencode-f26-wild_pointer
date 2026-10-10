// A2A-014: the session registry records every task in both directions through
// the same emitters that publish a2a.* events, persists the last 50 by
// updatedAt, and settles tasks a dead process left running.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { A2AEventEmitter } from "../src/events.ts"
import { createConversationCore, ConversationStore } from "../src/conversation.ts"
import { createConversationRegistry } from "../src/registry.ts"
import { awaitState, configFor, fakeRunner, send, startBridge, userMessage } from "./bridge.ts"

function tempDir() {
  return mkdtempSync(join(tmpdir(), "a2a-registry-"))
}

function outboundEmitter(registry: ReturnType<typeof createConversationRegistry>) {
  const events: string[] = []
  const base: A2AEventEmitter = (type) => {
    events.push(type)
  }
  const emit = registry.attach(base, { direction: "outbound", origin: "tool", peerId: "agent-b" })
  return { emit, events }
}

describe("session registry", () => {
  test("an outbound exchange records peer, direction, origin, state, turns, and session", async () => {
    const dir = tempDir()
    const fake = fakeRunner({ replies: ["pong"] })
    const bridge = startBridge(fake.runner)
    try {
      const registry = createConversationRegistry({ file: join(dir, "sessions.json") })
      const config = { ...configFor(), allowedPeers: { "agent-b": bridge.baseUrl } }
      const core = createConversationCore({ config, store: new ConversationStore(), registry })
      const result = await core.startConversation("agent-b", "ping", { origin: "tool", sessionId: "ses_caller" })
      await registry.flush()

      expect(registry.get(String(result.taskId))).toMatchObject({
        direction: "outbound",
        origin: "tool",
        peerId: "agent-b",
        state: "TASK_STATE_INPUT_REQUIRED",
        turns: 2,
        sessionId: "ses_caller",
      })
    } finally {
      bridge.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an inbound exchange records peer, direction, origin, state, and the runner session", async () => {
    const dir = tempDir()
    const registry = createConversationRegistry({ file: join(dir, "sessions.json") })
    const fake = fakeRunner({ replies: ["pong"] })
    const bridge = startBridge(fake.runner, { name: "ours" }, undefined, registry)
    try {
      const task = await send(bridge.client, userMessage("ping"))
      await awaitState(bridge.client, task.id, "TASK_STATE_INPUT_REQUIRED")
      await registry.flush()

      const record = registry.get(task.id)
      expect(record).toMatchObject({
        direction: "inbound",
        origin: "peer",
        state: "TASK_STATE_INPUT_REQUIRED",
        turns: 2,
        sessionId: `ses_${task.id}`,
      })
      expect(typeof record?.peerId).toBe("string")
    } finally {
      bridge.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("persists records and reloads them", async () => {
    const dir = tempDir()
    const file = join(dir, "sessions.json")
    const first = createConversationRegistry({ file })
    const { emit } = outboundEmitter(first)
    emit("a2a.task.dispatched", { taskId: "t1", peerId: "agent-b", state: "TASK_STATE_COMPLETED" })
    emit("a2a.conversation.turn", { speaker: "local", turn: 0, taskId: "t1", content: "hi" })
    await first.flush()

    const second = createConversationRegistry({ file })
    await second.load()
    expect(second.get("t1")).toMatchObject({
      taskId: "t1",
      direction: "outbound",
      peerId: "agent-b",
      state: "TASK_STATE_COMPLETED",
      turns: 1,
    })
    rmSync(dir, { recursive: true, force: true })
  })

  test("settles a stored WORKING task as failed on load", async () => {
    const dir = tempDir()
    const file = join(dir, "sessions.json")
    const first = createConversationRegistry({ file })
    const { emit } = outboundEmitter(first)
    emit("a2a.task.dispatched", { taskId: "t1", peerId: "agent-b", state: "TASK_STATE_WORKING" })
    await first.flush()

    const second = createConversationRegistry({ file })
    await second.load()
    await second.flush()
    expect(second.get("t1")).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: "host restarted",
    })
    rmSync(dir, { recursive: true, force: true })
  })

  test("prunes to the last 50 by updatedAt", async () => {
    const dir = tempDir()
    let clock = 1_000
    const registry = createConversationRegistry({ file: join(dir, "sessions.json"), now: () => clock++ })
    const { emit } = outboundEmitter(registry)
    for (let index = 0; index < 55; index++) {
      emit("a2a.task.dispatched", { taskId: `t${index}`, peerId: "agent-b", state: "TASK_STATE_WORKING" })
    }
    await registry.flush()

    const records = registry.list()
    expect(records).toHaveLength(50)
    expect(records.find((record) => record.taskId === "t0")).toBeUndefined()
    expect(records.find((record) => record.taskId === "t54")).toBeDefined()
    rmSync(dir, { recursive: true, force: true })
  })

  test("records the conversation history and state chain", async () => {
    const dir = tempDir()
    const registry = createConversationRegistry({ file: join(dir, "sessions.json") })
    const { emit } = outboundEmitter(registry)
    emit("a2a.task.dispatched", { taskId: "t1", peerId: "agent-b", state: "TASK_STATE_SUBMITTED" })
    emit("a2a.task.updated", { taskId: "t1", peerId: "agent-b", state: "TASK_STATE_WORKING" })
    emit("a2a.conversation.turn", { speaker: "local", turn: 0, taskId: "t1", peerId: "agent-b", content: "hi" })
    emit("a2a.conversation.turn", { speaker: "remote", turn: 1, taskId: "t1", peerId: "agent-a", content: "pong" })
    emit("a2a.task.completed", {
      taskId: "t1",
      peerId: "agent-a",
      state: "TASK_STATE_COMPLETED",
      artifact: { artifactId: "a1", parts: [{ text: "done" }] },
    })
    await registry.flush()

    const record = registry.get("t1")
    expect(record?.states).toEqual(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"])
    expect(record?.history).toEqual([
      { speaker: "local", turn: 0, taskId: "t1", peerId: "agent-b", content: "hi" },
      { speaker: "remote", turn: 1, taskId: "t1", peerId: "agent-a", content: "pong" },
    ])
    expect(record?.artifact).toEqual({ artifactId: "a1", parts: [{ text: "done" }] })
    rmSync(dir, { recursive: true, force: true })
  })

  test("history and states survive a reload", async () => {
    const dir = tempDir()
    const file = join(dir, "sessions.json")
    const first = createConversationRegistry({ file })
    const { emit } = outboundEmitter(first)
    emit("a2a.task.dispatched", { taskId: "t1", peerId: "agent-b", state: "TASK_STATE_WORKING" })
    emit("a2a.conversation.turn", { speaker: "local", turn: 0, taskId: "t1", content: "hi" })
    await first.flush()

    const second = createConversationRegistry({ file })
    await second.load()
    const record = second.get("t1")
    expect(record?.history).toHaveLength(1)
    expect(record?.history?.[0]).toMatchObject({ speaker: "local", turn: 0, content: "hi" })
    // The dead-process settlement lands in the state chain too.
    expect(record?.states).toEqual(["TASK_STATE_WORKING", "TASK_STATE_FAILED"])
    rmSync(dir, { recursive: true, force: true })
  })
})
