import { describe, expect, test } from "bun:test";
import {
  A2AEventTypeSchema,
  A2ATaskEventPropertiesSchema,
  A2ATurnEventPropertiesSchema,
} from "../src/events.ts";

describe("A2A local event contract", () => {
  test("recognizes the five event types the UI renders", () => {
    for (const type of [
      "a2a.task.dispatched",
      "a2a.task.updated",
      "a2a.task.completed",
      "a2a.task.failed",
      "a2a.conversation.turn",
    ]) {
      expect(A2AEventTypeSchema.safeParse(type).success).toBe(true);
    }
    expect(A2AEventTypeSchema.safeParse("a2a.task.cancelled").success).toBe(false);
  });

  test("task events carry taskId and state; turn events carry speaker, turn, content", () => {
    const task = A2ATaskEventPropertiesSchema.parse({
      taskId: "t1",
      peerId: "agent-b",
      state: "TASK_STATE_CANCELED",
    });
    expect(task.state).toBe("TASK_STATE_CANCELED");
    const turn = A2ATurnEventPropertiesSchema.parse({
      speaker: "remote",
      turn: 2,
      taskId: "t1",
      peerId: "agent-b",
      content: "done",
    });
    expect(turn.speaker).toBe("remote");
    expect(A2ATurnEventPropertiesSchema.safeParse({ speaker: "local", turn: 0, content: "" }).success).toBe(
      true,
    );
    expect(A2ATaskEventPropertiesSchema.safeParse({ taskId: "t1" }).success).toBe(false);
  });
});
