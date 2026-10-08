import { describe, expect, test } from "bun:test"
import { a2aVerdictText, type A2AThreadData } from "./a2a-thread"

const base: A2AThreadData = { taskId: "t1", turns: [], states: ["TASK_STATE_COMPLETED"] }

describe("a2aVerdictText", () => {
  test("joins artifact parts for a completed task", () => {
    const data: A2AThreadData = {
      ...base,
      states: ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"],
      artifact: { artifactId: "a1", parts: [{ text: "line one" }, { text: "line two" }] },
    }
    expect(a2aVerdictText(data)).toBe("line one line two")
  })

  test("is absent without an artifact or before completion", () => {
    expect(a2aVerdictText(base)).toBeUndefined()
    expect(
      a2aVerdictText({
        ...base,
        states: ["TASK_STATE_WORKING"],
        artifact: { artifactId: "a1", parts: [{ text: "x" }] },
      }),
    ).toBeUndefined()
  })
})
