import { describe, expect, test } from "bun:test"
import type { TaskState } from "a2a"
import { a2aInlineAsk, a2aSegmentFrom, sliceLiveThread, threadDataFromRecord } from "./live-threads"
import type { A2AThreadData } from "./thread-store"

const completed = (input: Record<string, unknown>, metadata: Record<string, unknown>) => ({
  type: "tool",
  tool: "a2a_ask",
  state: { status: "completed", input, metadata },
})

describe("a2aInlineAsk", () => {
  test("anchors the initiating call at turn 0", () => {
    expect(a2aInlineAsk(completed({ peer: "agent-a", message: "hi" }, { peerId: "agent-a", taskId: "t1" }))).toEqual({
      taskId: "t1",
      firstTurn: 0,
    })
    expect(a2aInlineAsk(completed({}, { taskId: "t1", firstTurn: 0 }))).toEqual({ taskId: "t1", firstTurn: 0 })
  })

  test("anchors a continuation at its stamped first turn", () => {
    expect(
      a2aInlineAsk(
        completed(
          { peer: "agent-a", message: "again", taskId: "t1" },
          { peerId: "agent-a", taskId: "t1", firstTurn: 2 },
        ),
      ),
    ).toEqual({ taskId: "t1", firstTurn: 2 })
  })

  test("ignores a legacy continuation with no stamped first turn", () => {
    expect(a2aInlineAsk(completed({ peer: "agent-a", message: "again", taskId: "t1" }, { taskId: "t1" }))).toBeUndefined()
  })

  test("ignores non-a2a and non-tool parts", () => {
    expect(a2aInlineAsk({ type: "text" })).toBeUndefined()
    expect(
      a2aInlineAsk({ type: "tool", tool: "bash", state: { status: "completed", metadata: { taskId: "t1" } } }),
    ).toBeUndefined()
    expect(a2aInlineAsk(undefined)).toBeUndefined()
  })

  test("ignores unsettled, errored, and metadata-less calls", () => {
    expect(a2aInlineAsk({ type: "tool", tool: "a2a_ask", state: { status: "running" } })).toBeUndefined()
    expect(a2aInlineAsk({ type: "tool", tool: "a2a_ask", state: { status: "pending", input: {} } })).toBeUndefined()
    expect(
      a2aInlineAsk({ type: "tool", tool: "a2a_ask", state: { status: "error", metadata: { taskId: "t1" } } }),
    ).toBeUndefined()
    expect(a2aInlineAsk(completed({}, {}))).toBeUndefined()
  })

  test("ignores malformed metadata and input", () => {
    expect(a2aInlineAsk(completed({}, { taskId: "" }))).toBeUndefined()
    expect(a2aInlineAsk(completed({}, { taskId: 42 }))).toBeUndefined()
    // A non-string input taskId is not a continuation marker; the call anchors
    // as the initiator via its metadata.
    expect(a2aInlineAsk(completed({ taskId: null }, { taskId: "t1" }))).toEqual({ taskId: "t1", firstTurn: 0 })
    expect(a2aInlineAsk({ type: "tool", tool: "a2a_ask", state: null })).toBeUndefined()
    expect(a2aInlineAsk({ type: "tool", tool: "a2a_ask", state: "nope" })).toBeUndefined()
  })
})

describe("a2aSegmentFrom", () => {
  test("derives the exclusive end and segment index from sibling anchors", () => {
    expect(a2aSegmentFrom([0, 2], 0)).toEqual({ firstTurn: 0, next: 2, index: 0 })
    expect(a2aSegmentFrom([0, 2], 2)).toEqual({ firstTurn: 2, index: 1 })
    expect(a2aSegmentFrom([4, 0, 2], 2)).toEqual({ firstTurn: 2, next: 4, index: 1 })
    expect(a2aSegmentFrom(undefined, 0)).toEqual({ firstTurn: 0, index: 0 })
    expect(a2aSegmentFrom([0], 7)).toEqual({ firstTurn: 7, index: 0 })
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

  const fullRecord = {
    ...record,
    turns: 4,
    states: [
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_COMPLETED",
    ],
    history: [
      { speaker: "local", turn: 0, peerId: "agent-b", taskId: "t1", content: "first ask" },
      { speaker: "remote", turn: 1, peerId: "agent-a", taskId: "t1", content: "first reply" },
      { speaker: "local", turn: 2, peerId: "agent-b", taskId: "t1", content: "follow up" },
      { speaker: "remote", turn: 3, peerId: "agent-a", taskId: "t1", content: "second reply" },
    ],
    message: "max turns reached without verdict",
    artifact: { artifactId: "a1", parts: [{ text: "verdict" }] },
  }

  test("a segment keeps only its own turns and states; the verdict stays with the last one", () => {
    const first = threadDataFromRecord(fullRecord, { firstTurn: 0, next: 2, index: 0 })
    expect(first.turns.map((turn) => turn.text)).toEqual(["first ask", "first reply"])
    expect(first.states).toEqual(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_INPUT_REQUIRED"])
    expect(first.status).toBeUndefined()
    expect(first.artifact).toBeUndefined()

    const second = threadDataFromRecord(fullRecord, { firstTurn: 2, index: 1 })
    expect(second.turns.map((turn) => turn.text)).toEqual(["follow up", "second reply"])
    expect(second.states).toEqual(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"])
    expect(second.status).toBe("max turns reached without verdict")
    expect(second.artifact).toEqual({ artifactId: "a1", parts: [{ text: "verdict" }] })
  })

  test("a segment whose chain cannot be sliced falls back to the whole chain", () => {
    const data = threadDataFromRecord({ ...record, states: ["TASK_STATE_COMPLETED"] }, { firstTurn: 0, index: 1 })
    expect(data.states).toEqual(["TASK_STATE_COMPLETED"])
  })
})

describe("sliceLiveThread", () => {
  const thread: A2AThreadData = {
    taskId: "t1",
    turns: [
      { index: 0, speaker: "local", text: "a" },
      { index: 1, speaker: "remote", text: "b" },
      { index: 2, speaker: "local", text: "c" },
      { index: 3, speaker: "remote", text: "d" },
    ],
    states: ["TASK_STATE_COMPLETED" as TaskState],
  }

  test("filters live turns to the segment's range", () => {
    expect(sliceLiveThread(thread, { firstTurn: 2, index: 1 }).turns.map((turn) => turn.index)).toEqual([2, 3])
    expect(sliceLiveThread(thread, { firstTurn: 0, next: 2, index: 0 }).turns.map((turn) => turn.index)).toEqual([0, 1])
    expect(sliceLiveThread(thread, undefined)).toBe(thread)
  })
})
