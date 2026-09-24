import { z } from "zod";
import {
  AgentCardSchema,
  SendMessageResponseSchema,
  StreamEventSchema,
  TaskListSchema,
  TaskSchema,
  type AgentCard,
  type Message,
  type SendMessageResponse,
  type StreamEvent,
  type Task,
  type TaskList,
  type TaskState,
} from "./types.ts";

export const ErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELLABLE: -32002,
  UNSUPPORTED_OPERATION: -32003,
} as const;

export class A2AError extends Error {
  code: number;
  method?: string;
  data?: unknown;

  constructor(code: number, message: string, options?: { method?: string; data?: unknown }) {
    super(message);
    this.name = "A2AError";
    this.code = code;
    this.method = options?.method;
    this.data = options?.data;
  }
}

export class A2AValidationError extends A2AError {
  constructor(message: string, options?: { method?: string; data?: unknown }) {
    super(ErrorCode.INVALID_PARAMS, message, options);
    this.name = "A2AValidationError";
  }
}

const EnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export interface SendConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  returnImmediately?: boolean;
}

export interface TaskFilter {
  contextId?: string;
  status?: TaskState;
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
}

export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface A2AClientOptions {
  baseUrl: string;
  fetchFn?: FetchFn;
  // Sent on every request (card fetch and JSON-RPC alike); per-call headers
  // such as content-type and accept always win.
  headers?: Record<string, string>;
}

export class A2AClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly headers: Record<string, string>;
  private nextId = 1;

  constructor(options: A2AClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.headers = options.headers ?? {};
  }

  async fetchAgentCard(): Promise<AgentCard> {
    const response = await this.readRaw(`${this.baseUrl}/.well-known/agent-card.json`, undefined, "agent card");
    return requireValid(AgentCardSchema, await response.json(), "agent card");
  }

  sendMessage(message: Message, configuration?: SendConfiguration): Promise<SendMessageResponse> {
    return this.rpc("message/send", withConfiguration({ message }, configuration), SendMessageResponseSchema);
  }

  async *streamMessage(
    message: Message,
    configuration?: SendConfiguration,
  ): AsyncGenerator<StreamEvent> {
    const response = await this.readRaw(
      this.baseUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: this.envelope("message/stream", withConfiguration({ message }, configuration)),
      },
      "message/stream",
    );
    for (const event of parseSse(await response.text()))
      yield requireValid(StreamEventSchema, event, "message/stream");
  }

  getTask(id: string, historyLength?: number): Promise<Task> {
    const params = historyLength === undefined ? { id } : { id, historyLength };
    return this.rpc("tasks/get", params, TaskSchema);
  }

  listTasks(filter?: TaskFilter): Promise<TaskList> {
    return this.rpc("tasks/list", filter ?? {}, TaskListSchema);
  }

  cancelTask(id: string): Promise<Task> {
    return this.rpc("tasks/cancel", { id }, TaskSchema);
  }

  private async rpc<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await this.readRaw(
      this.baseUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: this.envelope(method, params),
      },
      method,
    );
    const envelope = EnvelopeSchema.safeParse(await response.json());
    if (!envelope.success)
      throw new A2AValidationError(`Invalid JSON-RPC envelope for ${method}.`, { method });
    if (envelope.data.error !== undefined)
      throw new A2AError(envelope.data.error.code, envelope.data.error.message, {
        method,
        data: envelope.data.error.data,
      });
    if (envelope.data.result === undefined)
      throw new A2AValidationError(`Missing result for ${method}.`, { method });
    return requireValid(schema, envelope.data.result, method);
  }

  private envelope(method: string, params: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
  }

  private async readRaw(input: string, init: RequestInit | undefined, label: string): Promise<Response> {
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(this.headers)) {
      if (!headers.has(key)) headers.set(key, value);
    }
    const response = await this.fetchFn(input, { ...init, headers });
    if (!response.ok)
      throw new A2AError(response.status, `Request ${label} failed with HTTP ${response.status}.`, {
        method: label,
      });
    return response;
  }
}

function requireValid<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new A2AValidationError(`Invalid payload for ${label}.`, { method: label });
  return parsed.data;
}

function withConfiguration(
  params: Record<string, unknown>,
  configuration?: SendConfiguration,
): unknown {
  if (configuration === undefined) return params;
  return { ...params, configuration };
}

function parseSse(text: string): unknown[] {
  const events: unknown[] = [];
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (data === "" || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      throw new A2AValidationError("Malformed SSE data.", { method: "message/stream" });
    }
  }
  return events;
}
