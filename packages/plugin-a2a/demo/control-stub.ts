// Mock A2A-014 control plane for the TUI panel (A2A-016).
//
// Serves the documented /a2a/* contract on loopback in front of a REAL
// loopback A2A peer (the same inbound bridge the plugin runs, backed by a
// scripted runner instead of a model). Start it, then open the A2A panel in
// the TUI — the panel discovers this stub via .opencode/a2a/admin.port or
// OPENCODE_A2A_ADMIN_URL.
//
//   bun demo/control-stub.ts [--admin-port 0] [--peer-port 0] [--name stub-agent]
//
// Everything is in-memory: peer add/remove works but does not edit
// opencode.json — config write-back is A2A-014's job. When the real control
// plane lands, drop this file and let the panel find the plugin's own
// endpoint through the same discovery paths.

import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { A2AClient, type Artifact, type TaskState } from "a2a"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { ConversationStore, createAskTool } from "../src/ask.ts"
import type { A2AConfig } from "../src/config.ts"
import type { A2AEventEmitter } from "../src/events.ts"
import { startInboundServer } from "../src/inbound.ts"
import type { SessionRunner } from "../src/session.ts"
import { ADMIN_PORT_FILE } from "../src/control.ts"

type Turn = { index?: number; speaker?: "local" | "remote"; peerId?: string; content?: string }

type Row = {
  taskId: string
  direction: "outbound" | "inbound"
  peerId?: string
  origin: string
  state: TaskState
  content?: string
  artifact?: Artifact
  turns: Turn[]
  createdAt: number
  updatedAt: number
}

const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const adminPort = Number(flag("admin-port") ?? 0)
const peerPort = Number(flag("peer-port") ?? 0)
const selfName = flag("name") ?? "stub-agent"

// --- registry ------------------------------------------------------------

const rows = new Map<string, Row>()

// One emitter per perspective. Outbound events (our ask path) and inbound
// events (the peer bridge) both emit a2a.* for the same wire task when the
// conversation is loopback, and the inbound side fires first — its "local"
// speaker is the peer's reply, which is remote from the panel's view. The
// outbound dispatch therefore converts an inbound-created row: the ask
// path's own events re-record every turn with the panel's orientation.
const record = (direction: Row["direction"]): A2AEventEmitter => (type, properties) => {
  const props = properties as {
    taskId?: string
    peerId?: string
    state?: TaskState
    content?: string
    artifact?: Artifact
    speaker?: Turn["speaker"]
    turn?: number
  }
  const taskId = props.taskId
  if (!taskId) return
  let row = rows.get(taskId)
  if (!row) {
    if (type !== "a2a.task.dispatched") return
    row = {
      taskId,
      direction,
      peerId: props.peerId,
      origin: "stub",
      state: "TASK_STATE_SUBMITTED",
      turns: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    rows.set(taskId, row)
  }
  if (type === "a2a.task.dispatched" && direction === "outbound" && row.direction === "inbound") {
    row.direction = "outbound"
    row.peerId = props.peerId
    row.turns = []
  }
  if (row.direction !== direction) return
  if (type === "a2a.conversation.turn") {
    if (row.turns.some((turn) => turn.index === props.turn && turn.content === props.content)) return
    row.turns.push({ index: props.turn, speaker: props.speaker, peerId: props.peerId, content: props.content })
    row.turns.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  } else if (props.state) {
    row.state = props.state
    row.peerId ??= props.peerId
    row.content = props.content ?? row.content
    row.artifact = props.artifact ?? row.artifact
  }
  row.updatedAt = Date.now()
}

const toSession = (row: Row) => ({
  taskId: row.taskId,
  direction: row.direction,
  peerId: row.peerId,
  origin: row.origin,
  state: row.state,
  content: row.content,
  turns: row.turns.length,
  artifact: row.artifact,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

// --- loopback peer ---------------------------------------------------------

// Scripted stand-in for a model-backed peer: every turn echoes its input so
// the panel's thread view has something readable to show.
let runs = 0
const runner: SessionRunner = {
  async run(taskId, text, peer) {
    runs += 1
    return {
      sessionID: `ses_stub_${taskId}`,
      text: `stub reply ${runs} to “${text.slice(0, 60)}”${peer === undefined ? "" : ` (from ${peer})`}`,
    }
  },
  async abort() {},
}

// Unbounded by default so panel conversations run until someone cancels;
// A2A_STUB_TURNS=N restores a cap to exercise the verdict path.
const maxTurns = Number(process.env.A2A_STUB_TURNS ?? 0)
const config: A2AConfig = { enabled: true, name: selfName, listenPort: peerPort, allowedPeers: {}, maxTurns }
const inbound = startInboundServer({ config, runner, emit: record("inbound") })
const selfUrl = `http://127.0.0.1:${inbound.port}`
config.allowedPeers = { loop: selfUrl }

// --- outbound driver -------------------------------------------------------

const store = new ConversationStore()
const ask = createAskTool({ config, store, emit: record("outbound") })

const context: ToolContext = {
  sessionID: "ses_stub_control",
  messageID: "msg_stub_control",
  agent: "build",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata() {},
  ask: async () => {},
}

async function converse(peer: string, text: string, taskId?: string) {
  const url = config.allowedPeers[peer]
  if (!url) throw Object.assign(new Error(`Unknown A2A peer "${peer}"`), { status: 404 })
  const result = await ask.execute({ peer, message: text, ...(taskId === undefined ? {} : { taskId }) }, context)
  const reported = typeof result === "string" ? undefined : result.metadata?.taskId
  const id = typeof reported === "string" ? reported : taskId
  const row = id === undefined ? undefined : rows.get(id)
  if (!row) throw new Error(`peer "${peer}" did not create a task`)
  return row
}

// --- control API ------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const fail = (status: number, error: string) => json({ error }, status)

const server = Bun.serve({
  port: adminPort,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts[0] !== "a2a") return fail(404, "not found")
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    if (parts[1] === "sessions") {
      if (parts.length === 2 && request.method === "GET") {
        return json({ sessions: [...rows.values()].map(toSession) })
      }
      const row = rows.get(decodeURIComponent(parts[2] ?? ""))
      if (!row || request.method !== "GET") return fail(404, "unknown task")
      return json({ session: toSession(row), turns: row.turns })
    }

    if (parts[1] === "conversations") {
      if (parts.length === 2 && request.method === "POST") {
        const peer = typeof body.peer === "string" ? body.peer : ""
        const message = typeof body.text === "string" ? body.text : ""
        if (!peer || !message.trim()) return fail(400, "peer and text are required")
        try {
          return json({ session: toSession(await converse(peer, message)) }, 201)
        } catch (error) {
          return fail(
            (error as { status?: number }).status ?? 502,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
      const row = rows.get(decodeURIComponent(parts[2] ?? ""))
      if (!row) return fail(404, "unknown task")
      if (parts[3] === "messages" && request.method === "POST") {
        const message = typeof body.text === "string" ? body.text : ""
        if (!message.trim()) return fail(400, "text is required")
        if (row.direction === "inbound") return fail(400, "cannot send on an inbound task")
        const peer = row.peerId ?? ""
        if (!peer || !config.allowedPeers[peer]) return fail(400, `no URL known for peer "${peer}"`)
        try {
          return json({ session: toSession(await converse(peer, message, row.taskId)) })
        } catch (error) {
          return fail(502, error instanceof Error ? error.message : String(error))
        }
      }
      if (parts[3] === "cancel" && request.method === "POST") {
        const target = row.direction === "outbound" ? config.allowedPeers[row.peerId ?? ""] : selfUrl
        if (!target) return fail(400, `no URL known for peer "${row.peerId}"`)
        try {
          await new A2AClient({ baseUrl: target }).cancelTask(row.taskId)
        } catch (error) {
          return fail(502, error instanceof Error ? error.message : String(error))
        }
        row.state = "TASK_STATE_CANCELED"
        row.updatedAt = Date.now()
        return json({ session: toSession(row) })
      }
      return fail(404, "not found")
    }

    if (parts[1] === "peers") {
      if (parts.length === 2) {
        if (request.method === "GET") {
          return json({
            peers: Object.entries(config.allowedPeers).map(([name, url]) => ({ name, url })),
            self: { name: config.name, port: inbound.port, enabled: true },
            writable: true,
          })
        }
        if (request.method === "POST") {
          const name = typeof body.name === "string" ? body.name.trim() : ""
          const peer = typeof body.url === "string" ? body.url.trim() : ""
          if (!name) return fail(400, "name is required")
          try {
            new URL(peer)
          } catch {
            return fail(400, `Invalid URL for A2A peer "${name}": ${peer}`)
          }
          config.allowedPeers[name] = peer
          return json({ name, url: peer }, 201)
        }
      }
      const name = decodeURIComponent(parts[2] ?? "")
      const url = config.allowedPeers[name]
      if (url === undefined) return fail(404, `unknown peer "${name}"`)
      if (parts.length === 3 && request.method === "DELETE") {
        delete config.allowedPeers[name]
        return new Response(undefined, { status: 204 })
      }
      if (parts[3] === "test" && request.method === "POST") {
        try {
          const card = await new A2AClient({ baseUrl: url }).fetchAgentCard()
          return json({ ok: true, name: card.name })
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return fail(404, "not found")
    }

    return fail(404, "not found")
  },
})

// --- discovery ---------------------------------------------------------------

// The panel's port-file discovery reads .opencode/a2a/admin.port under the
// project dir, matching the planned plugin-hosted admin endpoint.
const portFile = path.join(process.cwd(), ADMIN_PORT_FILE)
mkdirSync(path.dirname(portFile), { recursive: true })
rmSync(portFile, { force: true })
await Bun.write(portFile, String(server.port))

const shutdown = () => {
  rmSync(portFile, { force: true })
  server.stop(true)
  inbound.stop()
}
process.on("SIGINT", () => {
  shutdown()
  process.exit(0)
})
process.on("SIGTERM", () => {
  shutdown()
  process.exit(0)
})

console.log(`a2a control stub`)
console.log(`  admin:  http://127.0.0.1:${server.port}   (wrote ${portFile})`)
console.log(`  peer:   ${selfUrl}   (allowedPeers entry "loop", agent card name "${selfName}")`)
console.log(`  panel:  run "A2A: Sessions" in the TUI, or export OPENCODE_A2A_ADMIN_URL=http://127.0.0.1:${server.port}`)
