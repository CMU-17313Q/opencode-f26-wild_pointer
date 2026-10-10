// A2A-014: live peer management edits only the allowedPeers subtree of the
// plugin's own config entry, preserving JSONC comments and the entry's shape,
// then re-applies so the running tool accepts the peer without a restart.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { createConversationCore, ConversationStore } from "../src/conversation.ts"
import { resolveConfig } from "../src/config.ts"
import { createPeerManager, createPeerStore } from "../src/peers.ts"
import { fakeRunner, startBridge } from "./bridge.ts"

const NESTED = `// project config
{
  "plugin": [
    [
      "./packages/plugin-a2a", // the a2a bridge
      {
        "a2a": {
          "enabled": true
          // peers go here
        }
      }
    ]
  ]
}
`

const FLAT = `{
  // flat style
  "plugin": [["plugin-a2a", { "enabled": true }]]
}
`

const EXISTING = `{
  "plugin": [
    [
      "plugin-a2a",
      {
        "a2a": {
          "enabled": true, // enable a2a
          "allowedPeers": {
            "agent-a": "http://localhost:1111"
          }
        }
      }
    ]
  ]
}
`

function fixture(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "a2a-peers-"))
  const file = join(dir, "opencode.json")
  writeFileSync(file, text, "utf8")
  return { dir, file, read: () => readFileSync(file, "utf8"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function parsed(text: string): Record<string, unknown> {
  return parseJsonc(text, [], { allowTrailingComma: true }) as Record<string, unknown>
}

function allowedPeersOf(data: Record<string, unknown>): unknown {
  const plugin = data.plugin as Array<[string, Record<string, unknown>]>
  const entry = plugin[0][1]
  const a2a = entry.a2a as Record<string, unknown> | undefined
  return a2a === undefined ? entry.allowedPeers : a2a.allowedPeers
}

describe("peer store edits", () => {
  test("adds a peer to a nested entry and keeps comments", async () => {
    const dir = fixture(NESTED)
    try {
      const store = createPeerStore({ files: [dir.file] })
      await store.addPeer("agent-b", "http://localhost:2222")

      const text = dir.read()
      expect(text).toContain("// project config")
      expect(text).toContain("// the a2a bridge")
      expect(text).toContain("// peers go here")
      expect(text).toContain('"enabled": true')
      expect(allowedPeersOf(parsed(text))).toEqual({ "agent-b": "http://localhost:2222" })
    } finally {
      dir.cleanup()
    }
  })

  test("adds a peer to a flat entry", async () => {
    const dir = fixture(FLAT)
    try {
      const store = createPeerStore({ files: [dir.file] })
      await store.addPeer("agent-b", "http://localhost:2222")

      const text = dir.read()
      expect(text).toContain("// flat style")
      expect(allowedPeersOf(parsed(text))).toEqual({ "agent-b": "http://localhost:2222" })
    } finally {
      dir.cleanup()
    }
  })

  test("removes a peer without disturbing the others", async () => {
    const dir = fixture(EXISTING)
    try {
      const store = createPeerStore({ files: [dir.file] })
      await store.addPeer("agent-b", "http://localhost:2222")
      await store.removePeer("agent-a")

      const text = dir.read()
      expect(text).toContain("// enable a2a")
      expect(allowedPeersOf(parsed(text))).toEqual({ "agent-b": "http://localhost:2222" })
    } finally {
      dir.cleanup()
    }
  })

  test("rejects an invalid URL and writes nothing", async () => {
    const dir = fixture(NESTED)
    try {
      const before = dir.read()
      const store = createPeerStore({ files: [dir.file] })
      await expect(store.addPeer("agent-b", "not a url")).rejects.toThrow('Invalid URL for A2A peer "agent-b"')
      expect(dir.read()).toBe(before)
    } finally {
      dir.cleanup()
    }
  })

  test("upgrades a bare spec string registration", async () => {
    const dir = fixture(`{ "plugin": ["plugin-a2a"] }`)
    try {
      const store = createPeerStore({ files: [dir.file] })
      await store.addPeer("agent-b", "http://localhost:2222")
      const text = dir.read()
      expect(allowedPeersOf(parsed(text))).toEqual({ "agent-b": "http://localhost:2222" })
    } finally {
      dir.cleanup()
    }
  })

  test("errors clearly when no registration exists", async () => {
    const dir = fixture(`{ "plugin": ["./some-other-plugin"] }`)
    try {
      const store = createPeerStore({ files: [dir.file] })
      await expect(store.addPeer("agent-b", "http://localhost:2222")).rejects.toThrow(
        /No editable A2A registration found/,
      )
    } finally {
      dir.cleanup()
    }
  })
})

describe("peer manager live apply", () => {
  test("a new peer is usable immediately and removal refuses it", async () => {
    const fixtureDir = fixture(NESTED)
    const fake = fakeRunner({ replies: ["pong"] })
    const bridge = startBridge(fake.runner)
    try {
      const ref = { current: resolveConfig({ options: { enabled: true }, env: {} }) }
      const manager = createPeerManager({
        files: [fixtureDir.file],
        config: () => ref.current,
        resolve: (options) => resolveConfig({ options, env: {} }),
        apply: (next) => {
          ref.current = next
        },
      })

      await manager.add("agent-b", bridge.baseUrl)
      const core = createConversationCore({ config: () => ref.current, store: new ConversationStore() })
      const result = await core.startConversation("agent-b", "hi")
      expect(result.reply).toBe("pong")

      await manager.remove("agent-b")
      await expect(core.startConversation("agent-b", "hi")).rejects.toThrow('Unknown A2A peer "agent-b"')
    } finally {
      bridge.stop()
      fixtureDir.cleanup()
    }
  })
})
