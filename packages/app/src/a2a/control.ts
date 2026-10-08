// Typed client for the plugin-a2a loopback control API (A2A-014). The plugin
// hosts an ephemeral admin server and writes its port to
// `<directory>/.opencode/a2a/admin.port`; this module turns that into typed
// calls the Desktop UI can use without depending on plugin internals.
//
// The module is deliberately free of Solid imports so it stays testable: the
// port reader and fetch implementation are injected, and the cached port is
// refreshed once when a request fails at the network level (the plugin may have
// restarted on a new ephemeral port).

import type { TaskState } from "a2a"

export const ADMIN_PORT_PATH = ".opencode/a2a/admin.port"

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

// GET /a2a/sessions and GET /a2a/sessions/:taskId. Timestamps are epoch ms.
export interface A2ASessionRecord {
  taskId: string
  direction: "outbound" | "inbound"
  origin: "tool" | "tui" | "app" | "peer"
  peerId?: string
  state: TaskState
  turns: number
  sessionId?: string
  message?: string
  createdAt: number
  updatedAt: number
}

export interface A2APeer {
  name: string
  url: string
}

export interface A2AConversationResult {
  peerId: string
  taskId?: string
  turn?: number
  reply?: string
  artifact?: string
  message?: string
  state: TaskState
  capped?: boolean
  terminal?: boolean
}

export interface A2APeerTestResult {
  peer: string
  name: string
  description: string
}

// `kind` lets the UI localize the failure; `message` carries the plugin's own
// `{error}` text when it provided one (already human-readable).
export type A2AControlErrorKind = "port" | "network" | "http"

export class A2AControlError extends Error {
  constructor(
    readonly kind: A2AControlErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "A2AControlError"
  }
}

export interface A2AControlOptions {
  directory: string
  readPort: (directory: string) => Promise<string | undefined>
  fetch?: FetchLike
  // Shared across clients by default so the port survives component churn; tests
  // pass a private map to stay isolated.
  cache?: Map<string, string>
}

const defaultCache = new Map<string, string>()

const HOST = "127.0.0.1"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createA2AControl(options: A2AControlOptions) {
  const fetchFn = options.fetch ?? globalThis.fetch
  const cache = options.cache ?? defaultCache
  const directory = options.directory

  const resolvePort = async (force: boolean): Promise<string> => {
    if (!force) {
      const cached = cache.get(directory)
      if (cached !== undefined) return cached
    }
    const text = await options.readPort(directory).catch(() => undefined)
    const port = text?.trim()
    if (!port) throw new A2AControlError("port", "A2A control port is unavailable")
    cache.set(directory, port)
    return port
  }

  const readError = async (response: Response): Promise<string> => {
    const parsed = await response.json().catch(() => undefined)
    if (isRecord(parsed) && typeof parsed.error === "string" && parsed.error !== "") return parsed.error
    return `HTTP ${response.status}`
  }

  const readJson = async <T>(response: Response): Promise<T> => {
    const parsed = await response.json().catch(() => undefined)
    if (parsed === undefined) throw new A2AControlError("http", `HTTP ${response.status}`, response.status)
    return parsed as T
  }

  const once = async <T>(path: string, init: RequestInit): Promise<T> => {
    const port = await resolvePort(false)
    const response = await fetchFn(`http://${HOST}:${port}${path}`, init)
    if (!response.ok) throw new A2AControlError("http", await readError(response), response.status)
    return readJson<T>(response)
  }

  const run = async <T>(path: string, init: RequestInit): Promise<T> => {
    try {
      return await once<T>(path, init)
    } catch (error) {
      if (error instanceof A2AControlError) throw error
      // A rejected fetch can mean the port moved; re-read it once and retry.
      cache.delete(directory)
      try {
        return await once<T>(path, init)
      } catch (retry) {
        if (retry instanceof A2AControlError) throw retry
        throw new A2AControlError("network", retry instanceof Error ? retry.message : String(retry))
      }
    }
  }

  const jsonInit = (method: string, body: Record<string, unknown>): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  return {
    directory,
    listSessions: () => run<A2ASessionRecord[]>("/a2a/sessions", { method: "GET" }),
    getSession: (taskId: string) =>
      run<A2ASessionRecord>(`/a2a/sessions/${encodeURIComponent(taskId)}`, { method: "GET" }),
    startConversation: (input: { peer: string; message: string; origin?: "app" | "tui" }) =>
      run<A2AConversationResult>("/a2a/conversations", jsonInit("POST", { origin: "app", ...input })),
    sendMessage: (taskId: string, message: string) =>
      run<A2AConversationResult>(
        `/a2a/conversations/${encodeURIComponent(taskId)}/messages`,
        jsonInit("POST", { message }),
      ),
    cancelConversation: (taskId: string) =>
      run<{ taskId: string; state: TaskState }>(
        `/a2a/conversations/${encodeURIComponent(taskId)}/cancel`,
        { method: "POST" },
      ),
    listPeers: () => run<{ peers: A2APeer[] }>("/a2a/peers", { method: "GET" }).then((x) => x.peers),
    addPeer: (name: string, url: string) =>
      run<{ peers: A2APeer[] }>("/a2a/peers", jsonInit("POST", { name, url })).then((x) => x.peers),
    removePeer: (name: string) =>
      run<{ peers: A2APeer[] }>(`/a2a/peers/${encodeURIComponent(name)}`, { method: "DELETE" }).then((x) => x.peers),
    testPeer: (name: string) =>
      run<A2APeerTestResult>(`/a2a/peers/${encodeURIComponent(name)}/test`, { method: "POST" }),
  }
}

export type A2AControl = ReturnType<typeof createA2AControl>

// Best-effort read of this directory's plugin identity. opencode.json nests the
// A2A options inside the plugin tuple; there is no config API for plugin options
// yet, so an unparsable or absent file means "unknown" rather than an error.
export function pluginIdentityFromConfig(text: string | undefined): string | undefined {
  if (!text) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.plugin)) return undefined
  for (const entry of parsed.plugin) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const opts = entry[1]
    if (!isRecord(opts) || !isRecord(opts.a2a)) continue
    const name = opts.a2a.name
    if (typeof name === "string" && name.trim() !== "") return name.trim()
  }
  return undefined
}
