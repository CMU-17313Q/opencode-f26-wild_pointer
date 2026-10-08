import path from "node:path"
import { z } from "zod"
import { ArtifactSchema, SpeakerSchema, TaskStateSchema } from "a2a"

// Local control plane contract (A2A-014). The TUI panel talks to these
// endpoints over loopback HTTP and nowhere else — the plugin never imports
// server-side modules into its TUI target. Two transports are planned:
// routes on the local opencode server, or a loopback admin endpoint hosted by
// the plugin whose port lands in .opencode/a2a/admin.port. This client works
// with either; resolveControl() probes candidates in order.
//
//   GET    /a2a/sessions                      { sessions: Session[] }
//   GET    /a2a/sessions/:taskId              { session: Session, turns: Turn[] }
//   POST   /a2a/conversations                 { peer, text } -> Session
//   POST   /a2a/conversations/:taskId/messages { text } -> Session
//   POST   /a2a/conversations/:taskId/cancel  -> Session
//   GET    /a2a/peers                         { peers, self?, writable?, hint? }
//   POST   /a2a/peers                         { name, url }
//   DELETE /a2a/peers/:name
//   POST   /a2a/peers/:name/test              { ok, name?, error? }

export const ADMIN_PORT_FILE = path.join(".opencode", "a2a", "admin.port")
export const ADMIN_URL_ENV = "OPENCODE_A2A_ADMIN_URL"

const Timestampish = z.union([z.number(), z.string()])

// Every task this instance knows about, both directions (the A2A-014
// registry row). Optional fields stay optional so older/partial
// implementations still parse.
export const ControlSessionSchema = z.object({
  taskId: z.string(),
  direction: z.enum(["outbound", "inbound"]).optional(),
  peerId: z.string().optional(),
  origin: z.string().optional(),
  state: TaskStateSchema.optional().default("TASK_STATE_UNSPECIFIED"),
  turns: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  // Status text from the last transition — the turn-cap message lands here.
  content: z.string().optional(),
  // The verdict the task produced, when it produced one.
  artifact: ArtifactSchema.optional(),
  createdAt: Timestampish.optional(),
  updatedAt: Timestampish.optional(),
})
export type ControlSession = z.infer<typeof ControlSessionSchema>

// One message in a task thread. `content` matches the a2a.conversation.turn
// event vocabulary; `text` is accepted for simple implementations.
export const ControlTurnSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  speaker: SpeakerSchema.optional().default("remote"),
  peerId: z.string().optional(),
  content: z.string().optional(),
  text: z.string().optional(),
})
export type ControlTurn = z.infer<typeof ControlTurnSchema>

const SessionsResponseSchema = z.union([
  z.object({ sessions: z.array(ControlSessionSchema) }),
  z.array(ControlSessionSchema).transform((sessions) => ({ sessions })),
])

const SessionDetailSchema = z.union([
  z
    .object({ session: ControlSessionSchema, turns: z.array(ControlTurnSchema).optional() })
    .transform((detail) => ({ session: detail.session, turns: detail.turns ?? [] })),
  ControlSessionSchema.transform((session) => ({ session, turns: [] as ControlTurn[] })),
])
export type SessionDetail = z.infer<typeof SessionDetailSchema>

const SessionResultSchema = z.union([
  ControlSessionSchema,
  z.object({ session: ControlSessionSchema }).transform((value) => value.session),
])

export const ControlPeerSchema = z.object({
  name: z.string(),
  url: z.string(),
})
export type ControlPeer = z.infer<typeof ControlPeerSchema>

const PeersResponseSchema = z.object({
  peers: z.array(ControlPeerSchema).optional().default([]),
  // Own identity + listener status for the peers dashboard.
  self: z
    .object({
      name: z.string().optional(),
      port: z.number().optional(),
      enabled: z.boolean().optional(),
    })
    .optional(),
  // False when allowedPeers can't be edited through the API (env-only enable,
  // read-only config); `hint` then tells the user what to edit by hand.
  writable: z.boolean().optional(),
  hint: z.string().optional(),
})
export type PeersInfo = z.infer<typeof PeersResponseSchema>

const PeerTestSchema = z.object({
  ok: z.boolean().optional().default(false),
  // The peer's claimed agent-card name — may differ from the local
  // allowedPeers key, which is only a local label (A2A-013).
  name: z.string().optional(),
  error: z.string().optional(),
})
export type PeerTest = z.infer<typeof PeerTestSchema>

export class ControlError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "ControlError"
    this.status = status
  }
}

export type ControlFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface A2AControl {
  sessions(): Promise<ControlSession[]>
  session(taskId: string): Promise<SessionDetail>
  start(peer: string, text: string): Promise<ControlSession>
  reply(taskId: string, text: string): Promise<ControlSession>
  cancel(taskId: string): Promise<ControlSession>
  peers(): Promise<PeersInfo>
  addPeer(name: string, url: string): Promise<void>
  removePeer(name: string): Promise<void>
  testPeer(name: string): Promise<PeerTest>
}

export function createControl(base: string, fetcher: ControlFetch = fetch): A2AControl {
  const origin = base.replace(/\/+$/, "")

  async function request<T>(method: string, route: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let response: Response
    try {
      response = await fetcher(`${origin}${route}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      throw new ControlError(error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) throw new ControlError(await errorText(response), response.status)
    if (response.status === 204) return schema.parse(undefined)
    const parsed = schema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) throw new ControlError(`unexpected response from ${route}`, response.status)
    return parsed.data
  }

  return {
    sessions: async () => (await request("GET", "/a2a/sessions", undefined, SessionsResponseSchema)).sessions,
    session: (taskId) => request("GET", `/a2a/sessions/${encodeURIComponent(taskId)}`, undefined, SessionDetailSchema),
    start: (peer, text) => request("POST", "/a2a/conversations", { peer, text }, SessionResultSchema),
    reply: (taskId, text) =>
      request("POST", `/a2a/conversations/${encodeURIComponent(taskId)}/messages`, { text }, SessionResultSchema),
    cancel: (taskId) =>
      request("POST", `/a2a/conversations/${encodeURIComponent(taskId)}/cancel`, undefined, SessionResultSchema),
    peers: () => request("GET", "/a2a/peers", undefined, PeersResponseSchema),
    addPeer: async (name, url) => {
      await request("POST", "/a2a/peers", { name, url }, z.unknown())
    },
    removePeer: async (name) => {
      await request("DELETE", `/a2a/peers/${encodeURIComponent(name)}`, undefined, z.unknown())
    },
    testPeer: (name) => request("POST", `/a2a/peers/${encodeURIComponent(name)}/test`, undefined, PeerTestSchema),
  }
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "")
  const parsed = z
    .object({ error: z.union([z.string(), z.object({ message: z.string() })]) })
    .or(z.object({ message: z.string() }))
    .safeParse(safeJson(text))
  if (parsed.success) {
    const value = "error" in parsed.data ? parsed.data.error : parsed.data.message
    return typeof value === "string" ? value : value.message
  }
  return text || `HTTP ${response.status}`
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export type ControlSource = {
  base: string
  via: "env" | "server" | "port-file"
}

// Candidates in order:
//   1. OPENCODE_A2A_ADMIN_URL — explicit dev/test override (points at the
//      demo control stub today; also covers non-standard layouts).
//   2. The opencode server's own /a2a/* routes — the preferred A2A-014
//      transport, reached through the same base URL the TUI already uses.
//   3. .opencode/a2a/admin.port under the project/worktree dir — the
//      plugin-hosted loopback fallback.
export async function resolveControl(input: {
  env?: Record<string, string | undefined>
  serverUrl?: string
  directories?: readonly string[]
  fetcher?: ControlFetch
  probeMs?: number
}): Promise<ControlSource | undefined> {
  const fetcher = input.fetcher ?? fetch
  const candidates: { base: string; via: ControlSource["via"] }[] = []

  const env = input.env?.[ADMIN_URL_ENV]
  if (env) candidates.push({ base: env, via: "env" })
  if (input.serverUrl) candidates.push({ base: input.serverUrl, via: "server" })
  for (const directory of input.directories ?? []) {
    const file = Bun.file(path.join(directory, ADMIN_PORT_FILE))
    const text = await file.text().catch(() => undefined)
    const port = Number(text?.trim())
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      candidates.push({ base: `http://127.0.0.1:${port}`, via: "port-file" })
    }
  }

  for (const candidate of candidates) {
    try {
      new URL(candidate.base)
    } catch {
      continue
    }
    const ok = await probe(candidate.base, fetcher, input.probeMs ?? 1500)
    if (ok) return candidate
  }
  return undefined
}

// A base is only usable when the control API actually answers on it — a
// stale admin.port file or an older server build both fail the probe.
async function probe(base: string, fetcher: ControlFetch, ms: number): Promise<boolean> {
  try {
    const response = await fetcher(`${base.replace(/\/+$/, "")}/a2a/sessions`, {
      signal: AbortSignal.timeout(ms),
    })
    return response.ok
  } catch {
    return false
  }
}
