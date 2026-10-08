/** @jsxImportSource @opentui/solid */

// Headless render test for the TUI panel (A2A-016): mounts the real
// dialog/keymap/theme providers from packages/tui, wires a stub
// TuiPluginApi through the same adapter the plugin runtime uses, and
// serves a fake /a2a/* control API in-process. Covers the pieces a unit
// test can't: the dialog stack, DialogSelect adapter mapping, keymap
// command dispatch, and live a2a.* event updates.

import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import plugin from "../src/tui"
import { tmpdir } from "../../tui/test/fixture/fixture"
import { createTuiResolvedConfig } from "../../tui/test/fixture/tui-runtime"
import { TestTuiContexts } from "../../tui/test/fixture/tui-environment"

const SESSION = {
  taskId: "task-deadbeef",
  direction: "outbound",
  peerId: "peer-a",
  origin: "tui",
  state: "TASK_STATE_INPUT_REQUIRED",
  turns: 2,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 5_000).toISOString(),
}

const TURNS = [
  { index: 0, speaker: "local", content: "hello peer" },
  { index: 1, speaker: "remote", peerId: "peer-a", content: "hello back" },
]

const PEERS = [{ name: "peer-a", url: "http://127.0.0.1:9999" }]

function serveAdmin() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/a2a/sessions") return Response.json({ sessions: [SESSION] })
      const match = url.pathname.match(/^\/a2a\/sessions\/(.+)$/)
      if (match) {
        const taskId = decodeURIComponent(match[1])
        if (taskId !== SESSION.taskId) return Response.json({ error: "not found" }, { status: 404 })
        return Response.json({ session: SESSION, turns: TURNS })
      }
      if (url.pathname === "/a2a/peers") {
        return Response.json({
          peers: PEERS,
          self: { name: "agent-a", port: 4322, enabled: true },
          writable: true,
        })
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
}

async function waitForFrame(
  app: { captureCharFrame: () => string; renderOnce: () => Promise<void> },
  needle: string,
  timeout = 4000,
) {
  const start = Date.now()
  while (!app.captureCharFrame().includes(needle)) {
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)} in frame:\n${app.captureCharFrame()}`)
    }
    await app.renderOnce()
    await Bun.sleep(10)
  }
}

async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountPanel(input: { root: string }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { KVProvider, useKV },
    { ThemeProvider, useTheme },
    { TuiConfigProvider },
    { ToastProvider, useToast },
    { OpencodeKeymapProvider, useOpencodeKeymap, registerOpencodeKeymap },
    { createTuiApiAdapters },
  ] = await Promise.all([
    import("../../tui/src/ui/dialog"),
    import("../../tui/src/context/kv"),
    import("../../tui/src/context/theme"),
    import("../../tui/src/config"),
    import("../../tui/src/ui/toast"),
    import("../../tui/src/keymap"),
    import("../../tui/src/plugin/adapters"),
  ])

  type AdaptersInput = Parameters<typeof createTuiApiAdapters>[0]
  type Keymap = ReturnType<typeof useOpencodeKeymap>

  const handlers = new Map<string, Array<(event: { type: string; properties?: unknown }) => void>>()
  let api: TuiPluginApi | undefined
  let keymap: Keymap | undefined

  function PluginInit(props: { config: AdaptersInput["tuiConfig"] }) {
    const apiBase = createTuiApiAdapters({
      version: "test",
      tuiConfig: props.config,
      dialog: useDialog(),
      keymap: useOpencodeKeymap(),
      theme: useTheme(),
      toast: useToast(),
      kv: useKV(),
      renderer: useRenderer(),
      event: {
        subscribe: () => () => {},
        on: (type: string, handler: (event: { type: string; properties?: unknown }) => void) => {
          const list = handlers.get(type) ?? []
          list.push(handler)
          handlers.set(type, list)
          return () => {}
        },
      } as unknown as AdaptersInput["event"],
      route: {
        navigate: () => {},
        get data() {
          return { type: "home" }
        },
      } as unknown as AdaptersInput["route"],
      routes: { register: () => () => {} } as unknown as AdaptersInput["routes"],
      sdk: { client: {} } as unknown as AdaptersInput["sdk"],
      sync: {
        ready: true,
        path: { state, config: input.root, worktree: input.root, directory: input.root },
        data: {},
        session: { get: () => undefined },
      } as unknown as AdaptersInput["sync"],
      attention: {
        notify: async () => ({ ok: false, notification: false, sound: false }),
      } as unknown as AdaptersInput["attention"],
      Slot: (() => null) as unknown as AdaptersInput["Slot"],
    })

    api = {
      ...apiBase,
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: (fn) => {
          onCleanup(() => void fn())
          return () => {}
        },
      },
    }
    keymap = apiBase.keymap as Keymap
    void plugin.tui(api, undefined, {
      id: "a2a",
      source: "file",
      spec: "test",
      target: "tui",
      state: "first",
      modified: 0,
      first_time: 0,
      last_time: 0,
      time_changed: 0,
      load_count: 0,
      fingerprint: "",
    })
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const map = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(map, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{ home: input.root, state, worktree: input.root }}
      >
        <OpencodeKeymapProvider keymap={map}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <PluginInit config={resolvedConfig} />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  await wait(() => api !== undefined)
  return {
    app,
    get api() {
      return api!
    },
    get keymap() {
      return keymap!
    },
    emit: (type: string, properties: unknown) =>
      handlers.get(type)?.forEach((handler) => handler({ type, properties })),
    frame: () => app.captureCharFrame(),
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("a2a.sessions lists registry rows and opens the thread", async () => {
  await using tmp = await tmpdir()
  const server = serveAdmin()
  await mkdir(path.join(tmp.path, ".opencode/a2a"), { recursive: true })
  await Bun.write(path.join(tmp.path, ".opencode/a2a/admin.port"), String(server.port))

  const panel = await mountPanel({ root: tmp.path })
  try {
    panel.keymap.dispatchCommand("a2a.sessions")
    await waitForFrame(panel.app, "peer-a")
    const frame = panel.frame()
    expect(frame).toContain("A2A sessions")
    expect(frame).toContain("peer-a")
    expect(frame).toContain("waiting")
    expect(frame).toContain("New conversation")
    expect(frame).toContain("Manage peers")

    panel.app.mockInput.pressEnter()
    await waitForFrame(panel.app, "hello back")
    const thread = panel.frame()
    expect(thread).toContain("hello peer")
    expect(thread).toContain("hello back")
    expect(thread).toContain("task-dea")

    // Live bus event adds a turn without a control-API refetch.
    panel.emit("a2a.conversation.turn", {
      taskId: SESSION.taskId,
      turn: 2,
      speaker: "local",
      content: "follow up",
    })
    await waitForFrame(panel.app, "follow up")
  } finally {
    await panel.cleanup()
    server.stop(true)
  }
})

test("a2a.peers lists allowedPeers and own identity", async () => {
  await using tmp = await tmpdir()
  const server = serveAdmin()
  await mkdir(path.join(tmp.path, ".opencode/a2a"), { recursive: true })
  await Bun.write(path.join(tmp.path, ".opencode/a2a/admin.port"), String(server.port))

  const panel = await mountPanel({ root: tmp.path })
  try {
    panel.keymap.dispatchCommand("a2a.peers")
    await waitForFrame(panel.app, "peer-a")
    const frame = panel.frame()
    expect(frame).toContain("peer-a")
    expect(frame).toContain("agent-a")
  } finally {
    await panel.cleanup()
    server.stop(true)
  }
})

test("a2a commands expose slash names and toggle the sessions panel", async () => {
  await using tmp = await tmpdir()
  const server = serveAdmin()
  await mkdir(path.join(tmp.path, ".opencode/a2a"), { recursive: true })
  await Bun.write(path.join(tmp.path, ".opencode/a2a/admin.port"), String(server.port))

  const panel = await mountPanel({ root: tmp.path })
  try {
    const slashes = new Map(
      panel.keymap
        .getCommandEntries({ visibility: "registered", namespace: "palette" })
        .map((entry) => [entry.command.name, entry.command.slashName]),
    )
    expect(slashes.get("a2a.sessions")).toBe("a2a")
    expect(slashes.get("a2a.new")).toBe("a2a-new")
    expect(slashes.get("a2a.peers")).toBe("a2a-peers")

    panel.keymap.dispatchCommand("a2a.sessions")
    await waitForFrame(panel.app, "A2A sessions", 2000)

    // re-running the command while the panel is open toggles it closed
    panel.keymap.dispatchCommand("a2a.sessions")
    await Bun.sleep(150)
    await panel.app.renderOnce()
    expect(panel.frame()).not.toContain("A2A sessions")

    panel.keymap.dispatchCommand("a2a.sessions")
    await waitForFrame(panel.app, "A2A sessions", 2000)

    // letters land in the open dialog's filter input, not the palette
    panel.app.mockInput.typeText("A2A")
    await Bun.sleep(150)
    await panel.app.renderOnce()
    expect(panel.frame()).toContain("No results found")

    panel.app.mockInput.pressEscape()
    await Bun.sleep(150)
    await panel.app.renderOnce()
    expect(panel.frame()).not.toContain("A2A sessions")

    panel.keymap.dispatchCommand("a2a.sessions")
    await waitForFrame(panel.app, "A2A sessions", 2000)
  } finally {
    await panel.cleanup()
    server.stop(true)
  }
})
