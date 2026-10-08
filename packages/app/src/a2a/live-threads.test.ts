import { describe, expect, test } from "bun:test"
import { a2aInlineTaskId, threadDataFromRecord } from "./live-threads"

const completed = (input: Record<string, unknown>, metadata: Record<string, unknown>) => ({
  type: "tool",
  tool: "a2a_ask",
  state: { status: "completed", input, metadata },
})

describe("a2aInlineTaskId", () => {
  test("anchors the initiating call that has no input.taskId", () => {
    expect(a2aInlineTaskId(completed({ peer: "agent-a", message: "hi" }, { peerId: "agent-a", taskId: "t1" }))).toBe(
      "t1",
    )
  })

  test("ignores a continuation that passes input.taskId", () => {
    expect(
      a2aInlineTaskId(
        completed({ peer: "agent-a", message: "again", taskId: "t1" }, { peerId: "agent-a", taskId: "t1" }),
      ),
    ).toBeUndefined()
  })

  test("ignores non-a2a and non-tool parts", () => {
    expect(a2aInlineTaskId({ type: "text" })).toBeUndefined()
    expect(
      a2aInlineTaskId({ type: "tool", tool: "bash", state: { status: "completed", metadata: { taskId: "t1" } } }),
    ).toBeUndefined()
    expect(a2aInlineTaskId(undefined)).toBeUndefined()
  })

  test("ignores unsettled, errored, and metadata-less calls", () => {
    expect(a2aInlineTaskId({ type: "tool", tool: "a2a_ask", state: { status: "running" } })).toBeUndefined()
    expect(a2aInlineTaskId({ type: "tool", tool: "a2a_ask", state: { status: "pending", input: {} } })).toBeUndefined()
    expect(
      a2aInlineTaskId({ type: "tool", tool: "a2a_ask", state: { status: "error", metadata: { taskId: "t1" } } }),
    ).toBeUndefined()
    expect(a2aInlineTaskId(completed({}, {}))).toBeUndefined()
  })

  test("ignores malformed metadata and input", () => {
    expect(a2aInlineTaskId(completed({}, { taskId: "" }))).toBeUndefined()
    expect(a2aInlineTaskId(completed({}, { taskId: 42 }))).toBeUndefined()
    // A stray taskId value (even null) marks a continuation, never the anchor.
    expect(a2aInlineTaskId(completed({ taskId: null }, { taskId: "t1" }))).toBeUndefined()
    expect(a2aInlineTaskId({ type: "tool", tool: "a2a_ask", state: null })).toBeUndefined()
    expect(a2aInlineTaskId({ type: "tool", tool: "a2a_ask", state: "nope" })).toBeUndefined()
  })
})

describe("threadDataFromRecord", () => {
  const record = {
    taskId: "t1",
    direction: "outbound" as const,
    origin: "tool" as const,
    state: "TASK_STATE_COMPLETED" as const,
    turns: 2,
    createdAt: 1,
    updatedAt: 2,
  }

  test("maps persisted history and states into thread data", () => {
    const data = threadDataFromRecord({
      ...record,
      states: ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"],
      history: [
        { speaker: "local", turn: 0, peerId: "agent-b", taskId: "t1", content: "hi" },
        { speaker: "remote", turn: 1, peerId: "agent-a", taskId: "t1", content: "pong" },
      ],
      message: "done",
      artifact: { artifactId: "a1", parts: [{ text: "verdict" }] },
    })
    expect(data.turns).toEqual([
      { index: 0, speaker: "local", peerId: "agent-b", taskId: "t1", text: "hi" },
      { index: 1, speaker: "remote", peerId: "agent-a", taskId: "t1", text: "pong" },
    ])
    expect(data.states).toEqual(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"])
    expect(data.status).toBe("done")
    expect(data.artifact).toEqual({ artifactId: "a1", parts: [{ text: "verdict" }] })
  })

  test("falls back to the last state and normalizes malformed entries", () => {
    const data = threadDataFromRecord({ ...record, history: [{}, { speaker: "bogus", turn: 5, content: "x" }] })
    expect(data.states).toEqual(["TASK_STATE_COMPLETED"])
    expect(data.turns).toEqual([
      { index: 0, speaker: "remote", text: "" },
      { index: 5, speaker: "remote", text: "x" },
    ])
    expect(data.status).toBeUndefined()
    expect(data.artifact).toBeUndefined()
  })

  test("an empty history maps to an empty conversation", () => {
    const data = threadDataFromRecord(record)
    expect(data.turns).toEqual([])
    expect(data.states).toEqual(["TASK_STATE_COMPLETED"])
  })
})
