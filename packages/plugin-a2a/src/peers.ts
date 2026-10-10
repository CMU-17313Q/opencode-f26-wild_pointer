import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { requireUrl, type A2AConfig } from "./config.ts"

export type AllowedPeer = { name: string; url: string }

export type PeerEdit = {
  file: string
  // The plugin entry's options object (nested or flat) with the edit applied,
  // ready to feed back through resolveConfig for a live re-apply.
  options: Record<string, unknown>
}

type Shape = "nested" | "flat"

type Registration = {
  spec: string
  index: number
  shape: Shape
  options?: Record<string, unknown>
  // Path to the allowedPeers object, for jsonc modify.
  path: Array<string | number>
  // A bare spec string has no options object yet; writing upgrades it to a
  // nested [spec, { a2a: { ... } }] tuple.
  upgrade: boolean
}

// Mirrors packages/opencode/src/plugin/install.ts: modify the whole document
// with jsonc-parser so comments and unrelated keys stay byte-identical.
function patch(text: string, at: Array<string | number>, value: unknown) {
  return applyEdits(
    text,
    modify(text, at, value, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    }),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function specMatches(spec: string): boolean {
  return spec.includes("plugin-a2a")
}

// Ours is the plugin entry whose spec names plugin-a2a, or whose options own an
// `a2a` section. The shape decides where `allowedPeers` lives.
export function findRegistration(data: unknown): Registration | undefined {
  if (!isRecord(data) || !Array.isArray(data.plugin)) return
  const list = data.plugin
  for (let index = 0; index < list.length; index++) {
    const item = list[index]
    if (typeof item === "string") {
      if (!specMatches(item)) continue
      return {
        spec: item,
        index,
        shape: "nested",
        path: ["plugin", index, 1, "a2a", "allowedPeers"],
        upgrade: true,
      }
    }
    if (!Array.isArray(item)) continue
    const spec = typeof item[0] === "string" ? item[0] : undefined
    const options = isRecord(item[1]) ? item[1] : undefined
    const nested = isRecord(options?.a2a) ? options.a2a : undefined
    if (spec !== undefined && specMatches(spec)) {
      // No options object yet, or a nested one: default to nested so an upgrade
      // writes a consistent [spec, { a2a: { ... } }] tuple.
      const shape: Shape = options === undefined || nested !== undefined ? "nested" : "flat"
      return {
        spec,
        index,
        shape,
        options,
        path:
          shape === "nested"
            ? ["plugin", index, 1, "a2a", "allowedPeers"]
            : ["plugin", index, 1, "allowedPeers"],
        upgrade: options === undefined,
      }
    }
    if (nested !== undefined) {
      return {
        spec: spec ?? "plugin-a2a",
        index,
        shape: "nested",
        options,
        path: ["plugin", index, 1, "a2a", "allowedPeers"],
        upgrade: false,
      }
    }
  }
}

function atPath(data: unknown, path: Array<string | number>): unknown {
  let current: unknown = data
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[key]
      continue
    }
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function readPeers(data: unknown, reg: Registration): Record<string, string> {
  const value = atPath(data, reg.path)
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

// The plugin entry options (not just the a2a section) with `allowedPeers`
// replaced, preserving the entry's shape so a live re-resolve reads it back.
function optionsWithPeers(reg: Registration, peers: Record<string, string>): Record<string, unknown> {
  if (reg.shape === "nested") {
    const a2a = isRecord(reg.options?.a2a) ? reg.options.a2a : {}
    return { ...(reg.options ?? {}), a2a: { ...a2a, allowedPeers: peers } }
  }
  return { ...(reg.options ?? {}), allowedPeers: peers }
}

function writePeers(text: string, reg: Registration, peers: Record<string, string>): string {
  const upgraded = reg.upgrade ? patch(text, ["plugin", reg.index], [reg.spec, { a2a: {} }]) : text
  return patch(upgraded, reg.path, peers)
}

export type PeerStore = {
  readPeers: () => Promise<AllowedPeer[]>
  addPeer: (name: string, url: string) => Promise<PeerEdit>
  removePeer: (name: string) => Promise<PeerEdit>
}

// The single source of truth stays `a2a.allowedPeers` in the config file. This
// store locates the plugin's own registration (project file first, then the
// global config) and edits only the allowedPeers subtree, in place.
export function createPeerStore(input: {
  directory?: string
  globalConfigDir?: string
  // Test seam: an explicit candidate list replaces the default search.
  files?: string[]
}): PeerStore {
  const candidates = (): string[] => {
    if (input.files !== undefined) return input.files
    const globalDir = input.globalConfigDir ?? path.join(homedir(), ".config", "opencode")
    return [
      path.join(input.directory ?? ".", "opencode.json"),
      path.join(globalDir, "opencode.json"),
      path.join(globalDir, "opencode.jsonc"),
    ]
  }

  const locate = async (): Promise<{ file: string; text: string; data: unknown; reg: Registration } | undefined> => {
    for (const file of candidates()) {
      const text = await readFile(file, "utf8").catch(() => undefined)
      if (text === undefined || text.trim() === "") continue
      const errors: unknown[] = []
      const data = parseJsonc(text, errors as never, { allowTrailingComma: true })
      if (errors.length > 0) continue
      const reg = findRegistration(data)
      if (reg !== undefined) return { file, text, data, reg }
    }
    return undefined
  }

  const edit = async (mutate: (peers: Record<string, string>) => Record<string, string>): Promise<PeerEdit> => {
    const located = await locate()
    if (located === undefined) {
      throw new Error(
        `No editable A2A registration found (checked ${candidates().join(", ")}). ` +
          `Add the peer by hand to the "allowedPeers" of the plugin-a2a entry in opencode.json.`,
      )
    }
    const peers = mutate(readPeers(located.data, located.reg))
    const text = writePeers(located.text, located.reg, peers)
    const write = await writeFile(located.file, text, "utf8").catch((error: unknown) => error)
    if (write instanceof Error) {
      throw new Error(
        `Could not write ${located.file}: ${write.message}. Edit the "allowedPeers" of the plugin-a2a entry by hand.`,
      )
    }
    return { file: located.file, options: optionsWithPeers(located.reg, peers) }
  }

  return {
    readPeers: async () => {
      const located = await locate()
      if (located === undefined) return []
      return Object.entries(readPeers(located.data, located.reg)).map(([name, url]) => ({ name, url }))
    },
    addPeer: async (name, url) => {
      const trimmed = name.trim()
      if (!trimmed) throw new Error("A2A peer name must be a non-empty string")
      requireUrl(trimmed, url)
      return edit((peers) => ({ ...peers, [trimmed]: url }))
    },
    removePeer: async (name) =>
      edit((peers) => {
        if (!(name in peers)) throw new Error(`Unknown A2A peer "${name}"`)
        const { [name]: _removed, ...rest } = peers
        return rest
      }),
  }
}

export type PeerManager = {
  list: () => AllowedPeer[]
  add: (name: string, url: string) => Promise<void>
  remove: (name: string) => Promise<void>
}

// Wraps the store with the live config: after a JSONC write the edited file's
// options are re-resolved and applied, so the running tool sees the new peers
// without a restart.
export function createPeerManager(input: {
  directory?: string
  globalConfigDir?: string
  files?: string[]
  config: () => A2AConfig
  resolve: (options: Record<string, unknown>) => A2AConfig
  apply: (config: A2AConfig) => void
}): PeerManager {
  const store = createPeerStore({
    directory: input.directory,
    globalConfigDir: input.globalConfigDir,
    files: input.files,
  })
  const apply = async (options: Record<string, unknown>) => {
    input.apply(input.resolve(options))
  }
  return {
    list: () =>
      Object.entries(input.config().allowedPeers).map(([name, url]) => ({ name, url })),
    add: async (name, url) => {
      const edit = await store.addPeer(name, url)
      await apply(edit.options)
    },
    remove: async (name) => {
      if (!(name in input.config().allowedPeers)) throw new Error(`Unknown A2A peer "${name}"`)
      const edit = await store.removePeer(name)
      await apply(edit.options)
    },
  }
}
