import { describe, expect, test } from "bun:test";
import { A2AClient, type FetchFn } from "../src/client.ts";
import { ConversationTracker, conversationOutcome } from "../src/tracker.ts";
import type { Message, Task } from "../src/types.ts";

const debate = { maxTurns: 4, capMessage: "max turns reached without verdict" };
const chat = { maxTurns: 4, capMessage: "max turns reached" };

function makeMessage(id: string, text = "hello"): Message {
  return { messageId: id, role: "ROLE_USER", parts: [{ text }] };
}

function historyTask(ids: string[]): Task {
  return {
    id: "task-123",
    status: { state: "TASK_STATE_WORKING" },
    history: ids.map((id) => makeMessage(id)),
  };
}

describe("note", () => {
  test("appends turns with index, speaker, and task linkage", () => {
    const tracker = new ConversationTracker({ taskId: "task-123", peerId: "Agent B" });
    tracker.note(makeMessage("m0"), "local");
    tracker.note(makeMessage("m1"), "remote");
    tracker.note(makeMessage("m2"), "local");
    const history = tracker.history();
    expect(history.map((turn) => turn.index)).toEqual([0, 1, 2]);
    expect(history.map((turn) => turn.speaker)).toEqual(["local", "remote", "local"]);
    expect(history.map((turn) => turn.taskId)).toEqual(["task-123", "task-123", "task-123"]);
    expect(history.map((turn) => turn.messageId)).toEqual(["m0", "m1", "m2"]);
    expect(history.map((turn) => turn.peerId)).toEqual(["Agent B", "Agent B", "Agent B"]);
  });

  test("duplicate messageId returns the existing turn without appending", () => {
    const tracker = new ConversationTracker({ taskId: "task-123" });
    const first = tracker.note(makeMessage("m0"), "local");
    const second = tracker.note(makeMessage("m0", "different text"), "remote");
    expect(second.kind).toBe("duplicate");
    if (first.kind === "added" && second.kind === "duplicate") {
      expect(second.turn).toBe(first.turn);
      expect(second.turn.text).toBe("hello");
    }
    expect(tracker.history().length).toBe(1);
  });

  test("sync appends every unseen message without refusing", () => {
    const tracker = new ConversationTracker({ taskId: "task-123" });
    const results = tracker.sync(historyTask(["m0", "m1", "m2", "m3", "m4", "m5"]), () => "remote");
    expect(results.map((result) => result.kind)).toEqual([
      "added",
      "added",
      "added",
      "added",
      "added",
      "added",
    ]);
    expect(tracker.history().length).toBe(6);
  });
});

describe("policy", () => {
  test("6-turn attempt stops at 4 with completed and the cap message", () => {
    const tracker = new ConversationTracker({ taskId: "task-123" });
    for (const id of ["m0", "m1", "m2", "m3", "m4", "m5"]) {
      if (tracker.history().length >= debate.maxTurns) break;
      tracker.note(makeMessage(id), "remote");
    }
    expect(tracker.history().length).toBe(4);
    const outcome = conversationOutcome(tracker, debate);
    expect(outcome.state).toBe("TASK_STATE_COMPLETED");
    expect(outcome.message?.parts[0]?.text).toBe("max turns reached without verdict");
  });

  test("generic policy carries its own message", () => {
    const tracker = new ConversationTracker({ taskId: "task-123" });
    tracker.note(makeMessage("m0"), "local");
    tracker.note(makeMessage("m1"), "remote");
    const outcome = conversationOutcome(tracker, { maxTurns: 2, capMessage: "max turns reached" });
    expect(outcome.state).toBe("TASK_STATE_COMPLETED");
    expect(outcome.message?.parts[0]?.text).toBe("max turns reached");
  });

  test("outcome is working while turns remain", () => {
    const tracker = new ConversationTracker({ taskId: "task-123" });
    tracker.note(makeMessage("m0"), "local");
    const outcome = conversationOutcome(tracker, chat);
    expect(outcome.state).toBe("TASK_STATE_WORKING");
    expect(outcome.message).toBeUndefined();
  });

  test("timed-out task is failed", () => {
    let nowValue = 0;
    const tracker = new ConversationTracker({
      taskId: "task-123",
      timeoutMs: 1000,
      now: () => nowValue,
    });
    tracker.note(makeMessage("m0"), "local");
    expect(tracker.timedOut()).toBe(false);
    nowValue = 1001;
    expect(tracker.timedOut()).toBe(true);
    expect(conversationOutcome(tracker, chat).state).toBe("TASK_STATE_FAILED");
  });
});

describe("integration", () => {
  test("client task feeds tracker to capped outcome", async () => {
    const history = ["m0", "m1", "m2", "m3", "m4"].map((id) => ({
      messageId: id,
      role: "ROLE_USER",
      parts: [{ text: "hi" }],
    }));
    const fetchFn: FetchFn = () =>
      Promise.resolve(
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { id: "task-123", status: { state: "TASK_STATE_WORKING" }, history },
        }),
      );
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const tracker = new ConversationTracker({ taskId: "task-123" });
    const results = tracker.sync(await client.getTask("task-123"), () => "remote");
    expect(results.filter((result) => result.kind === "added").length).toBe(5);
    const outcome = conversationOutcome(tracker, debate);
    expect(outcome.state).toBe("TASK_STATE_COMPLETED");
    expect(outcome.message?.parts[0]?.text).toBe("max turns reached without verdict");
  });
});
