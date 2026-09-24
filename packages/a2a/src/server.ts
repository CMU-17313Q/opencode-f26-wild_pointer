// Server side of the A2A core: a fetch-style handler for GET
// /.well-known/agent-card.json plus the JSON-RPC methods in INTERFACES.md.
// Tasks live in memory with full history; the server records work but never
// runs it. Session ownership stays with the host plugin: onMessage notifies it
// of each inbound message, onCancel asks it to stop whatever runs for that
// taskId, and appendMessage/setStatus let it write replies and transitions
// back onto the task so open message/stream subscribers see them.

import { z } from "zod";
import { A2AError, ErrorCode, type SendConfiguration } from "./client.ts";
import {
  AgentCardSchema,
  MessageSchema,
  TaskStateSchema,
  type AgentCard,
  type Message,
  type StreamEvent,
  type Task,
  type TaskList,
  type TaskState,
  type TaskStatus,
} from "./types.ts";

const TERMINAL_STATES = new Set<TaskState>([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

// Interrupted states are not terminal: the peer may still reply or cancel.
const INTERRUPTED_STATES = new Set<TaskState>([
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
]);

const STREAM_END_STATES = new Set<TaskState>([...TERMINAL_STATES, ...INTERRUPTED_STATES]);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type RpcId = string | number | null;

const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).default(null),
  method: z.string(),
  params: z.unknown().optional(),
});

const ConfigurationSchema = z.object({
  acceptedOutputModes: z.array(z.string()).optional(),
  historyLength: z.number().int().nonnegative().optional(),
  returnImmediately: z.boolean().optional(),
});

export const SendMessageParamsSchema = z.object({
  message: MessageSchema,
  configuration: ConfigurationSchema.optional(),
});
export type SendMessageParams = z.infer<typeof SendMessageParamsSchema>;

export const TaskGetParamsSchema = z.object({
  id: z.string().min(1),
  historyLength: z.number().int().nonnegative().optional(),
});
export type TaskGetParams = z.infer<typeof TaskGetParamsSchema>;

export const TaskListParamsSchema = z.object({
  contextId: z.string().optional(),
  status: TaskStateSchema.optional(),
  pageSize: z.number().int().positive().optional(),
  pageToken: z.string().optional(),
  historyLength: z.number().int().nonnegative().optional(),
});
export type TaskListParams = z.infer<typeof TaskListParamsSchema>;

export const TaskCancelParamsSchema = z.object({
  id: z.string().min(1),
});
export type TaskCancelParams = z.infer<typeof TaskCancelParamsSchema>;

export interface A2AServerOptions {
  // A getter defers card construction until the host knows its bound port.
  card: AgentCard | (() => AgentCard);
  // Notification-only hook: fired after each inbound message is recorded, via
  // both message/send and message/stream. The host owns any async session work.
  onMessage?: (task: Task, message: Message) => void;
  // Awaited by tasks/cancel so the host can stop the session mapped to taskId.
  onCancel?: (task: Task) => void | Promise<void>;
}

export class A2AServer {
  private readonly options: A2AServerOptions;
  private readonly tasks = new Map<string, Task>();
  private readonly listeners = new Map<string, Set<(event: StreamEvent) => void>>();

  constructor(options: A2AServerOptions) {
    this.options = options;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/.well-known/agent-card.json")
      return this.agentCard();
    if (request.method !== "POST") return new Response("Not Found", { status: 404 });
    return this.rpc(request);
  }

  sendMessage(message: Message, configuration?: SendConfiguration): Task {
    const task = this.record(message);
    this.options.onMessage?.(task, message);
    return view(task, configuration?.historyLength);
  }

  getTask(id: string, historyLength?: number): Task {
    return view(this.require(id), historyLength);
  }

  listTasks(filter: TaskListParams = {}): TaskList {
    const matching = [...this.tasks.values()].filter(
      (task) =>
        (filter.contextId === undefined || task.contextId === filter.contextId) &&
        (filter.status === undefined || task.status.state === filter.status),
    );
    const pageSize = Math.min(filter.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = pageOffset(filter.pageToken);
    const page = matching.slice(offset, offset + pageSize);
    const next = offset + page.length;
    return {
      tasks: page.map((task) => view(task, filter.historyLength)),
      nextPageToken: next < matching.length ? String(next) : "",
      pageSize,
      totalSize: matching.length,
    };
  }

  async cancelTask(id: string): Promise<Task> {
    const task = this.require(id);
    if (TERMINAL_STATES.has(task.status.state))
      throw new A2AError(
        ErrorCode.TASK_NOT_CANCELLABLE,
        `Task "${id}" is already ${task.status.state}.`,
      );
    task.status = { state: "TASK_STATE_CANCELED", timestamp: timestamp() };
    try {
      await this.options.onCancel?.(task);
    } finally {
      this.emit(task, statusEvent(task));
    }
    return task;
  }

  // Host-facing recorders: the plugin's session runner writes its reply and
  // transitions back onto the task through these so history, tasks/get, and
  // open streams all observe the same state.

  appendMessage(taskId: string, message: Message): Task {
    const task = this.require(taskId);
    const stored = linked(message, task);
    task.history = [...(task.history ?? []), stored];
    this.emit(task, stored);
    return task;
  }

  setStatus(taskId: string, status: TaskStatus): Task {
    const task = this.require(taskId);
    task.status = { ...status, timestamp: status.timestamp ?? timestamp() };
    this.emit(task, statusEvent(task));
    return task;
  }

  private agentCard(): Response {
    const card = typeof this.options.card === "function" ? this.options.card() : this.options.card;
    const parsed = AgentCardSchema.safeParse(card);
    if (!parsed.success) return new Response("Invalid agent card", { status: 500 });
    return Response.json(parsed.data);
  }

  private async rpc(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => undefined);
    if (body === undefined)
      return rpcError(null, ErrorCode.PARSE_ERROR, "Request body is not valid JSON.");
    const parsed = RpcRequestSchema.safeParse(body);
    if (!parsed.success)
      return rpcError(null, ErrorCode.INVALID_REQUEST, "Invalid JSON-RPC request.");
    const { id, method, params } = parsed.data;
    switch (method) {
      case "message/send":
        return this.invoke(id, params, SendMessageParamsSchema, (p) =>
          this.sendMessage(p.message, p.configuration),
        );
      case "tasks/get":
        return this.invoke(id, params, TaskGetParamsSchema, (p) =>
          this.getTask(p.id, p.historyLength),
        );
      case "tasks/list":
        return this.invoke(id, params, TaskListParamsSchema, (p) => this.listTasks(p));
      case "tasks/cancel":
        return this.invoke(id, params, TaskCancelParamsSchema, (p) => this.cancelTask(p.id));
      case "message/stream":
        return this.stream(id, params);
      default:
        return rpcError(id, ErrorCode.METHOD_NOT_FOUND, `Unknown method "${method}".`);
    }
  }

  private async invoke<P>(
    id: RpcId,
    params: unknown,
    schema: z.ZodType<P>,
    run: (params: P) => unknown | Promise<unknown>,
  ): Promise<Response> {
    const parsed = schema.safeParse(params);
    if (!parsed.success)
      return rpcError(id, ErrorCode.INVALID_PARAMS, `Invalid params: ${issueText(parsed.error)}`);
    try {
      return rpcResult(id, await run(parsed.data));
    } catch (error) {
      const failure = asError(error);
      return rpcError(id, failure.code, failure.message);
    }
  }

  private stream(id: RpcId, params: unknown): Response {
    const parsed = SendMessageParamsSchema.safeParse(params);
    if (!parsed.success)
      return rpcError(id, ErrorCode.INVALID_PARAMS, `Invalid params: ${issueText(parsed.error)}`, 400);
    try {
      const task = this.record(parsed.data.message);
      this.options.onMessage?.(task, parsed.data.message);
      return this.streamResponse(task);
    } catch (error) {
      const failure = asError(error);
      return rpcError(id, failure.code, failure.message, httpStatus(failure.code));
    }
  }

  // One SSE stream per subscription. The recorded task is sent first so the
  // peer always sees the current state; later events arrive as the host writes
  // them and the stream ends when the task settles or is interrupted.
  private streamResponse(task: Task): Response {
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (event: StreamEvent) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        unsubscribe = this.subscribe(task.id, (event) => {
          write(event);
          if (isStreamEnd(event)) {
            unsubscribe();
            controller.close();
          }
        });
        write(task);
        if (STREAM_END_STATES.has(task.status.state)) {
          unsubscribe();
          controller.close();
        }
      },
      cancel: () => unsubscribe(),
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  private record(message: Message): Task {
    if (message.taskId === undefined) return this.create(message);
    const task = this.tasks.get(message.taskId);
    if (task === undefined)
      throw new A2AError(ErrorCode.TASK_NOT_FOUND, `Task "${message.taskId}" not found.`);
    if (TERMINAL_STATES.has(task.status.state))
      throw new A2AError(
        ErrorCode.INVALID_PARAMS,
        `Task "${task.id}" is ${task.status.state} and cannot accept messages.`,
      );
    task.history = [...(task.history ?? []), linked(message, task)];
    if (INTERRUPTED_STATES.has(task.status.state))
      task.status = { state: "TASK_STATE_SUBMITTED", timestamp: timestamp() };
    this.emit(task, task);
    return task;
  }

  private create(message: Message): Task {
    const task: Task = {
      id: crypto.randomUUID(),
      contextId: message.contextId ?? crypto.randomUUID(),
      status: { state: "TASK_STATE_SUBMITTED", timestamp: timestamp() },
      history: [],
    };
    task.history = [linked(message, task)];
    this.tasks.set(task.id, task);
    return task;
  }

  private require(id: string): Task {
    const task = this.tasks.get(id);
    if (task === undefined)
      throw new A2AError(ErrorCode.TASK_NOT_FOUND, `Task "${id}" not found.`);
    return task;
  }

  private subscribe(taskId: string, listener: (event: StreamEvent) => void): () => void {
    const set = this.listeners.get(taskId) ?? new Set();
    set.add(listener);
    this.listeners.set(taskId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(taskId);
    };
  }

  private emit(task: Task, event: StreamEvent): void {
    const listeners = this.listeners.get(task.id);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) listener(event);
  }
}

function linked(message: Message, task: Task): Message {
  return { ...message, taskId: task.id, contextId: message.contextId ?? task.contextId };
}

function statusEvent(task: Task): StreamEvent {
  return { taskId: task.id, contextId: task.contextId ?? "", status: task.status };
}

function view(task: Task, historyLength?: number): Task {
  if (historyLength === undefined || task.history === undefined) return task;
  return { ...task, history: task.history.slice(Math.max(task.history.length - historyLength, 0)) };
}

function isStreamEnd(event: StreamEvent): boolean {
  if (!("status" in event)) return false;
  return STREAM_END_STATES.has(event.status.state);
}

function pageOffset(token: string | undefined): number {
  if (token === undefined || token === "") return 0;
  const offset = Number(token);
  if (!Number.isInteger(offset) || offset < 0)
    throw new A2AError(ErrorCode.INVALID_PARAMS, `Invalid pageToken "${token}".`);
  return offset;
}

function timestamp(): string {
  return new Date().toISOString();
}

function rpcResult(id: RpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: RpcId, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

function asError(error: unknown): { code: number; message: string } {
  if (error instanceof A2AError) return { code: error.code, message: error.message };
  return {
    code: ErrorCode.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : "Internal error",
  };
}

// Stream setup failures must be HTTP errors: the client's stream reader only
// checks response.ok and never parses a JSON-RPC error envelope there.
function httpStatus(code: number): number {
  if (code === ErrorCode.TASK_NOT_FOUND) return 404;
  if (code === ErrorCode.INVALID_PARAMS || code === ErrorCode.INVALID_REQUEST) return 400;
  return 500;
}

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`)
    .join("; ");
}
