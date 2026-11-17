// P4B property tests for Dilshodbek's requirements (traceability/dzk.md).
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import type { Message, Task, TaskState } from "a2a"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { ConversationStore, createAskTool } from "../src/ask.ts"
import type { A2AConfig } from "../src/config.ts"
import { createPeerStore } from "../src/peers.ts"

// A scripted peer over real HTTP. `mode` decides how it answers each message:
// echo completes with "echo: <text>", stuck accepts the task and stays WORKING
// forever, ask keeps the task INPUT_REQUIRED so a conversation can go on.
function startPeer(mode: "echo" | "stuck" | "ask", streaming = false) {
  const tasks = new Map<string, Task>()
  const received: Message[] = []
  const state: Record<typeof mode, TaskState> = {
    echo: "TASK_STATE_COMPLETED",
    stuck: "TASK_STATE_WORKING",
    ask: "TASK_STATE_INPUT_REQUIRED",
  }
  const accept = (message: Message) => {
    received.push(message)
    const id = message.taskId ?? `task-${tasks.size + 1}`
    const task = tasks.get(id) ?? { id, contextId: `ctx-${id}`, status: { state: "TASK_STATE_SUBMITTED" }, history: [] }
    task.history = [...(task.history ?? []), message]
    if (mode !== "stuck") {
      const text = message.parts.map((part) => part.text).join("\n")
      const reply: Message = {
        messageId: crypto.randomUUID(),
        role: "ROLE_AGENT",
        parts: [{ text: mode === "echo" ? `echo: ${text}` : `turn ${task.history.length}` }],
        taskId: id,
      }
      task.history = [...task.history, reply]
      task.status = { state: state[mode], message: reply }
    }
    if (mode === "stuck") task.status = { state: "TASK_STATE_WORKING" }
    tasks.set(id, task)
    return task
  }
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/.well-known/agent-card.json")
        return Response.json({
          name: "stub",
          description: "stub peer",
          version: "1.0.0",
          supportedInterfaces: [{ url: "http://localhost", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
          capabilities: streaming ? { streaming: true } : {},
          defaultInputModes: ["text/plain"],
          defaultOutputModes: ["text/plain"],
          skills: [{ id: "chat", name: "Chat", description: "Talk", tags: ["chat"] }],
        })
      const body = (await request.json()) as { id: unknown; method: string; params?: Record<string, unknown> }
      const params = body.params ?? {}
      if (body.method === "message/send")
        return Response.json({ jsonrpc: "2.0", id: body.id, result: accept(params.message as Message) })
      if (body.method === "message/stream") {
        const task = accept(params.message as Message)
        // A stuck streaming peer opens the stream and never writes to it.
        if (mode === "stuck")
          return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
        return new Response(`data: ${JSON.stringify(task)}\n\n`, { headers: { "content-type": "text/event-stream" } })
      }
      if (body.method === "tasks/get") {
        const task = tasks.get(String(params.id))
        if (task) return Response.json({ jsonrpc: "2.0", id: body.id, result: task })
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not found" } })
    },
  })
  return { url: server.url.origin, received, stop: () => server.stop(true) }
}

function config(peers: Record<string, string>, maxTurns = 4): A2AConfig {
  return {
    enabled: true,
    listenPort: 0,
    adminPort: 0,
    adminHost: "127.0.0.1",
    allowedPeers: peers,
    maxTurns,
    turnTimeoutMs: 120_000,
  }
}

const context: ToolContext = {
  sessionID: "ses_property",
  messageID: "msg_property",
  agent: "build",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata() {},
  ask: async () => {},
}

async function ask(tool: ReturnType<typeof createAskTool>, args: { peer: string; message: string; taskId?: string }) {
  const result = await tool.execute(args, context)
  return typeof result === "string" ? { output: result, metadata: undefined } : result
}

const peers = [
  startPeer("echo"),
  startPeer("echo", true),
  startPeer("stuck"),
  startPeer("stuck", true),
  startPeer("ask"),
]
afterAll(() => peers.forEach((peer) => peer.stop()))
const [echo, echoStream, stuck, stuckStream, asker] = peers

describe("P4B properties (dzk)", () => {
  // R1: An outbound a2a_ask must always end. If the peer takes the message but
  // never replies, the call fails with a timeout error after the deadline, and
  // the remote task is cancelled so the peer stops working on it too.
  // Kind: invariant
  // Generators: the deadline is drawn from 50-400 ms so each run stays short
  // while still covering very tight and looser deadlines; the peer is either a
  // polling peer or a streaming peer that opens the stream and goes silent,
  // because the two transports have separate timeout code.
  test("R1: a peer that never replies always ends in a timeout and a cancel", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 50, max: 400 }), fc.boolean(), async (timeoutMs, streaming) => {
        const canceled: Array<string | undefined> = []
        const tool = createAskTool({
          config: config({ slow: (streaming ? stuckStream : stuck).url }),
          store: new ConversationStore(),
          timeoutMs,
          pollMs: 10,
          cancel: async (taskId) => {
            canceled.push(taskId)
          },
        })
        const started = Date.now()
        const error = await ask(tool, { peer: "slow", message: "hi" }).then(
          () => undefined,
          (caught: Error) => caught,
        )
        const elapsed = Date.now() - started
        expect(error?.message).toContain('Timed out waiting for A2A peer "slow" to reply')
        expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 5)
        expect(elapsed).toBeLessThan(timeoutMs + 1000)
        await Bun.sleep(0)
        // The polling path knows the task id; a silent stream never sends one.
        expect(canceled.length).toBe(1)
        if (!streaming) expect(canceled[0]).toMatch(/^task-/)
      }),
      { numRuns: 20 },
    )
  })

  // R2: Adding a peer and then removing it must leave the config file exactly
  // as it was before, and the removed peer must not be contacted afterwards.
  // Kind: round-trip
  // Generators: config files are built from the shapes the peer store has to
  // handle (nested `a2a` section or flat options, with or without an existing
  // allowedPeers object, with or without comments), the existing peers are a
  // random set, and the added name is any non-blank name not already present,
  // including names with spaces, dots, quotes and unicode. "__proto__" is
  // left out because jsonc-parser drops that key when it reads the file.
  test("R2: add then remove leaves opencode.json byte for byte the same", async () => {
    const name = fc
      .string({ minLength: 1, maxLength: 12, unit: "grapheme" })
      .filter((s) => s.trim() === s && s !== "" && s !== "__proto__")
    const file = fc.record({
      nested: fc.boolean(),
      comments: fc.boolean(),
      existing: fc.option(fc.dictionary(name, fc.constant("http://127.0.0.1:4322"), { minKeys: 1, maxKeys: 3 }), {
        nil: undefined,
      }),
    })
    await fc.assert(
      fc.asyncProperty(file, name, async (shape, added) => {
        fc.pre(!(shape.existing && added in shape.existing))
        const options: Record<string, unknown> = { enabled: true }
        if (shape.existing) options.allowedPeers = shape.existing
        const entry = shape.nested ? { a2a: options } : options
        const json = JSON.stringify({ plugin: [["plugin-a2a", entry]] }, null, 2)
        const text = shape.comments ? `// project config\n${json.replace('"enabled"', '// on\n"enabled"')}\n` : json
        const dir = mkdtempSync(join(tmpdir(), "a2a-r2-"))
        try {
          const path = join(dir, "opencode.json")
          writeFileSync(path, text, "utf8")
          const store = createPeerStore({ files: [path] })
          await store.addPeer(added, "http://127.0.0.1:4323")
          await store.removePeer(added)
          expect(readFileSync(path, "utf8")).toBe(text)
          expect((await store.readPeers()).map((peer) => peer.name)).toEqual(Object.keys(shape.existing ?? {}))
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 100 },
    )
    // After removal the live config no longer has peer-b, so nothing is sent.
    const before = asker.received.length
    const tool = createAskTool({ config: config({ "peer-a": asker.url }), store: new ConversationStore() })
    await expect(ask(tool, { peer: "peer-b", message: "hi" })).rejects.toThrow('Unknown A2A peer "peer-b"')
    expect(asker.received.length).toBe(before)
  })

  // R3: Whether a call succeeds must depend on the peer and not on what the
  // message says. Two different non-empty messages to the same reachable peer
  // should both succeed, and each reply is the one the peer sent for it.
  // Kind: metamorphic
  // Generators: messages mix plain words with full unicode, newlines, JSON
  // and markdown characters, and leading or trailing spaces, since those are
  // the "weird message" cases interviewees asked about; blank messages are
  // whitespace only.
  test("R3: changing the message never changes whether the call succeeds", async () => {
    const text = fc.oneof(
      fc.string({ minLength: 1, maxLength: 80, unit: "grapheme" }),
      fc.constantFrom("list the files", "what is in notes.txt", '{"a": 1}', "# title\n- item", "waht is teh file"),
      fc
        .tuple(fc.constantFrom(" ", "\n", "\t"), fc.string({ minLength: 1, maxLength: 20 }))
        .map(([pad, s]) => pad + s + pad),
    )
    const nonBlank = text.filter((s) => s.trim() !== "")
    const blank = fc.string({ unit: fc.constantFrom(" ", "\t", "\n") })
    await fc.assert(
      fc.asyncProperty(nonBlank, nonBlank, fc.boolean(), blank, async (first, second, streaming, empty) => {
        const tool = createAskTool({
          config: config({ "peer-a": (streaming ? echoStream : echo).url, other: asker.url }),
          store: new ConversationStore(),
        })
        const a = await ask(tool, { peer: "peer-a", message: first })
        const b = await ask(tool, { peer: "peer-a", message: second })
        expect(a.metadata?.state).toBe("TASK_STATE_COMPLETED")
        expect(b.metadata?.state).toBe("TASK_STATE_COMPLETED")
        expect(a.output).toContain(`Reply: echo: ${first.trim()}`)
        expect(b.output).toContain(`Reply: echo: ${second.trim()}`)
        for (const peer of ["peer-a", "other"])
          await expect(ask(tool, { peer, message: empty })).rejects.toThrow("a2a_ask requires a non-empty message")
      }),
      { numRuns: 60 },
    )
  })

  // R5: A multi-turn conversation must stop at the turn cap. Once the cap is
  // reached no more messages are sent, and the tool returns the cap message.
  // Since one a2a_ask is a message plus its reply, the peer gets at most
  // ceil(maxTurns / 2) messages and the record ends at that many pairs.
  // Kind: model / oracle
  // Generators: maxTurns covers 0 (cap off), 1, odd and even values up to 8,
  // and the number of follow-up asks goes past the cap so the boundary call
  // and the calls after it are always exercised.
  test("R5: the conversation matches a simple turn-counting model", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 1, max: 8 }), async (maxTurns, calls) => {
        const tool = createAskTool({
          config: config({ "peer-a": asker.url }, maxTurns),
          store: new ConversationStore(),
        })
        const before = asker.received.length
        // Model: every ask under the cap sends one message and adds two turns.
        const model = { turns: 0, sent: 0 }
        let taskId: string | undefined
        for (let index = 0; index < calls; index++) {
          const result = await ask(tool, { peer: "peer-a", message: `q${index}`, taskId })
          taskId ??= result.metadata?.taskId as string
          if (maxTurns > 0 && model.turns >= maxTurns) {
            expect(result.output).toContain("max turns reached without verdict")
            expect(result.metadata?.turn).toBe(model.turns)
            continue
          }
          model.sent += 1
          model.turns += 2
          expect(result.metadata?.turn).toBe(model.turns)
        }
        expect(asker.received.length - before).toBe(model.sent)
        if (maxTurns > 0) expect(model.sent).toBeLessThanOrEqual(Math.ceil(maxTurns / 2))
      }),
      { numRuns: 60 },
    )
  })
})
