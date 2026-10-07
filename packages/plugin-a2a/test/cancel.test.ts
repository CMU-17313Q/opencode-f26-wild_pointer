import { describe, expect, test } from "bun:test"
import { A2AClient, type Task } from "a2a"
import { ConversationStore } from "../src/ask.ts"
import { createCanceller } from "../src/cancel.ts"
import { eventLog } from "./bridge.ts"

function stubClient(calls: string[], fail = false): A2AClient {
  return {
    cancelTask: async (id: string) => {
      calls.push(id)
      if (fail) throw new Error("peer unreachable")
      return { id, status: { state: "TASK_STATE_CANCELED" } } as Task
    },
  } as unknown as A2AClient
}

describe("cancel coordinator", () => {
  test("cancels the remote conversation and emits one CANCELED event", async () => {
    const log = eventLog()
    const calls: string[] = []
    const store = new ConversationStore()
    store.save("task-1", { peerId: "peer-a", client: stubClient(calls), streaming: false })
    const cancel = createCanceller({ store, emit: log.emit })

    await cancel("task-1", "canceled by user")

    expect(calls).toEqual(["task-1"])
    expect(store.get("task-1")?.terminal).toBe("TASK_STATE_CANCELED")
    expect(log.events).toEqual([
      {
        type: "a2a.task.updated",
        properties: {
          taskId: "task-1",
          state: "TASK_STATE_CANCELED",
          content: "canceled by user",
          peerId: "peer-a",
        },
      },
    ])
  })

  test("is idempotent for the same task", async () => {
    const log = eventLog()
    const calls: string[] = []
    const store = new ConversationStore()
    store.save("task-1", { peerId: "peer-a", client: stubClient(calls), streaming: false })
    const cancel = createCanceller({ store, emit: log.emit })

    await cancel("task-1")
    await cancel("task-1")

    expect(calls).toEqual(["task-1"])
    expect(log.events.length).toBe(1)
  })

  test("treats an unreachable peer as canceled anyway", async () => {
    const log = eventLog()
    const store = new ConversationStore()
    store.save("task-1", { peerId: "peer-a", client: stubClient([], true), streaming: false })
    const cancel = createCanceller({ store, emit: log.emit })

    await cancel("task-1")

    expect(log.events.length).toBe(1)
    expect(store.get("task-1")?.terminal).toBe("TASK_STATE_CANCELED")
  })

  test("a local cancel is trusted to emit its own event", async () => {
    const log = eventLog()
    const local: string[] = []
    const cancel = createCanceller({
      store: new ConversationStore(),
      emit: log.emit,
      local: () => async (taskId) => {
        local.push(taskId)
        return true
      },
    })

    await cancel("task-2")

    expect(local).toEqual(["task-2"])
    expect(log.events).toEqual([])
  })

  test("emits a defensive event when neither side knows the task", async () => {
    const log = eventLog()
    const cancel = createCanceller({
      store: new ConversationStore(),
      emit: log.emit,
      local: () => async () => false,
    })

    await cancel("task-3")

    expect(log.events).toEqual([
      { type: "a2a.task.updated", properties: { taskId: "task-3", state: "TASK_STATE_CANCELED" } },
    ])
  })

  test("ignores a missing task id", async () => {
    const log = eventLog()
    const cancel = createCanceller({ store: new ConversationStore(), emit: log.emit })

    await cancel(undefined)
    await cancel("")

    expect(log.events).toEqual([])
  })
})
