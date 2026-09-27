import { describe, expect, test } from "bun:test";
import { A2AClient, A2AError, ErrorCode } from "../src/client.ts";
import { A2AServer, type A2AServerOptions } from "../src/server.ts";
import type { AgentCard, Message, Task } from "../src/types.ts";

const card: AgentCard = {
  name: "Peer",
  description: "Test peer",
  version: "1.0.0",
  supportedInterfaces: [
    { url: "http://a2a.test/", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
  capabilities: { streaming: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "chat", name: "Chat", description: "Talk", tags: ["chat"] }],
};

const userMessage: Message = {
  messageId: "msg-0",
  role: "ROLE_USER",
  parts: [{ text: "hello" }],
};

const agentMessage: Message = {
  messageId: "msg-1",
  role: "ROLE_AGENT",
  parts: [{ text: "hi" }],
};

function pair(options?: Partial<A2AServerOptions>) {
  const server = new A2AServer({ card, ...options });
  const client = new A2AClient({
    baseUrl: "http://a2a.test",
    fetchFn: (input, init) => server.fetch(new Request(input, init)),
  });
  return { server, client };
}

function rpc(body: unknown): Request {
  return new Request("http://a2a.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

async function readSse(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split(/\r?\n\r?\n/)
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) =>
      JSON.parse(
        chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("\n"),
      ),
    );
}

describe("agent card", () => {
  test("GET /.well-known/agent-card.json returns the card", async () => {
    const { client } = pair();
    const result = await client.fetchAgentCard();
    expect(result.name).toBe("Peer");
    expect(result.capabilities.streaming).toBe(true);
  });

  test("supports a lazy card getter", async () => {
    const { client } = pair({ card: () => ({ ...card, name: "Lazy" }) });
    const result = await client.fetchAgentCard();
    expect(result.name).toBe("Lazy");
  });
});

describe("message/send", () => {
  test("creates a submitted task with the message in history", async () => {
    const { client } = pair();
    const result = await client.sendMessage(userMessage);
    expect(result).toMatchObject({ status: { state: "TASK_STATE_SUBMITTED" } });
    if (!("id" in result)) throw new Error("expected a task");
    expect(result.id).not.toBe("");
    expect(result.history?.length).toBe(1);
    expect(result.history?.[0]).toMatchObject({
      messageId: "msg-0",
      taskId: result.id,
      contextId: result.contextId,
    });
  });

  test("appends a reply with the same taskId to history", async () => {
    const { client } = pair();
    const task = (await client.sendMessage(userMessage)) as Task;
    const reply: Message = {
      messageId: "msg-2",
      role: "ROLE_USER",
      parts: [{ text: "follow up" }],
      taskId: task.id,
    };
    await client.sendMessage(reply);
    const stored = await client.getTask(task.id);
    expect(stored.history?.map((m) => m.messageId)).toEqual(["msg-0", "msg-2"]);
  });

  test("rejects a reply for an unknown taskId", async () => {
    const { client } = pair();
    const error = await catchError(
      client.sendMessage({ ...userMessage, taskId: "missing" }),
    );
    expect(error).toBeInstanceOf(A2AError);
    if (error instanceof A2AError) expect(error.code).toBe(ErrorCode.TASK_NOT_FOUND);
  });

  test("fires onMessage with the stored task and message", async () => {
    const seen: { taskId: string; messageId: string }[] = [];
    const { client } = pair({
      onMessage: (task, message) => seen.push({ taskId: task.id, messageId: message.messageId }),
    });
    await client.sendMessage(userMessage);
    expect(seen.length).toBe(1);
    expect(seen[0]?.messageId).toBe("msg-0");
  });

  test("records the x-a2a-peer header on the task", async () => {
    const { server } = pair();
    const named = new A2AClient({
      baseUrl: "http://a2a.test",
      headers: { "x-a2a-peer": "alice" },
      fetchFn: (input, init) => server.fetch(new Request(input, init)),
    });
    const task = (await named.sendMessage(userMessage)) as Task;
    expect(task.metadata?.peerId).toBe("alice");
  });

  test("falls back to the caller-supplied peer identity", async () => {
    const { server } = pair();
    await server.fetch(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: userMessage },
      }),
      "10.0.0.1",
    );
    expect(server.listTasks().tasks[0]?.metadata?.peerId).toBe("10.0.0.1");
  });

  test("the peer header wins over the fallback identity", async () => {
    const { server } = pair();
    const request = new Request(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: userMessage },
      }),
      { headers: { "x-a2a-peer": "bob" } },
    );
    await server.fetch(request, "10.0.0.1");
    expect(server.listTasks().tasks[0]?.metadata?.peerId).toBe("bob");
  });

  test("backfills peer identity on a later message", async () => {
    const { server, client } = pair();
    const task = (await client.sendMessage(userMessage)) as Task;
    expect(task.metadata).toBeUndefined();
    await server.fetch(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { ...userMessage, messageId: "msg-2", taskId: task.id } },
      }),
      "10.0.0.1",
    );
    expect((await client.getTask(task.id)).metadata?.peerId).toBe("10.0.0.1");
  });
});

describe("tasks/get", () => {
  test("returns the stored task with both messages", async () => {
    const { client } = pair();
    const task = (await client.sendMessage(userMessage)) as Task;
    await client.sendMessage({ ...userMessage, messageId: "msg-2", taskId: task.id });
    const stored = await client.getTask(task.id);
    expect(stored.id).toBe(task.id);
    expect(stored.history?.length).toBe(2);
  });

  test("honors historyLength", async () => {
    const { client } = pair();
    const task = (await client.sendMessage(userMessage)) as Task;
    await client.sendMessage({ ...userMessage, messageId: "msg-2", taskId: task.id });
    const truncated = await client.getTask(task.id, 1);
    expect(truncated.history?.map((m) => m.messageId)).toEqual(["msg-2"]);
    const empty = await client.getTask(task.id, 0);
    expect(empty.history?.length).toBe(0);
  });

  test("unknown task is a typed error", async () => {
    const { client } = pair();
    const error = await catchError(client.getTask("nope"));
    expect(error).toBeInstanceOf(A2AError);
    if (error instanceof A2AError) expect(error.code).toBe(ErrorCode.TASK_NOT_FOUND);
  });
});

describe("tasks/list", () => {
  test("returns stored tasks", async () => {
    const { client } = pair();
    await client.sendMessage(userMessage);
    await client.sendMessage({ ...userMessage, messageId: "msg-2" });
    const result = await client.listTasks();
    expect(result.totalSize).toBe(2);
    expect(result.tasks.length).toBe(2);
    expect(result.nextPageToken).toBe("");
  });

  test("filters by contextId and status", async () => {
    const { client } = pair();
    const a = (await client.sendMessage(userMessage)) as Task;
    await client.sendMessage({ ...userMessage, messageId: "msg-2" });
    const byContext = await client.listTasks({ contextId: a.contextId });
    expect(byContext.totalSize).toBe(1);
    expect(byContext.tasks[0]?.id).toBe(a.id);
    const byStatus = await client.listTasks({ status: "TASK_STATE_CANCELED" });
    expect(byStatus.totalSize).toBe(0);
  });

  test("paginates with pageToken", async () => {
    const { client } = pair();
    await client.sendMessage(userMessage);
    await client.sendMessage({ ...userMessage, messageId: "msg-2" });
    const first = await client.listTasks({ pageSize: 1 });
    expect(first.tasks.length).toBe(1);
    expect(first.nextPageToken).toBe("1");
    const second = await client.listTasks({ pageSize: 1, pageToken: first.nextPageToken });
    expect(second.tasks.length).toBe(1);
    expect(second.nextPageToken).toBe("");
    expect(second.tasks[0]?.id).not.toBe(first.tasks[0]?.id);
  });
});

describe("tasks/cancel", () => {
  test("transitions to canceled and invokes onCancel", async () => {
    const canceled: string[] = [];
    const { client } = pair({ onCancel: (task) => void canceled.push(task.id) });
    const task = (await client.sendMessage(userMessage)) as Task;
    const result = await client.cancelTask(task.id);
    expect(result.status.state).toBe("TASK_STATE_CANCELED");
    expect(canceled).toEqual([task.id]);
    const stored = await client.getTask(task.id);
    expect(stored.status.state).toBe("TASK_STATE_CANCELED");
  });

  test("emits the cancel event to open streams", async () => {
    const { server, client } = pair();
    const task = (await client.sendMessage(userMessage)) as Task;
    const response = await server.fetch(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "message/stream",
        params: { message: { ...userMessage, messageId: "msg-2", taskId: task.id } },
      }),
    );
    await client.cancelTask(task.id);
    const events = (await readSse(response)) as { status?: { state: string } }[];
    expect(events.at(-1)?.status?.state).toBe("TASK_STATE_CANCELED");
  });

  test("a terminal task is not cancellable", async () => {
    const { server, client } = pair();
    const task = (await client.sendMessage(userMessage)) as Task;
    server.setStatus(task.id, { state: "TASK_STATE_COMPLETED" });
    const error = await catchError(client.cancelTask(task.id));
    expect(error).toBeInstanceOf(A2AError);
    if (error instanceof A2AError) expect(error.code).toBe(ErrorCode.TASK_NOT_CANCELLABLE);
  });
});

describe("message/stream", () => {
  test("creates a task, then streams reply events for it", async () => {
    const { server, client } = pair();
    const events: unknown[] = [];
    const done = (async () => {
      for await (const event of client.streamMessage(userMessage)) events.push(event);
    })();
    await Bun.sleep(0);
    const task = (await client.getTask((await client.listTasks()).tasks[0]!.id)) as Task;
    server.appendMessage(task.id, agentMessage);
    server.setStatus(task.id, { state: "TASK_STATE_COMPLETED" });
    await done;
    expect(events.length).toBe(3);
    expect(events[0]).toMatchObject({ id: task.id, status: { state: "TASK_STATE_SUBMITTED" } });
    expect(events[1]).toMatchObject({ messageId: "msg-1", role: "ROLE_AGENT" });
    expect(events[2]).toMatchObject({
      taskId: task.id,
      status: { state: "TASK_STATE_COMPLETED" },
    });
  });

  test("records the streamed message on an existing task", async () => {
    const { server, client } = pair();
    const task = (await client.sendMessage(userMessage)) as Task;
    server.setStatus(task.id, { state: "TASK_STATE_INPUT_REQUIRED" });
    const response = await server.fetch(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "message/stream",
        params: { message: { ...userMessage, messageId: "msg-2", taskId: task.id } },
      }),
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    // The stream stays open until the task settles; complete it to close.
    server.setStatus(task.id, { state: "TASK_STATE_COMPLETED" });
    const events = (await readSse(response)) as Task[];
    // Snapshot first: the recorded reply is already in history.
    expect(events[0]?.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(events[0]?.history?.map((m) => m.messageId)).toEqual(["msg-0", "msg-2"]);
    expect(events.at(-1)).toMatchObject({ status: { state: "TASK_STATE_COMPLETED" } });
    const stored = await client.getTask(task.id);
    expect(stored.history?.map((m) => m.messageId)).toEqual(["msg-0", "msg-2"]);
  });

  test("rejects a streamed message for a terminal task", async () => {
    const { server, client } = pair();
    const task = (await client.sendMessage(userMessage)) as Task;
    await client.cancelTask(task.id);
    const response = await server.fetch(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "message/stream",
        params: { message: { ...agentMessage, taskId: task.id } },
      }),
    );
    // A terminal task cannot accept the message, so the stream never opens.
    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  });

  test("unknown taskId fails the request with an HTTP error", async () => {
    const { client } = pair();
    const error = await catchError(
      (async () => {
        for await (const event of client.streamMessage({ ...userMessage, taskId: "missing" }))
          void event;
      })(),
    );
    expect(error).toBeInstanceOf(A2AError);
    if (error instanceof A2AError) expect(error.code).toBe(404);
  });
});

describe("json-rpc envelope", () => {
  test("malformed JSON is a parse error", async () => {
    const { server } = pair();
    const response = await server.fetch(
      new Request("http://a2a.test/", { method: "POST", body: "not json" }),
    );
    const body = await response.json();
    expect(body).toMatchObject({ id: null, error: { code: ErrorCode.PARSE_ERROR } });
  });

  test("unknown method is method-not-found", async () => {
    const { server } = pair();
    const response = await server.fetch(
      rpc({ jsonrpc: "2.0", id: 7, method: "tasks/nope", params: {} }),
    );
    const body = await response.json();
    expect(body).toMatchObject({ id: 7, error: { code: ErrorCode.METHOD_NOT_FOUND } });
  });

  test("invalid params are rejected", async () => {
    const { server } = pair();
    const response = await server.fetch(
      rpc({ jsonrpc: "2.0", id: 7, method: "tasks/get", params: { id: "" } }),
    );
    const body = await response.json();
    expect(body).toMatchObject({ id: 7, error: { code: ErrorCode.INVALID_PARAMS } });
  });
});
