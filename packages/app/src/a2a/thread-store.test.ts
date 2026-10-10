import { describe, expect, test } from "bun:test"
import { applyA2AEvent, emptyThread, threadFor, type A2AThreads } from "./thread-store"

const dispatch = {
  taskId: "t1",
  peerId: "agent-a",
  state: "TASK_STATE_SUBMITTED",
}

const turn = (index: number, speaker: "local" | "remote", content: string) => ({
  speaker,
  turn: index,
  taskId: "t1",
  peerId: speaker === "local" ? "agent-b" : "agent-a",
  content,
})

describe("applyA2AEvent", () => {
  test("dispatched starts a task with its first state and status", () => {
    const threads = applyA2AEvent({}, "a2a.task.dispatched", { ...dispatch, content: "starting" })
    expect(threads.t1).toEqual({
      taskId: "t1",
      turns: [],
      states: ["TASK_STATE_SUBMITTED"],
      artifact: undefined,
      status: "starting",
    })
  })

  test("only appends a state when it differs from the last", () => {
    let threads: A2AThreads = applyA2AEvent({}, "a2a.task.dispatched", dispatch)
    threads = applyA2AEvent(threads, "a2a.task.updated", { ...dispatch, state: "TASK_STATE_WORKING" })
    threads = applyA2AEvent(threads, "a2a.task.updated", { ...dispatch, state: "TASK_STATE_WORKING" })
    threads = applyA2AEvent(threads, "a2a.task.completed", { ...dispatch, state: "TASK_STATE_COMPLETED" })
    expect(threadFor(threads, "t1").states).toEqual([
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_COMPLETED",
    ])
  })

  test("attaches a verdict artifact and status message", () => {
    let threads = applyA2AEvent({}, "a2a.task.dispatched", dispatch)
    threads = applyA2AEvent(threads, "a2a.task.completed", {
      ...dispatch,
      state: "TASK_STATE_COMPLETED",
      content: "done",
      artifact: { artifactId: "a1", parts: [{ text: "verdict" }] },
    })
    const thread = threadFor(threads, "t1")
    expect(thread.status).toBe("done")
    expect(thread.artifact?.parts[0]?.text).toBe("verdict")
  })

  test("appends turns in arrival order with their index and speaker", () => {
    let threads = applyA2AEvent({}, "a2a.task.dispatched", dispatch)
    threads = applyA2AEvent(threads, "a2a.conversation.turn", turn(0, "local", "hello"))
    threads = applyA2AEvent(threads, "a2a.conversation.turn", turn(1, "remote", "hi back"))
    const thread = threadFor(threads, "t1")
    expect(thread.turns.map((t) => ({ index: t.index, speaker: t.speaker, text: t.text }))).toEqual([
      { index: 0, speaker: "local", text: "hello" },
      { index: 1, speaker: "remote", text: "hi back" },
    ])
  })

  test("creates an entry for a task never seen dispatched", () => {
    const threads = applyA2AEvent({}, "a2a.task.updated", { ...dispatch, state: "TASK_STATE_WORKING" })
    expect(threadFor(threads, "t1").states).toEqual(["TASK_STATE_WORKING"])
  })

  test("keeps captured turns across a late dispatch", () => {
    let threads = applyA2AEvent({}, "a2a.conversation.turn", turn(0, "local", "hello"))
    threads = applyA2AEvent(threads, "a2a.task.dispatched", dispatch)
    expect(threadFor(threads, "t1").turns).toHaveLength(1)
    expect(threadFor(threads, "t1").states).toEqual(["TASK_STATE_SUBMITTED"])
  })

  test("ignores unrelated, malformed, and taskless events", () => {
    expect(applyA2AEvent({}, "session.updated", { taskId: "t1" })).toEqual({})
    expect(applyA2AEvent({}, "a2a.task.updated", { nope: true })).toEqual({})
    expect(applyA2AEvent({}, "a2a.conversation.turn", { speaker: "local", turn: 0, content: "hello" })).toEqual({})
  })

  test("threadFor returns an empty thread for an unknown task", () => {
    expect(threadFor({}, "missing")).toEqual(emptyThread("missing"))
  })
})
