import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ADMIN_PORT_FILE, ControlError, createControl, resolveControl } from "../src/control.ts"

// A real Bun.serve standing in for the A2A-014 control API — same contract
// the panel consumes, no mocked implementation.
type Call = { method: string; path: string; body?: unknown }

function stub(handler?: (call: Call) => Response | undefined) {
  const calls: Call[] = []
  const sessions = [
    {
      taskId: "task-1",
      direction: "outbound",
      peerId: "loop",
      state: "TASK_STATE_WORKING",
      turns: 2,
      createdAt: 1000,
      updatedAt: 2000,
    },
  ]
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      const call: Call = {
        method: request.method,
        path: url.pathname,
        body: request.method === "GET" || request.method === "DELETE" ? undefined : await request.json().catch(() => undefined),
      }
      calls.push(call)
      const custom = handler?.(call)
      if (custom) return custom
      if (call.path === "/a2a/sessions" && call.method === "GET") return Response.json({ sessions })
      if (call.path === "/a2a/sessions/task-1" && call.method === "GET")
        return Response.json({
          session: sessions[0],
          turns: [{ index: 0, speaker: "local", content: "hello" }],
        })
      if (call.path === "/a2a/conversations" && call.method === "POST")
        return Response.json({ session: sessions[0] }, { status: 201 })
      if (call.path.startsWith("/a2a/conversations/") && call.method === "POST")
        return Response.json({ session: sessions[0] })
      if (call.path === "/a2a/peers" && call.method === "GET")
        return Response.json({
          peers: [{ name: "loop", url: "http://127.0.0.1:4322" }],
          self: { name: "stub-agent", port: 4322, enabled: true },
          writable: true,
        })
      if (call.path === "/a2a/peers" && call.method === "POST") return Response.json(call.body, { status: 201 })
      if (call.path === "/a2a/peers/loop/test" && call.method === "POST")
        return Response.json({ ok: true, name: "stub-agent" })
      if (call.path.startsWith("/a2a/peers/") && call.method === "DELETE")
        return new Response(undefined, { status: 204 })
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  return { calls, base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

describe("createControl", () => {
  let server: ReturnType<typeof stub>
  beforeEach(() => {
    server = stub()
  })
  afterEach(() => server.stop())

  test("sessions parses the registry list", async () => {
    const control = createControl(server.base)
    const list = await control.sessions()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ taskId: "task-1", direction: "outbound", state: "TASK_STATE_WORKING" })
  })

  test("session returns detail with turns", async () => {
    const control = createControl(server.base)
    const detail = await control.session("task-1")
    expect(detail.session.taskId).toBe("task-1")
    expect(detail.turns).toEqual([{ index: 0, speaker: "local", content: "hello" }])
  })

  test("start, reply, and cancel hit the documented routes", async () => {
    const control = createControl(server.base)
    expect((await control.start("loop", "hello")).taskId).toBe("task-1")
    expect((await control.reply("task-1", "follow up")).taskId).toBe("task-1")
    expect((await control.cancel("task-1")).taskId).toBe("task-1")
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /a2a/conversations",
      "POST /a2a/conversations/task-1/messages",
      "POST /a2a/conversations/task-1/cancel",
    ])
    expect(server.calls[0].body).toEqual({ peer: "loop", text: "hello" })
    expect(server.calls[1].body).toEqual({ text: "follow up" })
  })

  test("peers, addPeer, removePeer, testPeer", async () => {
    const control = createControl(server.base)
    const info = await control.peers()
    expect(info.peers).toEqual([{ name: "loop", url: "http://127.0.0.1:4322" }])
    expect(info.self).toMatchObject({ name: "stub-agent", port: 4322 })
    expect(info.writable).toBe(true)

    await control.addPeer("agent-b", "http://b:4322")
    await control.removePeer("loop")
    const test = await control.testPeer("loop")
    expect(test).toMatchObject({ ok: true, name: "stub-agent" })
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toContain("POST /a2a/peers")
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toContain("DELETE /a2a/peers/loop")
    expect(server.calls[1].body).toEqual({ name: "agent-b", url: "http://b:4322" })
  })

  test("ControlError carries status and server error text", async () => {
    const control = createControl(server.base)
    const failure = await control.session("missing").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ControlError)
    expect((failure as ControlError).status).toBe(404)
    expect((failure as ControlError).message).toBe("not found")
  })

  test("unreachable endpoint reports a ControlError", async () => {
    const control = createControl("http://127.0.0.1:1")
    await expect(control.sessions()).rejects.toBeInstanceOf(ControlError)
  })
})

describe("resolveControl", () => {
  test("env override wins and is probed before use", async () => {
    const server = stub()
    try {
      const found = await resolveControl({
        env: { OPENCODE_A2A_ADMIN_URL: server.base },
        serverUrl: "http://127.0.0.1:1",
      })
      expect(found).toEqual({ base: server.base, via: "env" })
    } finally {
      server.stop()
    }
  })

  test("dead candidates are skipped in favor of a live one", async () => {
    const server = stub()
    try {
      const found = await resolveControl({
        env: { OPENCODE_A2A_ADMIN_URL: "http://127.0.0.1:1" },
        serverUrl: server.base,
      })
      expect(found).toEqual({ base: server.base, via: "server" })
    } finally {
      server.stop()
    }
  })

  test("port file under the project dir is honored", async () => {
    const server = stub()
    const dir = mkdtempSync(path.join(tmpdir(), "a2a-control-"))
    try {
      const file = path.join(dir, ADMIN_PORT_FILE)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, new URL(server.base).port)
      const found = await resolveControl({ directories: [dir] })
      expect(found).toEqual({ base: server.base, via: "port-file" })
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("stale port files and nothing configured resolve to undefined", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a2a-control-"))
    try {
      const file = path.join(dir, ADMIN_PORT_FILE)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, "1")
      const found = await resolveControl({ directories: [dir], probeMs: 250 })
      expect(found).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
