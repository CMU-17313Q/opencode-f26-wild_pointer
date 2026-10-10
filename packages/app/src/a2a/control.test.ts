import { describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { A2AControlError, pluginIdentityFromConfig, createA2AControl, type A2ASessionRecord, type FetchLike } from "./control"

// happy-dom replaces globalThis.fetch with a webview-flavoured implementation
// that cannot talk to a local fixture; the native one can.
const nativeFetch = (Bun as unknown as { fetch: FetchLike }).fetch

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void

async function serve(handler: Handler) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk as Buffer))
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port: String(port),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(payload))
}

function control(port: string | undefined, fetch: FetchLike = nativeFetch) {
  let reads = 0
  const client = createA2AControl({
    directory: "/project",
    readPort: async () => {
      reads += 1
      return port
    },
    fetch,
    cache: new Map(),
  })
  return { client, reads: () => reads }
}

describe("createA2AControl", () => {
  test("lists sessions and caches the resolved port", async () => {
    const records: A2ASessionRecord[] = [
      {
        taskId: "t1",
        direction: "outbound",
        origin: "app",
        state: "TASK_STATE_WORKING",
        turns: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    ]
    const server = await serve((req, res) => {
      expect(req.method).toBe("GET")
      expect(req.url).toBe("/a2a/sessions")
      sendJson(res, 200, records)
    })
    try {
      const { client, reads } = control(server.port)
      expect(await client.listSessions()).toEqual(records)
      expect(await client.listSessions()).toEqual(records)
      expect(reads()).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("extracts the server {error} message and status", async () => {
    const server = await serve((_req, res) => sendJson(res, 404, { error: 'Unknown A2A task "gone"' }))
    try {
      const { client } = control(server.port)
      const error = await client.getSession("gone").catch((e: unknown) => e)
      expect(error).toBeInstanceOf(A2AControlError)
      expect((error as A2AControlError).kind).toBe("http")
      expect((error as A2AControlError).status).toBe(404)
      expect((error as A2AControlError).message).toBe('Unknown A2A task "gone"')
    } finally {
      await server.stop()
    }
  })

  test("posts conversations with origin app and parses the result", async () => {
    const server = await serve((req, res, body) => {
      expect(req.method).toBe("POST")
      expect(req.url).toBe("/a2a/conversations")
      expect(JSON.parse(body)).toEqual({ origin: "app", peer: "agent-a", message: "hi" })
      sendJson(res, 200, { peerId: "agent-a", taskId: "t9", state: "TASK_STATE_COMPLETED", reply: "hello" })
    })
    try {
      const { client } = control(server.port)
      const result = await client.startConversation({ peer: "agent-a", message: "hi" })
      expect(result.taskId).toBe("t9")
      expect(result.reply).toBe("hello")
    } finally {
      await server.stop()
    }
  })

  test("re-reads a stale port once when a request fails at the network level", async () => {
    const moved: A2ASessionRecord[] = [
      {
        taskId: "t2",
        direction: "outbound",
        origin: "app",
        state: "TASK_STATE_WORKING",
        turns: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    ]
    const first = await serve((_req, res) => sendJson(res, 200, []))
    const second = await serve((_req, res) => sendJson(res, 200, moved))

    let current = first.port
    let reads = 0
    const client = createA2AControl({
      directory: "/project",
      readPort: async () => {
        reads += 1
        return current
      },
      fetch: nativeFetch,
      cache: new Map(),
    })

    try {
      // Prime the cache against the first server, then let that port die.
      expect(await client.listSessions()).toEqual([])
      await first.stop()
      current = second.port
      // The cached dead port forces a re-read before the retry succeeds.
      expect(await client.listSessions()).toEqual(moved)
      expect(reads).toBe(2)
    } finally {
      await second.stop()
    }
  })

  test("surfaces a network failure after one retry", async () => {
    const server = await serve((_req, res) => sendJson(res, 200, []))
    const dead = server.port
    await server.stop()

    const { client, reads } = control(dead)
    const error = await client.listSessions().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(A2AControlError)
    expect((error as A2AControlError).kind).toBe("network")
    expect(reads()).toBe(2)
  })

  test("reports a missing port file", async () => {
    const { client } = control(undefined)
    const error = await client.listPeers().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(A2AControlError)
    expect((error as A2AControlError).kind).toBe("port")
  })

  test("maps every peer and cancel endpoint", async () => {
    const seen: { method: string; url: string; body?: unknown }[] = []
    const server = await serve((req, res, body) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body: body ? JSON.parse(body) : undefined })
      if (req.url === "/a2a/peers" && req.method === "GET") return sendJson(res, 200, { peers: [] })
      if (req.url === "/a2a/peers" && req.method === "POST")
        return sendJson(res, 200, { peers: [{ name: "agent-a", url: "http://a" }] })
      if (req.url === "/a2a/peers/agent-a" && req.method === "DELETE") return sendJson(res, 200, { peers: [] })
      if (req.url === "/a2a/peers/agent-a/test" && req.method === "POST")
        return sendJson(res, 200, { peer: "agent-a", name: "Agent A", description: "helpful" })
      if (req.url === "/a2a/conversations/t1/messages")
        return sendJson(res, 200, { peerId: "agent-a", state: "TASK_STATE_INPUT_REQUIRED" })
      if (req.url === "/a2a/conversations/t1/cancel")
        return sendJson(res, 200, { taskId: "t1", state: "TASK_STATE_CANCELED" })
      sendJson(res, 404, { error: `unexpected ${req.method} ${req.url}` })
    })
    try {
      const { client } = control(server.port)
      expect(await client.listPeers()).toEqual([])
      expect(await client.addPeer("agent-a", "http://a")).toEqual([{ name: "agent-a", url: "http://a" }])
      expect(await client.removePeer("agent-a")).toEqual([])
      expect(await client.testPeer("agent-a")).toEqual({ peer: "agent-a", name: "Agent A", description: "helpful" })
      expect(await client.sendMessage("t1", "more")).toEqual({
        peerId: "agent-a",
        state: "TASK_STATE_INPUT_REQUIRED",
      })
      expect(await client.cancelConversation("t1")).toEqual({ taskId: "t1", state: "TASK_STATE_CANCELED" })
      expect(seen.find((entry) => entry.url === "/a2a/peers/agent-a/test")?.body).toBeUndefined()
      expect(seen.find((entry) => entry.url === "/a2a/conversations/t1/messages")?.body).toEqual({ message: "more" })
    } finally {
      await server.stop()
    }
  })
})

describe("pluginIdentityFromConfig", () => {
  test("reads the a2a name out of the plugin options tuple", () => {
    const text = JSON.stringify({
      plugin: [["./packages/plugin-a2a", { a2a: { enabled: true, name: "agent-b" } }]],
    })
    expect(pluginIdentityFromConfig(text)).toBe("agent-b")
  })

  test("returns undefined for missing, unparsable, or unrelated configs", () => {
    expect(pluginIdentityFromConfig(undefined)).toBeUndefined()
    expect(pluginIdentityFromConfig("{ not json")).toBeUndefined()
    expect(pluginIdentityFromConfig(JSON.stringify({ plugin: ["./other"] }))).toBeUndefined()
    expect(pluginIdentityFromConfig(JSON.stringify({ plugin: [["./x", { other: 1 }]] }))).toBeUndefined()
  })
})
