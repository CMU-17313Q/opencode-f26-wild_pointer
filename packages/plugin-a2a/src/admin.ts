import { mkdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { AgentCardSchema } from "a2a"
import type { PeerManager } from "./peers.ts"
import type { ConversationCore } from "./conversation.ts"
import type { A2AConfig } from "./config.ts"
import type { Registry } from "./registry.ts"

export type AdminServer = {
  hostname: string
  port: number
  stop: () => Promise<void>
}

export type AdminDeps = {
  registry: Registry
  core: ConversationCore
  peers: PeerManager
  config: () => A2AConfig
  portFile: string
  testTimeoutMs?: number
  port?: number
  hostname?: string
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

// The Desktop webview is a different origin from the host, so the loopback
// admin endpoint answers CORS preflight and tags every response.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
}

// A2A-014's zero-core-edit transport: a second loopback-only server, entirely
// separate from the A2A peer port, that the Desktop and TUI UIs call.
export async function startAdminServer(input: AdminDeps): Promise<AdminServer> {
  const server = Bun.serve({
    hostname: input.hostname ?? "127.0.0.1",
    port: input.port ?? 0,
    fetch: (request) => handle(request, input),
  })
  const port = server.port ?? input.port ?? 0
  await mkdir(path.dirname(input.portFile), { recursive: true })
  await writeFile(input.portFile, String(port), "utf8")
  return {
    hostname: server.hostname ?? input.hostname ?? "127.0.0.1",
    port,
    stop: async () => {
      server.stop(true)
      await unlink(input.portFile).catch(() => undefined)
    },
  }
}

async function handle(request: Request, input: AdminDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  const parts = new URL(request.url).pathname.split("/").filter(Boolean)
  try {
    if (parts[0] !== "a2a") throw new HttpError(404, "Not found")
    if (parts[1] === "sessions") return await sessions(request, parts, input)
    if (parts[1] === "conversations") return await conversations(request, parts, input)
    if (parts[1] === "peers") return await peers(request, parts, input)
    throw new HttpError(404, "Not found")
  } catch (error) {
    if (error instanceof HttpError) return fail(error.message, error.status)
    const message = reason(error)
    return fail(message, statusFor(message))
  }
}

async function sessions(request: Request, parts: string[], input: AdminDeps): Promise<Response> {
  if (request.method !== "GET") throw new HttpError(405, "Method not allowed")
  if (parts.length === 2) return json(input.registry.list())
  const taskId = decodeURIComponent(parts[2])
  const record = input.registry.get(taskId)
  if (record === undefined) throw new HttpError(404, `Unknown A2A task "${taskId}"`)
  return json(record)
}

async function conversations(request: Request, parts: string[], input: AdminDeps): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed")
  if (parts.length === 2) {
    const payload = await body(request)
    const peer = stringField(payload, "peer")
    const message = stringField(payload, "message")
    const origin = payload.origin === undefined ? "app" : payload.origin
    if (origin !== "app" && origin !== "tui") throw new HttpError(400, 'origin must be "app" or "tui"')
    const result = await input.core.startConversation(peer, message, { origin, signal: request.signal })
    return json(result)
  }
  const taskId = decodeURIComponent(parts[2])
  const record = input.registry.get(taskId)
  if (record === undefined) throw new HttpError(404, `Unknown A2A task "${taskId}"`)
  if (parts[3] === "messages") {
    if (record.direction === "inbound") throw new HttpError(400, `Task "${taskId}" is inbound; the peer drives it`)
    const payload = await body(request)
    const message = stringField(payload, "message")
    const result = await input.core.continueConversation(taskId, message, {
      peer: record.peerId,
      origin: "app",
      signal: request.signal,
    })
    return json(result)
  }
  if (parts[3] === "cancel") {
    await input.core.cancelConversation(taskId, "canceled from control API")
    return json({ taskId, state: "TASK_STATE_CANCELED" })
  }
  throw new HttpError(404, "Not found")
}

async function peers(request: Request, parts: string[], input: AdminDeps): Promise<Response> {
  if (parts.length === 2) {
    if (request.method === "GET") return json({ peers: input.peers.list() })
    if (request.method === "POST") {
      const payload = await body(request)
      await input.peers.add(stringField(payload, "name"), stringField(payload, "url"))
      return json({ peers: input.peers.list() })
    }
    throw new HttpError(405, "Method not allowed")
  }
  const name = decodeURIComponent(parts[2])
  if (parts[3] === "test") {
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed")
    const url = input.config().allowedPeers[name]
    if (url === undefined) throw new HttpError(404, `Unknown A2A peer "${name}"`)
    const card = await fetchCard(url, input.testTimeoutMs ?? 5_000)
    return json({ peer: name, name: card.name, description: card.description })
  }
  if (request.method === "DELETE") {
    await input.peers.remove(name)
    return json({ peers: input.peers.list() })
  }
  throw new HttpError(404, "Not found")
}

async function fetchCard(url: string, timeoutMs: number): Promise<{ name: string; description: string }> {
  const response = await fetch(`${url.replace(/\/+$/, "")}/.well-known/agent-card.json`, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`agent card request failed with HTTP ${response.status}`)
  const parsed = AgentCardSchema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success) throw new Error(`invalid agent card from "${url}"`)
  return { name: parsed.data.name, description: parsed.data.description }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const parsed = await request.json().catch(() => undefined)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new HttpError(400, "Expected a JSON object body")
  return parsed as Record<string, unknown>
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${key} is required`)
  return value
}

function statusFor(message: string): number {
  if (message.startsWith("Unknown A2A peer") || message.startsWith("Unknown A2A task")) return 404
  if (/non-empty|Invalid URL|Invalid model|A2A is disabled|Expected a JSON/.test(message)) return 400
  return 502
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS })
}

function fail(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: CORS })
}
