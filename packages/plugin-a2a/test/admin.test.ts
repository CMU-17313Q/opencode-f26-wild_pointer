// A2A-014: the loopback-only admin control API is the zero-core-edit transport
// the Desktop and TUI UIs call. These tests drive it over real HTTP against the
// scripted inbound bridge.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startAdminServer, type AdminServer } from "../src/admin.ts"
import { createCanceller } from "../src/cancel.ts"
import { CAP_MESSAGE, resolveConfig, type A2AConfig } from "../src/config.ts"
import { createConversationCore, ConversationStore } from "../src/conversation.ts"
import { createPeerManager, type PeerManager } from "../src/peers.ts"
import { createConversationRegistry, type Registry, type TaskRecord } from "../src/registry.ts"
import { fakeRunner, startBridge } from "./bridge.ts"

type ConversationBody = {
  taskId?: string
  peerId?: string
  state: string
  turn?: number
  reply?: string
  message?: string
  capped?: boolean
}
type PeersBody = { peers: Array<{ name: string; url: string }> }
type CardBody = { peer: string; name: string; description: string }

type Harness = {
  baseUrl: string
  server: AdminServer
  registry: Registry
  configRef: { current: A2AConfig }
  manager: PeerManager
  root: string
  close: () => Promise<void>
}

async function harness(
  options: { peers?: Record<string, string>; name?: string; maxTurns?: number; replies?: string[]; listenPort?: number } = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "a2a-admin-"))
  const fixture = join(root, "opencode.json")
  writeFileSync(fixture, `{ "plugin": [["plugin-a2a", { "a2a": { "enabled": true } }]] }`, "utf8")
  const fake = fakeRunner({ replies: options.replies ?? ["pong"] })
  const overrides: Partial<A2AConfig> = { name: options.name ?? "agent-b" }
  if (options.maxTurns !== undefined) overrides.maxTurns = options.maxTurns
  const bridge = startBridge(fake.runner, overrides)
  const registry = createConversationRegistry({ file: join(root, "sessions.json") })
  await registry.load()
  const store = new ConversationStore()
  const emit = () => undefined
  const cancel = createCanceller({ store, emit })
  const peers = options.peers ?? { "agent-b": bridge.baseUrl }
  const configRef = {
    current: resolveConfig({
      options: { enabled: true, allowedPeers: peers, name: options.name ?? "agent-b", listenPort: options.listenPort },
      env: {},
    }),
  }
  const manager = createPeerManager({
    files: [fixture],
    config: () => configRef.current,
    resolve: (edit) => resolveConfig({ options: edit, env: {} }),
    apply: (next) => {
      configRef.current = next
    },
  })
  const core = createConversationCore({ config: () => configRef.current, store, emit, cancel, registry })
  const server = await startAdminServer({
    registry,
    core,
    peers: manager,
    config: () => configRef.current,
    inboundPort: () => options.listenPort,
    portFile: join(root, "admin.port"),
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    server,
    registry,
    configRef,
    manager,
    root,
    close: async () => {
      await server.stop()
      bridge.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function post<T>(url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url)
  return { status: response.status, body: (await response.json()) as T }
}

describe("admin control API", () => {
  test("binds loopback only and writes the port file", async () => {
    const h = await harness()
    try {
      expect(h.server.hostname).toBe("127.0.0.1")
      expect(h.server.port).toBeGreaterThan(0)
      const portFile = join(h.root, "admin.port")
      expect(readFileSync(portFile, "utf8")).toBe(String(h.server.port))
      await h.server.stop()
      expect(existsSync(portFile)).toBe(false)
    } finally {
      await h.close()
    }
  })

  test("GET /a2a/self reports the inbound socket a peer should add", async () => {
    const h = await harness({ name: "agent-b", listenPort: 4000 })
    try {
      const { status, body } = await get<{ enabled: boolean; name?: string; listenPort: number; url?: string }>(
        `${h.baseUrl}/a2a/self`,
      )
      expect(status).toBe(200)
      expect(body.enabled).toBe(true)
      expect(body.name).toBe("agent-b")
      expect(body.listenPort).toBe(4000)
      expect(body.url).toBe("http://localhost:4000")
    } finally {
      await h.close()
    }
  })

  test("GET /a2a/sessions reflects a scripted exchange", async () => {
    const h = await harness({ replies: ["pong"] })
    try {
      const started = await post<ConversationBody>(`${h.baseUrl}/a2a/conversations`, {
        peer: "agent-b",
        message: "ping",
      })
      expect(started.status).toBe(200)
      expect(started.body.state).toBe("TASK_STATE_INPUT_REQUIRED")

      const sessions = await get<TaskRecord[]>(`${h.baseUrl}/a2a/sessions`)
      expect(sessions.status).toBe(200)
      expect(sessions.body).toHaveLength(1)
      expect(sessions.body[0]).toMatchObject({
        taskId: started.body.taskId,
        direction: "outbound",
        origin: "app",
        peerId: "agent-b",
        state: "TASK_STATE_INPUT_REQUIRED",
        turns: 2,
      })

      const one = await get<TaskRecord>(`${h.baseUrl}/a2a/sessions/${String(started.body.taskId)}`)
      expect(one.status).toBe(200)
      expect(one.body.taskId).toBe(String(started.body.taskId))
    } finally {
      await h.close()
    }
  })

  test("POST /a2a/conversations drives a full exchange including the cap", async () => {
    const h = await harness({ replies: ["one", "two"], maxTurns: 4 })
    try {
      const first = await post<ConversationBody>(`${h.baseUrl}/a2a/conversations`, {
        peer: "agent-b",
        message: "first",
      })
      expect(first.body.state).toBe("TASK_STATE_INPUT_REQUIRED")
      const taskId = String(first.body.taskId)

      const second = await post<ConversationBody>(`${h.baseUrl}/a2a/conversations/${taskId}/messages`, {
        message: "second",
      })
      expect(second.status).toBe(200)
      expect(second.body.taskId).toBe(taskId)
      expect(second.body.state).toBe("TASK_STATE_COMPLETED")
      expect(second.body.reply).toBe(CAP_MESSAGE)

      // Our own cap stops a further turn before it hits the network.
      const third = await post<ConversationBody>(`${h.baseUrl}/a2a/conversations/${taskId}/messages`, {
        message: "third",
      })
      expect(third.body.capped).toBe(true)
      expect(third.body.message).toBe(CAP_MESSAGE)
      expect(third.body.state).toBe("TASK_STATE_COMPLETED")
    } finally {
      await h.close()
    }
  })

  test("POST cancel settles the task CANCELED", async () => {
    const h = await harness({ replies: ["pong"] })
    try {
      const started = await post<ConversationBody>(`${h.baseUrl}/a2a/conversations`, {
        peer: "agent-b",
        message: "ping",
      })
      const taskId = String(started.body.taskId)

      const canceled = await post<{ taskId: string; state: string }>(
        `${h.baseUrl}/a2a/conversations/${taskId}/cancel`,
      )
      expect(canceled.status).toBe(200)
      expect(canceled.body.state).toBe("TASK_STATE_CANCELED")

      const record = await get<TaskRecord>(`${h.baseUrl}/a2a/sessions/${taskId}`)
      expect(record.body.state).toBe("TASK_STATE_CANCELED")
    } finally {
      await h.close()
    }
  })

  test("peers CRUD over HTTP", async () => {
    const h = await harness({ peers: {} })
    try {
      const empty = await get<PeersBody>(`${h.baseUrl}/a2a/peers`)
      expect(empty.body.peers).toEqual([])

      const added = await post<PeersBody>(`${h.baseUrl}/a2a/peers`, {
        name: "agent-c",
        url: "http://localhost:3333",
      })
      expect(added.status).toBe(200)
      expect(added.body.peers).toEqual([{ name: "agent-c", url: "http://localhost:3333" }])

      const after = await get<PeersBody>(`${h.baseUrl}/a2a/peers`)
      expect(after.body.peers).toEqual([{ name: "agent-c", url: "http://localhost:3333" }])

      const removed = await fetch(`${h.baseUrl}/a2a/peers/agent-c`, { method: "DELETE" })
      expect(removed.status).toBe(200)
      expect(((await removed.json()) as PeersBody).peers).toEqual([])
    } finally {
      await h.close()
    }
  })

  test("POST /a2a/peers/:name/test returns the live agent-card name", async () => {
    const h = await harness({ name: "agent-b" })
    try {
      const result = await post<CardBody>(`${h.baseUrl}/a2a/peers/agent-b/test`)
      expect(result.status).toBe(200)
      expect(result.body.peer).toBe("agent-b")
      expect(result.body.name).toBe("agent-b")
      expect(typeof result.body.description).toBe("string")
    } finally {
      await h.close()
    }
  })

  test("bad input and unknown resources return 4xx", async () => {
    const h = await harness({ peers: {} })
    try {
      const missing = await post<{ error: string }>(`${h.baseUrl}/a2a/conversations`, { peer: "agent-b" })
      expect(missing.status).toBe(400)

      const unknownPeer = await post<{ error: string }>(`${h.baseUrl}/a2a/conversations`, {
        peer: "ghost",
        message: "hi",
      })
      expect(unknownPeer.status).toBe(404)

      const unknownSession = await get<{ error: string }>(`${h.baseUrl}/a2a/sessions/nope`)
      expect(unknownSession.status).toBe(404)

      const badUrl = await post<{ error: string }>(`${h.baseUrl}/a2a/peers`, {
        name: "agent-c",
        url: "not a url",
      })
      expect(badUrl.status).toBe(400)
    } finally {
      await h.close()
    }
  })
})
