import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import fc from "fast-check"
import type { PluginInput } from "@opencode-ai/plugin"
import type { TaskState } from "a2a"
import { resolveConfig } from "../src/config.ts"
import { ConversationStore, createConversationCore } from "../src/conversation.ts"
import { noopEmitter } from "../src/events.ts"
import { ACTIVE_STATES, TERMINAL_STATES, isTerminal } from "../src/format.ts"
import { createPeerManager, createPeerStore } from "../src/peers.ts"
import { createConversationRegistry } from "../src/registry.ts"
import { createSessionRunner } from "../src/session.ts"

// Generators. Hosts and ports are the LAN IPs as in the interview demo, machine names, localhost.
// Bad addresses are similar to what interviewees were asked about (S-4: "an IP mistake").
const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/)
const host = fc.oneof(fc.ipV4(), fc.domain(), fc.constant("localhost"))
const port = fc.integer({ min: 1, max: 65_535 })
const goodUrl = fc.tuple(fc.constantFrom("http", "https"), host, port).map(([s, h, p]) => `${s}://${h}:${p}`)
const badUrl = fc.oneof(
  fc.tuple(host, port).map(([h, p]) => `${h}:${p}`), // no scheme: "192.168.1.5:4096"
  fc.tuple(fc.constantFrom("ftp", "file", "ws", "javascript"), host).map(([s, h]) => `${s}://${h}`), // wrong scheme
  fc.integer({ min: 256, max: 999 }).map((octet) => `http://192.168.1.${octet}:4096`), // octet > 255
  fc.integer({ min: 65_536, max: 99_999 }).map((p) => `http://localhost:${p}`), // port > 65535
)

async function withConfigFile(peers: Record<string, string>, body: (file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "a2a-prop-"))
  const file = path.join(dir, "opencode.json")
  await writeFile(file, JSON.stringify({ plugin: [["plugin-a2a", { a2a: { enabled: true, allowedPeers: peers } }]] }))
  await body(file).finally(() => rm(dir, { recursive: true, force: true }))
}

// R1: A badly formatted peer address is rejected when a peer is added, and nothing is saved.
// Kind: invariant
test("R1: a malformed peer address is rejected and nothing is saved", async () => {
  await fc.assert(
    fc.asyncProperty(name, badUrl, (peer, url) =>
      withConfigFile({}, async (file) => {
        const before = await readFile(file, "utf8")
        await expect(createPeerStore({ files: [file] }).addPeer(peer, url)).rejects.toThrow("Invalid URL")
        expect(await readFile(file, "utf8")).toBe(before)
      }),
    ),
  )
})

// R6: Adding a peer and then removing it restores the peer list, and the removed peer can no longer be messaged.
// Kind: round-trip
const typedName = fc.oneof(
  name,
  name.map((n) => ` ${n} `),
  fc.constantFrom("toString", "constructor", "__proto__"),
)

test("R6: add then remove restores the peer list", async () => {
  await fc.assert(
    fc.asyncProperty(typedName, goodUrl, (peer, url) =>
      withConfigFile({ existing: "http://localhost:4096" }, async (file) => {
        const live = { config: resolveConfig({ options: { a2a: { enabled: true, allowedPeers: { existing: "http://localhost:4096" } } } }) }
        const peers = createPeerManager({
          files: [file],
          config: () => live.config,
          resolve: (options) => resolveConfig({ options }),
          apply: (next) => (live.config = next),
        })
        const before = peers.list()

        if (peer.trim() in Object.prototype) {
          await expect(peers.add(peer, url)).rejects.toThrow("cannot be used")
          expect(peers.list()).toEqual(before)
          return
        }

        await peers.add(peer, url)
        await peers.remove(peer)
        expect(peers.list()).toEqual(before)
        const core = createConversationCore({ config: () => live.config, store: new ConversationStore() })
        await expect(core.startConversation(peer.trim(), "hi")).rejects.toThrow("Unknown A2A peer")
      }),
    ),
  )
})

// R5: Each inbound conversation gets own session labelled with the sender, every message lands in the same session.
// Kind: model / oracle. 
// Model: one session per conversation, title
test("R5: one labelled session per conversation", async () => {
  const conversations = fc.array(fc.record({ peer: name, messages: fc.array(fc.string(), { minLength: 1, maxLength: 3 }) }), {
    minLength: 1,
    maxLength: 4,
  })
  await fc.assert(
    fc.asyncProperty(conversations, async (list) => {
      const titles: string[] = []
      const client = {
        session: {
          create: async (options: { body: { title: string } }) => ({ data: { id: `ses_${titles.push(options.body.title)}` } }),
          prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "ok" }] } }),
        },
      } as unknown as PluginInput["client"]
      const runner = createSessionRunner({ client })

      for (const [i, conversation] of list.entries()) {
        const ids = new Set<string>()
        for (const text of conversation.messages) ids.add((await runner.run(`task-${i}`, text, conversation.peer)).sessionID)
        expect(ids).toEqual(new Set([`ses_${i + 1}`]))
        expect(titles[i]).toStartWith(`A2A ${conversation.peer} · `)
      }
      expect(titles).toHaveLength(list.length)
    }),
  )
})

// R2: While a request is pending, its row shows the peer's name and a pending
// state, once it ends (reply or failure) it doesn't go back to pending.
// Kind: invariant
const events = fc.array(fc.constantFrom<TaskState>(...ACTIVE_STATES, ...TERMINAL_STATES), { maxLength: 8 })

test("R2: a finished request never shows as pending again", async () => {
  await fc.assert(
    fc.asyncProperty(name, events, async (peer, states) => {
      const dir = await mkdtemp(path.join(tmpdir(), "a2a-prop-"))
      const registry = createConversationRegistry({ file: path.join(dir, "sessions.json") })
      const emit = registry.attach(noopEmitter, { direction: "outbound", origin: "tool", peerId: peer })
      emit("a2a.task.dispatched", { taskId: "t", peerId: peer, state: "TASK_STATE_SUBMITTED" })

      let expected: TaskState = "TASK_STATE_SUBMITTED"
      for (const state of states) {
        emit("a2a.task.updated", { taskId: "t", peerId: peer, state })
        if (!isTerminal(expected)) expected = state
        expect(registry.get("t")).toMatchObject({ peerId: peer, state: expected })
      }
      await registry.flush()
      await rm(dir, { recursive: true, force: true })
    }),
  )
})
