import { describe, expect, test } from "bun:test";
import { A2AClient, A2AError, A2AValidationError, type FetchFn } from "../src/client.ts";
import type { Message } from "../src/types.ts";

const card = {
  name: "Peer",
  description: "Test peer",
  version: "1.0.0",
  supportedInterfaces: [
    { url: "https://peer.test/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
  capabilities: {},
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "chat", name: "Chat", description: "Talk", tags: ["chat"] }],
};

const userMessage: Message = { messageId: "msg-0", role: "ROLE_USER", parts: [{ text: "hello" }] };
const agentMessage: Message = { messageId: "msg-1", role: "ROLE_AGENT", parts: [{ text: "hi" }] };

function workingTask(history: unknown[] = []) {
  return {
    id: "task-123",
    status: { state: "TASK_STATE_WORKING" },
    history,
  };
}

interface SeenRequest {
  url: string;
  body: unknown;
}

function createMock(handler: (seen: SeenRequest) => Response): {
  fetchFn: FetchFn;
  seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  const fetchFn: FetchFn = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const entry = {
      url,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    seen.push(entry);
    return Promise.resolve(handler(entry));
  };
  return { fetchFn, seen };
}

function jsonResult(result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: 1, result });
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("fetchAgentCard", () => {
  test("GETs the well-known URL and validates the card", async () => {
    const { fetchFn, seen } = createMock(() => Response.json(card));
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const result = await client.fetchAgentCard();
    expect(seen[0]?.url).toBe("https://peer.test/.well-known/agent-card.json");
    expect(result.name).toBe("Peer");
  });
});

describe("sendMessage", () => {
  test("starts a task with message/send", async () => {
    const { fetchFn, seen } = createMock(() => jsonResult(workingTask([userMessage])));
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const result = await client.sendMessage(userMessage);
    expect(seen[0]?.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: userMessage },
    });
    expect(result).toMatchObject({ id: "task-123", status: { state: "TASK_STATE_WORKING" } });
  });

  test("returns a direct message reply", async () => {
    const { fetchFn } = createMock(() => jsonResult(agentMessage));
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const result = await client.sendMessage(userMessage);
    expect(result).toMatchObject({ messageId: "msg-1", role: "ROLE_AGENT" });
  });
});

describe("streamMessage", () => {
  const sse = [
    'data: {"id":"task-123","status":{"state":"TASK_STATE_WORKING"}}',
    "",
    'data: {"taskId":"task-123","contextId":"ctx-1","status":{"state":"TASK_STATE_INPUT_REQUIRED"}}',
    "",
    'data: {"taskId":"task-123","contextId":"ctx-1","artifact":{"artifactId":"a1","parts":[{"text":"half"}]}}',
    "",
  ].join("\n");

  test("yields task, status update, and artifact update in order", async () => {
    const { fetchFn, seen } = createMock(
      () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    );
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const message = { ...userMessage, taskId: "task-123" };
    const events = [];
    for await (const event of client.streamMessage(message)) events.push(event);
    expect(seen[0]?.body).toMatchObject({ method: "message/stream" });
    expect(events.length).toBe(3);
    expect(events[0]).toMatchObject({ id: "task-123" });
    expect(events[1]).toMatchObject({
      taskId: "task-123",
      status: { state: "TASK_STATE_INPUT_REQUIRED" },
    });
    expect(events[2]).toMatchObject({ artifact: { artifactId: "a1" } });
  });
});

describe("getTask", () => {
  test("returns the updated task with full history", async () => {
    const { fetchFn, seen } = createMock(() => jsonResult(workingTask([userMessage, agentMessage])));
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const result = await client.getTask("task-123");
    expect(seen[0]?.body).toMatchObject({ method: "tasks/get", params: { id: "task-123" } });
    expect(result.history?.length).toBe(2);
  });
});

describe("listTasks", () => {
  test("returns the task page", async () => {
    const { fetchFn } = createMock(() =>
      jsonResult({ tasks: [workingTask()], nextPageToken: "", pageSize: 10, totalSize: 1 }),
    );
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const result = await client.listTasks({ contextId: "ctx-1" });
    expect(result.tasks.length).toBe(1);
    expect(result.totalSize).toBe(1);
  });
});

describe("cancelTask", () => {
  test("transitions to canceled", async () => {
    const { fetchFn, seen } = createMock(() =>
      jsonResult({ id: "task-123", status: { state: "TASK_STATE_CANCELED" } }),
    );
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const result = await client.cancelTask("task-123");
    expect(seen[0]?.body).toMatchObject({ method: "tasks/cancel" });
    expect(result.status.state).toBe("TASK_STATE_CANCELED");
  });
});

describe("headers option", () => {
  test("sends configured headers without overriding per-call headers", async () => {
    const seen: Headers[] = [];
    const fetchFn: FetchFn = (input, init) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(jsonResult(workingTask()));
    };
    const client = new A2AClient({
      baseUrl: "https://peer.test",
      fetchFn,
      headers: { "x-a2a-peer": "alice" },
    });
    await client.sendMessage(userMessage);
    expect(seen[0]?.get("x-a2a-peer")).toBe("alice");
    expect(seen[0]?.get("content-type")).toBe("application/json");
  });
});

describe("errors", () => {
  test("JSON-RPC error becomes A2AError with code and method", async () => {
    const { fetchFn } = createMock(() =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "Task not found" },
      }),
    );
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const error = await catchError(client.getTask("nope"));
    expect(error).toBeInstanceOf(A2AError);
    if (error instanceof A2AError) {
      expect(error.code).toBe(-32001);
      expect(error.method).toBe("tasks/get");
    }
  });

  test("invalid payload becomes A2AValidationError", async () => {
    const { fetchFn } = createMock(() => jsonResult({ id: "task-123" }));
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const error = await catchError(client.getTask("task-123"));
    expect(error).toBeInstanceOf(A2AValidationError);
  });

  test("HTTP failure becomes A2AError", async () => {
    const { fetchFn } = createMock(() => new Response("boom", { status: 500 }));
    const client = new A2AClient({ baseUrl: "https://peer.test", fetchFn });
    const error = await catchError(client.getTask("task-123"));
    expect(error).toBeInstanceOf(A2AError);
    if (error instanceof A2AError) expect(error.code).toBe(500);
  });
});
