import { describe, expect, test } from "bun:test";
import { AgentCardSchema, MessageSchema, PartSchema, RoleSchema, TaskSchema, TaskStateSchema } from "../src/types.ts";

const task = {
  id: "task-123",
  contextId: "ctx-1",
  status: {
    state: "TASK_STATE_WORKING",
    message: {
      messageId: "msg-1",
      role: "ROLE_AGENT",
      parts: [{ text: "working on it" }],
    },
    timestamp: "2026-09-22T20:00:00Z",
  },
  history: [
    {
      messageId: "msg-0",
      role: "ROLE_USER",
      parts: [{ text: "hello" }],
    },
  ],
};

const card = {
  name: "Recipe Agent",
  description: "Helps with recipes",
  version: "1.0.0",
  supportedInterfaces: [
    { url: "https://api.example.com/a2a/v1", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
  capabilities: { streaming: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "recipes", name: "Recipes", description: "Cook", tags: ["cooking"] }],
};

describe("TaskState", () => {
  test("accepts every v1.0 state", () => {
    for (const state of [
      "TASK_STATE_UNSPECIFIED",
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED",
      "TASK_STATE_CANCELED",
      "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_REJECTED",
      "TASK_STATE_AUTH_REQUIRED",
    ]) {
      expect(TaskStateSchema.safeParse(state).success).toBe(true);
    }
  });

  test("rejects legacy lowercase states", () => {
    expect(TaskStateSchema.safeParse("working").success).toBe(false);
  });
});

describe("Role", () => {
  test("accepts each role on its own", () => {
    expect(RoleSchema.safeParse("ROLE_UNSPECIFIED").success).toBe(true);
    expect(RoleSchema.safeParse("ROLE_USER").success).toBe(true);
    expect(RoleSchema.safeParse("ROLE_AGENT").success).toBe(true);
  });

  test("rejects legacy lowercase roles", () => {
    expect(RoleSchema.safeParse("user").success).toBe(false);
  });
});

describe("Part", () => {
  test("accepts a text part", () => {
    expect(PartSchema.safeParse({ text: "hello" }).success).toBe(true);
  });

  test("rejects a part without text", () => {
    expect(PartSchema.safeParse({ url: "https://example.com/a.png" }).success).toBe(false);
  });
});

describe("Message", () => {
  test("accepts a text message", () => {
    expect(
      MessageSchema.safeParse({ messageId: "msg-0", role: "ROLE_USER", parts: [{ text: "hi" }] })
        .success,
    ).toBe(true);
  });

  test("rejects empty parts", () => {
    expect(
      MessageSchema.safeParse({ messageId: "msg-0", role: "ROLE_USER", parts: [] }).success,
    ).toBe(false);
  });
});

describe("Task", () => {
  test("accepts a valid task", () => {
    expect(TaskSchema.safeParse(task).success).toBe(true);
  });

  test("rejects a task without status", () => {
    expect(TaskSchema.safeParse({ id: "task-123" }).success).toBe(false);
  });
});

describe("AgentCard", () => {
  test("accepts a valid card", () => {
    expect(AgentCardSchema.safeParse(card).success).toBe(true);
  });

  test("rejects a card without skills", () => {
    expect(
      AgentCardSchema.safeParse({
        name: "Recipe Agent",
        description: "Helps with recipes",
        version: "1.0.0",
        supportedInterfaces: [
          { url: "https://api.example.com/a2a/v1", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
        capabilities: {},
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
      }).success,
    ).toBe(false);
  });
});
