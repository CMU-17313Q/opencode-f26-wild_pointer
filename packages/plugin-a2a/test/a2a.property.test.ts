// P4B properties for the A2A feature. One property per requirement, each
// labelled with the kind it belongs to and the requirement it checks:
//
//   R1  malformed peer address rejected before any network use, typo in the
//       message body sent as written              -> invariant + round-trip
//   R2  every outbound call is observable in the task registry
//                                                   -> model / oracle
//   R3  an inbound task runs under the same permission rules as a local
//       session, and a refusal is not laundered into a reply
//                                                   -> model / oracle
//   R5  the peer list every session sees is the project's configured list, and
//       adding/removing a peer moves exactly that name -> metamorphic
//
// R4 (bearer token + HTTPS) is kept in the requirements table but has no
// property in this submission; see traceability/wentaod.md.
//
// Generators are built to reach the inputs the interviewees actually worried
// about (mistyped addresses vs. mistyped prose, denied file reads, peers
// appearing and disappearing), not just random strings.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Task } from "a2a"
import fc from "fast-check"
import { resolveConfig, type A2AConfig } from "../src/config.ts"
import { ConversationStore, createConversationCore } from "../src/conversation.ts"
import { createPeerManager, createPeerStore } from "../src/peers.ts"
import { createConversationRegistry } from "../src/registry.ts"
import { createSessionRunner } from "../src/session.ts"
import { agentReplies, awaitState, fakeRunner, send, startBridge, userMessage } from "./bridge.ts"

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// R1: a peer address is "malformed" when the platform parser refuses it. The
// generator uses that same population so the property says something about the
// output contract (error text, nothing stored) rather than re-deriving URL
// validity inside the test.
const malformedUrl = fc.string().filter((text) => {
  try {
    new URL(text)
    return false
  } catch {
    return true
  }
})

// R1: well-formed addresses, including the paths and ports a peer URL really
// carries, so the round-trip half sees more than a bare host.
const validUrl = fc.webUrl({ validSchemes: ["http", "https"] })

// Message bodies: free text with the trim() the conversation core applies
// already accounted for, so a generated "typo" is never silently empty.
const messageText = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((text) => text.trim() !== "")

// Peer names stay in the shape an operator would type: no whitespace, so the
// trim in addPeer cannot change the key the property asserts on.
const peerName = fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/)

function failure(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

// ---------------------------------------------------------------------------
// R1 — malformed addresses rejected before any network use
// ---------------------------------------------------------------------------

// R1: A malformed peer address must be rejected before any network request with
// a validation error, and it must never reach the peer list.
// Kind: invariant
test("R1: any unparseable peer address is rejected with the documented error", () => {
  fc.assert(
    fc.property(malformedUrl, peerName, (url, name) => {
      const message = failure(() => resolveConfig({ options: { enabled: true, allowedPeers: { [name]: url } }, env: {} }))
      // Rejection is synchronous: resolveConfig finishes before any A2AClient
      // can exist, so a malformed address can never produce a network call.
      expect(message).toBeDefined()
      expect(message).toContain(`Invalid URL for A2A peer "${name}"`)
      // The rejected value is carried into the message verbatim, which is what
      // makes the error actionable for the operator who typed it.
      expect(message).toContain(url)
    }),
  )
})

// R1: A well-formed address survives config resolution unchanged — no
// normalisation, no trailing slash added, no case folding.
// Kind: round-trip
test("R1: a well-formed peer address round-trips through config unchanged", () => {
  fc.assert(
    fc.property(validUrl, peerName, (url, name) => {
      const config = resolveConfig({ options: { enabled: true, allowedPeers: { [name]: url } }, env: {} })
      expect(config.allowedPeers[name]).toBe(url)
    }),
  )
})

// R1: A typo in the message body is not a local validation problem. Whatever
// the user typed reaches the peer verbatim and the call still succeeds.
// Kind: invariant (over the delivered payload)
test("R1: a mistyped message body is delivered as written and still gets a reply", async () => {
  const fake = fakeRunner()
  const bridge = startBridge(fake.runner)
  try {
    const config: A2AConfig = { ...resolveConfig({ options: { enabled: true }, env: {} }), allowedPeers: { "peer-a": bridge.baseUrl } }
    await fc.assert(
      fc.asyncProperty(messageText, async (text) => {
        const core = createConversationCore({ config, store: new ConversationStore() })
        const result = await core.startConversation("peer-a", text, { origin: "tool" })
        // The core trims the outgoing text; nothing else may touch it.
        expect(fake.runs.at(-1)?.text).toBe(text.trim())
        expect(result.reply).toBeDefined()
        expect(result.reply).not.toBe("")
      }),
      { numRuns: 15 },
    )
  } finally {
    bridge.stop()
  }
})

// ---------------------------------------------------------------------------
// R2 — every outbound call leaves an observable task record
// ---------------------------------------------------------------------------

// R2: Every outbound A2A call to a configured peer must create an observable
// task record showing the peer, direction, state and turn count, with the reply
// visible, so "waiting", "replied" and "failed" are distinguishable.
// Kind: model / oracle — the oracle is the set of asks this property issued and
// the replies the peer actually returned; the registry must mirror them.
test("R2: N outbound asks produce exactly N records mirroring what was sent and replied", async () => {
  const fake = fakeRunner()
  const bridge = startBridge(fake.runner)
  const dir = mkdtempSync(join(tmpdir(), "a2a-property-r2-"))
  try {
    const config: A2AConfig = { ...resolveConfig({ options: { enabled: true }, env: {} }), allowedPeers: { "peer-a": bridge.baseUrl } }
    await fc.assert(
      fc.asyncProperty(fc.array(messageText, { minLength: 1, maxLength: 3 }), async (texts) => {
        const registry = createConversationRegistry({ file: join(dir, `sessions-${crypto.randomUUID()}.json`) })
        const core = createConversationCore({ config, store: new ConversationStore(), registry })

        const results = []
        for (const text of texts) results.push(await core.startConversation("peer-a", text, { origin: "tool" }))
        await registry.flush()

        // One record per call, no more: an ask can never be invisible, and a
        // single call can never be recorded twice.
        const records = registry.list()
        expect(records).toHaveLength(texts.length)

        for (const [index, result] of results.entries()) {
          const record = registry.get(result.taskId ?? "")
          expect(record).toBeDefined()
          if (record === undefined) return
          // Identity: the peer and the side of the bridge are on the record.
          expect(record.direction).toBe("outbound")
          expect(record.peerId).toBe("peer-a")
          expect(record.origin).toBe("tool")
          // State mirrors the turn outcome the caller received.
          expect(record.state).toBe(result.state)
          // Turn count covers both sides of the exchange.
          expect(record.turns).toBeGreaterThanOrEqual(2)
          // The exact outgoing text and the peer's reply are in the history, so
          // a UI can tell "replied" apart from "still waiting" after the fact.
          expect(record.history?.some((turn) => turn.speaker === "local" && turn.content === texts[index]?.trim())).toBe(true)
          expect(record.history?.some((turn) => turn.speaker === "remote" && turn.content === result.reply)).toBe(true)
        }

        // A conversation that reaches the turn cap is recorded as COMPLETED,
        // which is the terminal state the acceptance criteria name.
        const last = results.at(-1)
        const continued = await core.continueConversation(last?.taskId ?? "", "and again", { origin: "tool" })
        expect(continued.state).toBe("TASK_STATE_COMPLETED")
        const capped = registry.get(last?.taskId ?? "")
        expect(capped?.state).toBe("TASK_STATE_COMPLETED")
        expect(capped?.turns).toBe(4)
        expect(capped?.history?.filter((turn) => turn.speaker === "local")).toHaveLength(2)
        expect(capped?.history?.filter((turn) => turn.speaker === "remote")).toHaveLength(2)
      }),
      { numRuns: 20 },
    )
  } finally {
    bridge.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// R3 — inbound tasks obey the local permission rules
// ---------------------------------------------------------------------------

type PromptPart = {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  state?: { status?: string; error?: string }
}

// The real session runner talking to a scripted host: the fake stands in for
// opencode's prompt API, which is where the project's permission rules run. The
// runner is the same object the inbound bridge uses for every peer prompt, so a
// refusal that the local path would report must reach the peer as a failure.
function hostClient(reply: { text?: string; denial?: string }) {
  const prompts: Array<{ text: string }> = []
  const client = {
    session: {
      create: async () => ({ data: { id: `ses_${prompts.length + 1}` } }),
      prompt: async (options: { body: { parts: Array<{ type: string; text?: string }> } }) => {
        prompts.push({ text: options.body.parts.map((part) => part.text ?? "").join("") })
        const parts: PromptPart[] =
          reply.denial === undefined
            ? [{ type: "text", text: reply.text ?? "" }]
            : [{ type: "tool", state: { status: "error", error: reply.denial } }]
        return { data: { info: {}, parts } }
      },
      abort: async () => ({ data: true }),
    },
  }
  return { client: client as unknown as PluginInput["client"], prompts }
}

// R3: An inbound A2A task must run under the same permission rules as a local
// session; a tool call that would be denied locally must be denied for the A2A
// caller and the protected content must not be returned.
// Kind: model / oracle — the oracle is what the local session runner does with
// the same host reply. Changing only the permission outcome changes the task
// state, and a denial is never turned into a reply.
test("R3: a denied tool call fails the inbound task instead of replying", async () => {
  await fc.assert(
    fc.asyncProperty(
      messageText,
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.string({ minLength: 1, maxLength: 40 }).filter((text) => text.trim() !== ""),
      fc.boolean(),
      async (text, deniedReason, replyText, denied) => {
        const host = hostClient(denied ? { denial: `rejected permission: ${deniedReason}` } : { text: replyText })
        const bridge = startBridge(createSessionRunner({ client: host.client }))
        try {
          const task = await send(bridge.client, userMessage(text))
          const settled = denied
            ? await awaitState(bridge.client, task.id, "TASK_STATE_FAILED")
            : await awaitState(bridge.client, task.id, "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_COMPLETED")

          // Same prompt the local path would send: the bridge adds no context
          // and strips none — permission rules therefore see identical input.
          expect(host.prompts).toHaveLength(1)
          expect(host.prompts[0]?.text).toBe(text.trim())

          if (denied) {
            expect(settled.status.state).toBe("TASK_STATE_FAILED")
            const status = statusText(settled)
            expect(status).toContain("permission denied")
            expect(status).toContain(deniedReason)
            // No agent turn: the protected content is not returned, and the
            // refusal is not dressed up as a successful answer.
            expect(agentReplies(settled)).toEqual([])
            return
          }
          expect(agentReplies(settled)).toEqual([replyText.trim()])
        } finally {
          bridge.stop()
        }
      },
    ),
    { numRuns: 12 },
  )
})

function statusText(task: Task): string {
  return (task.status.message?.parts ?? []).map((part) => part.text ?? "").join("\n")
}

// ---------------------------------------------------------------------------
// R5 (revised) — one configured peer list, visible to every session
// ---------------------------------------------------------------------------

// R5 (revised): The peer list served to every session equals the project's
// configured allowedPeers; every listed peer is addressable by name, and a name
// that was never configured is not.
// Kind: metamorphic — adding a peer grows the visible list by exactly that
// name and removing it shrinks the list by exactly that name, without moving
// any other entry.
test("R5: the served peer list is the configured list, and add/remove move only that name", async () => {
  const fake = fakeRunner()
  const bridge = startBridge(fake.runner)
  try {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(peerName, { minLength: 1, maxLength: 3 }), async (names) => {
        const dir = mkdtempSync(join(tmpdir(), "a2a-property-r5-"))
        try {
          const file = join(dir, "opencode.json")
          writeFileSync(file, JSON.stringify({ plugin: [["plugin-a2a", { a2a: { enabled: true } }]] }), "utf8")
          const ref = { current: resolveConfig({ options: { enabled: true }, env: {} }) }
          const manager = createPeerManager({
            files: [file],
            config: () => ref.current,
            resolve: (options) => resolveConfig({ options, env: {} }),
            apply: (next) => {
              ref.current = next
            },
          })
          const core = createConversationCore({ config: () => ref.current, store: new ConversationStore() })

          const configured = Object.fromEntries(names.map((name) => [name, bridge.baseUrl]))
          for (const [name, url] of Object.entries(configured)) await manager.add(name, url)

          // What the plugin serves is exactly what the project configured...
          expect(Object.fromEntries(manager.list().map((peer) => [peer.name, peer.url]))).toEqual(configured)
          // ...and a second, independent reader of the same file agrees, which
          // is the point of the revision: one list, every session.
          const reader = await createPeerStore({ files: [file] }).readPeers()
          expect(Object.fromEntries(reader.map((peer) => [peer.name, peer.url]))).toEqual(configured)

          // Every configured name is addressable without any extra setup.
          for (const name of names) {
            const result = await core.startConversation(name, "ping", { origin: "tool" })
            expect(result.peerId).toBe(name)
            expect(result.reply).toBeDefined()
          }

          // Removing one name removes exactly that name.
          const [removed] = names
          await manager.remove(removed ?? "")
          const remaining = Object.fromEntries(names.filter((name) => name !== removed).map((name) => [name, bridge.baseUrl]))
          expect(Object.fromEntries(manager.list().map((peer) => [peer.name, peer.url]))).toEqual(remaining)
          await expect(core.startConversation(removed ?? "", "ping", { origin: "tool" })).rejects.toThrow(
            `Unknown A2A peer "${removed}"`,
          )
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 10 },
    )
  } finally {
    bridge.stop()
  }
})
