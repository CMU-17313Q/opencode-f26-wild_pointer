import { describe, expect, test } from "bun:test";
import { SpeakerSchema, TurnSchema } from "../src/conversation.ts";

describe("Speaker", () => {
  test("accepts each speaker on its own", () => {
    expect(SpeakerSchema.safeParse("local").success).toBe(true);
    expect(SpeakerSchema.safeParse("remote").success).toBe(true);
  });

  test("rejects wire roles and anything else", () => {
    expect(SpeakerSchema.safeParse("ROLE_USER").success).toBe(false);
    expect(SpeakerSchema.safeParse("user").success).toBe(false);
    expect(SpeakerSchema.safeParse("agent").success).toBe(false);
  });
});

describe("Turn", () => {
  test("accepts a minimal turn", () => {
    expect(TurnSchema.safeParse({ index: 0, speaker: "local", text: "hello" }).success).toBe(
      true,
    );
  });

  test("accepts a turn linked to wire objects", () => {
    expect(
      TurnSchema.safeParse({
        index: 1,
        speaker: "remote",
        text: "hi back",
        messageId: "msg-1",
        taskId: "task-123",
        peerId: "peer-b",
      }).success,
    ).toBe(true);
  });

  test("rejects negative or fractional index", () => {
    expect(
      TurnSchema.safeParse({ index: -1, speaker: "local", text: "hello" }).success,
    ).toBe(false);
    expect(
      TurnSchema.safeParse({ index: 0.5, speaker: "local", text: "hello" }).success,
    ).toBe(false);
  });

  test("rejects empty text and bad speaker", () => {
    expect(TurnSchema.safeParse({ index: 0, speaker: "local", text: "" }).success).toBe(false);
    expect(TurnSchema.safeParse({ index: 0, speaker: "ROLE_USER", text: "hi" }).success).toBe(
      false,
    );
  });
});
