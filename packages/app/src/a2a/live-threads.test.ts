import { describe, expect, test } from "bun:test"
import { a2aInlineTaskId } from "./live-threads"

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
