/** @jsxImportSource @opentui/solid */

// A2A panel (A2A-016). Everything here goes through the loopback control API
// — the TUI target never imports server-side modules — and renders the
// existing a2a.* bus events live. Until the A2A-014 control plane lands,
// demo/control-stub.ts serves the same contract in front of a real loopback
// peer (OPENCODE_A2A_ADMIN_URL).

import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import type {
  TuiDialogSelectOption,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import {
  A2ATaskEventPropertiesSchema,
  A2ATurnEventPropertiesSchema,
  type Artifact,
  type TaskState,
} from "a2a"
import {
  ControlError,
  createControl,
  resolveControl,
  type A2AControl,
  type ControlPeer,
  type ControlSession,
  type ControlTurn,
  type PeersInfo,
} from "./control.ts"
import {
  artifactText,
  canCancel,
  directionMark,
  formatAge,
  isCapMessage,
  isTerminal,
  mergePeers,
  sessionPeer,
  shortId,
  sortSessions,
  stateLabel,
  stateTone,
  turnText,
  type StateTone,
} from "./format.ts"

const MODE = "a2a"
const POLL_MS = 2500

type LiveTask = { state?: TaskState; content?: string; artifact?: Artifact }

type Panel = {
  api: TuiPluginApi
  control(): Promise<A2AControl | undefined>
  reset(): void
  // Bumped on every a2a.* bus event; views refetch/rerender off it.
  revision(): number
  turns(taskId: string): readonly ControlTurn[]
  seed(taskId: string, turns: readonly ControlTurn[]): void
  live(taskId: string): LiveTask | undefined
  prompt(props: {
    title: string
    description?: () => JSX.Element
    placeholder?: string
  }): Promise<string | undefined>
  confirm(title: string, message: string): Promise<boolean>
  choose<T>(title: string, options: TuiDialogSelectOption<T>[]): Promise<T | undefined>
  busy(title: string, text: string): void
  toast(message: string, variant?: "info" | "success" | "warning" | "error"): void
  showSessions(): void
  showPeers(): void
  showThread(taskId: string): void
  startFlow(): void
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function toneColor(api: TuiPluginApi, tone: StateTone) {
  const theme = api.theme.current
  switch (tone) {
    case "success":
      return theme.success
    case "warning":
      return theme.warning
    case "error":
      return theme.error
    case "muted":
      return theme.textMuted
    default:
      return theme.primary
  }
}

function Hints(props: { api: TuiPluginApi; items: readonly (readonly [string, string])[] }) {
  const theme = props.api.theme.current
  return (
    <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2}>
      <For each={props.items}>
        {(item) => (
          <text>
            <span style={{ fg: theme.text }}>{item[0]}</span>
            <span style={{ fg: theme.textMuted }}> {item[1]}</span>
          </text>
        )}
      </For>
    </box>
  )
}

function Notice(props: { api: TuiPluginApi; title: string; message: string }) {
  const theme = props.api.theme.current
  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>{props.message}</text>
    </box>
  )
}

function BusyView(props: { panel: Panel; title: string; text: string }) {
  const theme = props.panel.api.theme.current
  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {props.title}
      </text>
      <text fg={theme.textMuted}>{props.text}</text>
    </box>
  )
}

type SessionRow = { kind: "session"; session: ControlSession } | { kind: "new" } | { kind: "peers" }

function SessionsView(props: { panel: Panel }) {
  const api = props.panel.api
  const theme = api.theme.current
  const [sessions, setSessions] = createSignal<ControlSession[]>([])
  const [status, setStatus] = createSignal<"loading" | "ready" | "unavailable" | "error">("loading")
  const [error, setError] = createSignal("")

  api.ui.dialog.setSize("large")

  const refresh = async () => {
    const ctl = await props.panel.control()
    if (!ctl) {
      setStatus("unavailable")
      return
    }
    try {
      setSessions(sortSessions(await ctl.sessions()))
      setStatus("ready")
    } catch (cause) {
      props.panel.reset()
      setStatus("error")
      setError(errorMessage(cause))
    }
  }

  createEffect(() => {
    props.panel.revision()
    void refresh()
  })
  const timer = setInterval(() => void refresh(), POLL_MS)
  onCleanup(() => clearInterval(timer))

  const rows = createMemo<TuiDialogSelectOption<SessionRow>[]>(() => [
    ...sessions().map((session) => ({
      title: `${directionMark(session.direction)} ${sessionPeer(session)}`,
      value: { kind: "session", session } as SessionRow,
      category: "Sessions",
      description: [
        shortId(session.taskId),
        `${session.turns ?? "-"} turns`,
        formatAge(session.updatedAt ?? session.createdAt),
      ]
        .filter((part) => part)
        .join(" · "),
      footer: (
        <span style={{ fg: toneColor(api, stateTone(session.state)) }}>{stateLabel(session.state)}</span>
      ),
    })),
    {
      title: "New conversation",
      value: { kind: "new" },
      category: "Actions",
      description: "start a task with a configured peer",
    },
    {
      title: "Manage peers",
      value: { kind: "peers" },
      category: "Actions",
      description: "view, add, remove, and test allowedPeers",
    },
  ])

  const pick = (option: TuiDialogSelectOption<SessionRow>) => {
    if (option.value.kind === "new") return props.panel.startFlow()
    if (option.value.kind === "peers") return props.panel.showPeers()
    props.panel.showThread(option.value.session.taskId)
  }

  // Top-level must be an intrinsic: dialog.replace thunks are unrolled in a
  // tracked scope, and a component/accessor return value would re-track our
  // signals there — every state change would remount the whole view.
  return (
    <box flexDirection="column" flexGrow={1}>
      <Show
        when={status() === "ready"}
        fallback={
          <Notice
            api={api}
            title="A2A sessions"
            message={
              status() === "loading"
                ? "Loading sessions…"
                : status() === "unavailable"
                  ? "A2A control API not reachable. Enable the a2a plugin so its admin endpoint runs, or point OPENCODE_A2A_ADMIN_URL at demo/control-stub.ts."
                  : `A2A control API error: ${error()}`
            }
          />
        }
      >
        <api.ui.DialogSelect
          title="A2A sessions"
          placeholder="Filter sessions"
          options={rows()}
          onSelect={pick}
        />
        <Show when={sessions().length === 0}>
          <box paddingLeft={4}>
            <text fg={theme.textMuted}>No sessions yet — select “New conversation” to start one.</text>
          </box>
        </Show>
        <Hints
          api={api}
          items={[
            ["enter", "open"],
            ["esc", "close"],
          ]}
        />
      </Show>
    </box>
  )
}

type PeerRow = { kind: "peer"; peer: ControlPeer } | { kind: "add" } | { kind: "back" }

function PeersView(props: { panel: Panel }) {
  const api = props.panel.api
  const theme = api.theme.current
  const [info, setInfo] = createSignal<PeersInfo>()
  const [status, setStatus] = createSignal<"loading" | "ready" | "unavailable" | "error">("loading")
  const [error, setError] = createSignal("")

  api.ui.dialog.setSize("large")

  const refresh = async () => {
    const ctl = await props.panel.control()
    if (!ctl) {
      setStatus("unavailable")
      return
    }
    try {
      setInfo(await ctl.peers())
      setStatus("ready")
    } catch (cause) {
      props.panel.reset()
      setStatus("error")
      setError(errorMessage(cause))
    }
  }
  createEffect(() => {
    props.panel.revision()
    void refresh()
  })

  const rows = createMemo<TuiDialogSelectOption<PeerRow>[]>(() => [
    ...(info()?.peers ?? []).map((peer) => ({
      title: peer.name,
      value: { kind: "peer", peer } as PeerRow,
      category: "Peers",
      description: peer.url,
    })),
    { title: "Add peer", value: { kind: "add" } as PeerRow, category: "Actions", description: "add an allowedPeers entry" },
    { title: "Back to sessions", value: { kind: "back" } as PeerRow, category: "Actions" },
  ])

  const pick = (option: TuiDialogSelectOption<PeerRow>) => {
    if (option.value.kind === "add") return void addFlow()
    if (option.value.kind === "back") return props.panel.showSessions()
    void peerMenu(option.value.peer)
  }

  const writable = () => info()?.writable !== false

  const blocked = () => {
    props.panel.toast(
      info()?.hint ?? "allowedPeers is not editable through this endpoint — edit opencode.json by hand.",
      "warning",
    )
    props.panel.showPeers()
  }

  const addFlow = async () => {
    if (!writable()) return blocked()
    const name = (
      await props.panel.prompt({
        title: "New peer",
        placeholder: "name (local label)",
        description: () => (
          <text fg={theme.textMuted}>The local label for this peer — their agent-card name may differ.</text>
        ),
      })
    )?.trim()
    if (!name) return props.panel.showPeers()
    const url = (await props.panel.prompt({ title: `URL for ${name}`, placeholder: "http://host:port" }))?.trim()
    if (!url) return props.panel.showPeers()
    try {
      new URL(url)
    } catch {
      props.panel.toast(`Invalid URL for peer "${name}": ${url}`, "error")
      return props.panel.showPeers()
    }
    const ctl = await props.panel.control()
    if (!ctl) return props.panel.showPeers()
    props.panel.busy("Add peer", `Saving ${name}…`)
    try {
      await ctl.addPeer(name, url)
      props.panel.toast(`Added peer ${name}`, "success")
    } catch (cause) {
      props.panel.toast(errorMessage(cause), "error")
    }
    props.panel.showPeers()
  }

  const peerMenu = async (peer: ControlPeer) => {
    const action = await props.panel.choose(`Peer ${peer.name}`, [
      { title: "Test", value: "test" as const, description: "fetch the peer's agent card" },
      { title: "Remove", value: "remove" as const, description: `delete ${peer.name} from allowedPeers` },
      { title: "Back", value: "back" as const },
    ])
    if (!action || action === "back") return props.panel.showPeers()
    const ctl = await props.panel.control()
    if (!ctl) return props.panel.showPeers()
    if (action === "test") {
      props.panel.busy("Test peer", `Fetching agent card from ${peer.name}…`)
      try {
        const result = await ctl.testPeer(peer.name)
        props.panel.toast(
          result.ok ? `${peer.name} claims “${result.name ?? "unnamed"}”` : (result.error ?? `${peer.name} did not answer`),
          result.ok ? "success" : "error",
        )
      } catch (cause) {
        props.panel.toast(errorMessage(cause), "error")
      }
      return props.panel.showPeers()
    }
    if (!writable()) return blocked()
    const ok = await props.panel.confirm("Remove peer", `Remove ${peer.name} (${peer.url}) from allowedPeers?`)
    if (!ok) return props.panel.showPeers()
    props.panel.busy("Remove peer", `Removing ${peer.name}…`)
    try {
      await ctl.removePeer(peer.name)
      props.panel.toast(`Removed peer ${peer.name}`, "success")
    } catch (cause) {
      props.panel.toast(errorMessage(cause), "error")
    }
    props.panel.showPeers()
  }

  const self = () => {
    const own = info()?.self
    if (!own) return
    const listen = own.port === undefined ? "not listening" : `listening :${own.port}`
    return `you: ${own.name ?? "unnamed"} · ${listen}`
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show
        when={status() === "ready"}
        fallback={
          <Notice
            api={api}
            title="A2A peers"
            message={
              status() === "loading"
                ? "Loading peers…"
                : status() === "unavailable"
                  ? "A2A control API not reachable."
                  : `A2A control API error: ${error()}`
            }
          />
        }
      >
        <api.ui.DialogSelect title="A2A peers" placeholder="Filter peers" options={rows()} onSelect={pick} />
        <box paddingLeft={4} flexDirection="column">
          <Show when={self()}>{(label) => <text fg={theme.textMuted}>{label()}</text>}</Show>
          <Show when={!writable()}>
            <text fg={theme.textMuted}>{info()?.hint ?? "peers are read-only here"}</text>
          </Show>
        </box>
        <Hints
          api={api}
          items={[
            ["enter", "select"],
            ["esc", "close"],
          ]}
        />
      </Show>
    </box>
  )
}

function ThreadView(props: { panel: Panel; taskId: string }) {
  const api = props.panel.api
  const theme = api.theme.current
  const size = useTerminalDimensions()
  const [session, setSession] = createSignal<ControlSession>()
  const [status, setStatus] = createSignal<"loading" | "ready" | "missing" | "error">("loading")
  const [error, setError] = createSignal("")
  let box: ScrollBoxRenderable | undefined

  onCleanup(api.mode.push(MODE))
  api.ui.dialog.setSize("xlarge")

  const refresh = async () => {
    const ctl = await props.panel.control()
    if (!ctl) {
      setStatus("missing")
      setError("A2A control API not reachable.")
      return
    }
    try {
      const detail = await ctl.session(props.taskId)
      setSession(detail.session)
      props.panel.seed(props.taskId, detail.turns)
      setStatus("ready")
    } catch (cause) {
      if (cause instanceof ControlError && cause.status === 404) {
        setStatus("missing")
        setError(`Task ${shortId(props.taskId)} is no longer in the registry.`)
        return
      }
      props.panel.reset()
      setStatus("error")
      setError(errorMessage(cause))
    }
  }

  createEffect(() => {
    props.panel.revision()
    void refresh()
  })
  const timer = setInterval(() => void refresh(), POLL_MS)
  onCleanup(() => clearInterval(timer))

  const state = () => props.panel.live(props.taskId)?.state ?? session()?.state ?? "TASK_STATE_UNSPECIFIED"
  const liveContent = () => props.panel.live(props.taskId)?.content ?? session()?.content
  const artifact = () => props.panel.live(props.taskId)?.artifact ?? session()?.artifact
  const turns = () => props.panel.turns(props.taskId)

  const sendReply = async () => {
    const text = (await props.panel.prompt({ title: `Reply · ${shortId(props.taskId)}`, placeholder: "message" }))?.trim()
    const ctl = await props.panel.control()
    if (!text || !ctl) return props.panel.showThread(props.taskId)
    props.panel.busy("A2A task", "Sending…")
    try {
      await ctl.reply(props.taskId, text)
    } catch (cause) {
      props.panel.toast(errorMessage(cause), "error")
    }
    props.panel.showThread(props.taskId)
  }

  const cancelTask = async () => {
    const ok = await props.panel.confirm(
      "Cancel task",
      `Cancel task ${shortId(props.taskId)} with ${session()?.peerId ?? "peer"}?`,
    )
    if (!ok) return props.panel.showThread(props.taskId)
    const ctl = await props.panel.control()
    if (!ctl) return props.panel.showThread(props.taskId)
    try {
      await ctl.cancel(props.taskId)
      props.panel.toast("Task canceled", "success")
    } catch (cause) {
      props.panel.toast(errorMessage(cause), "error")
    }
    props.panel.showThread(props.taskId)
  }

  onCleanup(
    api.keymap.registerLayer({
      mode: MODE,
      bindings: [
        { key: "m", desc: "Reply", group: "A2A", cmd: () => void sendReply() },
        { key: "return", desc: "Reply", group: "A2A", cmd: () => void sendReply() },
        {
          key: "x",
          desc: "Cancel task",
          group: "A2A",
          cmd: () => {
            if (canCancel(state())) void cancelTask()
          },
        },
        { key: "r", desc: "Refresh", group: "A2A", cmd: () => void refresh() },
        { key: "b", desc: "Back to sessions", group: "A2A", cmd: () => props.panel.showSessions() },
        { key: "backspace", desc: "Back to sessions", group: "A2A", cmd: () => props.panel.showSessions() },
        { key: "up", desc: "Scroll up", group: "A2A", cmd: () => box?.scrollBy(-1) },
        { key: "down", desc: "Scroll down", group: "A2A", cmd: () => box?.scrollBy(1) },
        { key: "pageup", desc: "Page up", group: "A2A", cmd: () => box?.scrollBy(-10) },
        { key: "pagedown", desc: "Page down", group: "A2A", cmd: () => box?.scrollBy(10) },
      ],
    }),
  )

  return (
    <box flexDirection="column" gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          <Show when={session()} fallback="A2A task">
            {(item) => `${directionMark(item().direction)} ${sessionPeer(item())}`}
          </Show>
          <span style={{ fg: theme.textMuted }}> · {shortId(props.taskId)}</span>
        </text>
        <text fg={theme.textMuted} onMouseUp={() => api.ui.dialog.clear()}>
          esc
        </text>
      </box>
      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2}>
        <text fg={toneColor(api, stateTone(state()))}>{stateLabel(state())}</text>
        <Show when={isCapMessage(liveContent())}>
          <text fg={theme.textMuted}>{liveContent()}</text>
        </Show>
      </box>
      <Show
        when={status() === "ready"}
        fallback={
          <box paddingLeft={2} paddingRight={2}>
            <text fg={theme.textMuted}>{status() === "loading" ? "Loading task…" : error()}</text>
          </box>
        }
      >
        <scrollbox
          flexGrow={1}
          maxHeight={Math.max(6, Math.floor(size().height * 0.55))}
          stickyScroll={true}
          stickyStart="bottom"
          paddingLeft={2}
          paddingRight={2}
          ref={(r: ScrollBoxRenderable) => (box = r)}
        >
          <For each={turns()} fallback={<text fg={theme.textMuted}>Waiting for the first turn…</text>}>
            {(turn, index) => (
              <box flexDirection="column" marginBottom={1}>
                <text>
                  <Show
                    when={turn.speaker === "local"}
                    fallback={
                      <span style={{ fg: theme.primary, attributes: TextAttributes.BOLD }}>
                        {turn.peerId ?? session()?.peerId ?? "peer"}
                      </span>
                    }
                  >
                    <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>you</span>
                  </Show>
                  <span style={{ fg: theme.textMuted }}> · turn {turn.index ?? index()}</span>
                </text>
                <text fg={theme.text} wrapMode="word">
                  {turnText(turn)}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
        <Show when={artifactText(artifact())}>
          {(verdict) => (
            <box flexDirection="column" paddingLeft={2} paddingRight={2}>
              <text fg={theme.warning} attributes={TextAttributes.BOLD}>
                verdict
              </text>
              <text fg={theme.text} wrapMode="word">
                {verdict()}
              </text>
            </box>
          )}
        </Show>
      </Show>
      <Hints
        api={api}
        items={
          status() === "ready"
            ? [
                ...(isTerminal(state()) ? [] : ([["m", "reply"]] as const)),
                ...(canCancel(state()) ? ([["x", "cancel"]] as const) : []),
                ["b", "sessions"],
                ["r", "refresh"],
                ["esc", "close"],
              ]
            : [["esc", "close"]]
        }
      />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  let pending: Promise<A2AControl | undefined> | undefined

  const control = () => {
    pending ??= resolveControl({
      env: process.env,
      // The generated SDK keeps the client's base URL private; read it
      // anyway — the control API may be hosted on the opencode server.
      serverUrl: (api.client as unknown as { client?: { getConfig?: () => { baseUrl?: string } } }).client
        ?.getConfig?.().baseUrl,
      directories: [...new Set([api.state.path.worktree, api.state.path.directory].filter(Boolean))],
    }).then((found) => (found ? createControl(found.base) : undefined))
    return pending
  }
  const reset = () => {
    pending = undefined
  }

  const [revision, setRevision] = createSignal(0)
  const bump = () => setRevision((value) => value + 1)

  const turnsByTask = new Map<string, ControlTurn[]>()
  const liveByTask = new Map<string, LiveTask>()

  // The generated SDK's Event union does not know the plugin's a2a.* types,
  // but the bus carries any { type, properties } payload.
  const on = api.event.on as unknown as (
    type: string,
    handler: (event: { type: string; properties?: unknown }) => void,
  ) => () => void

  const unsubs = [
    on("a2a.conversation.turn", (event) => {
      const parsed = A2ATurnEventPropertiesSchema.safeParse(event.properties)
      if (!parsed.success || !parsed.data.taskId) return
      const taskId = parsed.data.taskId
      const turn: ControlTurn = {
        index: parsed.data.turn,
        speaker: parsed.data.speaker,
        peerId: parsed.data.peerId,
        content: parsed.data.content,
      }
      const list = [...(turnsByTask.get(taskId) ?? [])]
      const found = turn.index === undefined ? -1 : list.findIndex((item) => item.index === turn.index)
      if (found >= 0) {
        if (turnText(list[found]) === turnText(turn)) return
        list[found] = turn
      } else {
        list.push(turn)
      }
      list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      turnsByTask.set(taskId, list)
      bump()
    }),
    ...["a2a.task.dispatched", "a2a.task.updated", "a2a.task.completed", "a2a.task.failed"].map((type) =>
      on(type, (event) => {
        const parsed = A2ATaskEventPropertiesSchema.safeParse(event.properties)
        if (!parsed.success) return
        liveByTask.set(parsed.data.taskId, {
          state: parsed.data.state,
          content: parsed.data.content,
          artifact: parsed.data.artifact,
        })
        bump()
      }),
    ),
  ]
  for (const unsub of unsubs) api.lifecycle.onDispose(unsub)

  function startFlow() {
    void (async () => {
      const ctl = await control()
      if (!ctl) {
        api.ui.dialog.replace(() => (
          <Notice
            api={api}
            title="A2A: new conversation"
            message="A2A control API not reachable. Enable the a2a plugin so its admin endpoint runs, or point OPENCODE_A2A_ADMIN_URL at demo/control-stub.ts."
          />
        ))
        return
      }
      panel.busy("A2A: new conversation", "Loading peers…")
      let peers: PeersInfo
      let sessions: ControlSession[]
      try {
        ;[peers, sessions] = await Promise.all([ctl.peers(), ctl.sessions()])
      } catch (cause) {
        reset()
        panel.toast(errorMessage(cause), "error")
        return panel.showSessions()
      }
      const merged = mergePeers(peers.peers, sessions)
      if (merged.length === 0) {
        api.ui.dialog.replace(() => (
          <Notice
            api={api}
            title="A2A: new conversation"
            message={peers.hint ?? "No peers configured — add one under A2A: Peers first."}
          />
        ))
        return
      }
      const peer = await panel.choose(
        "A2A: new conversation",
        merged.map((entry) => ({
          title: entry.name,
          value: entry,
          description: entry.url ?? "seen in sessions · no URL — add one under A2A: Peers",
        })),
      )
      if (!peer) return panel.showSessions()
      if (!peer.url) {
        panel.toast(`${peer.name} has no URL — add one under A2A: Peers.`, "warning")
        return panel.showPeers()
      }
      const text = (
        await panel.prompt({
          title: `Message to ${peer.name}`,
          placeholder: "What should the peer work on?",
          description: () => (
            <text fg={api.theme.current.textMuted}>{peer.url} · runs to the turn cap unless it finishes early.</text>
          ),
        })
      )?.trim()
      if (!text) return panel.showSessions()
      panel.busy("A2A: new conversation", `Starting with ${peer.name}…`)
      try {
        const session = await ctl.start(peer.name, text)
        panel.showThread(session.taskId)
      } catch (cause) {
        panel.toast(errorMessage(cause), "error")
        panel.showSessions()
      }
    })()
  }

  const panel: Panel = {
    api,
    control,
    reset,
    revision,
    turns: (taskId) => {
      revision()
      return turnsByTask.get(taskId) ?? []
    },
    live: (taskId) => {
      revision()
      return liveByTask.get(taskId)
    },
    seed: (taskId, fetched) => {
      // Merge event-fed turns the fetch has not caught up to yet, and only
      // bump when content changed so the refetch effect cannot loop.
      const merged = [
        ...fetched,
        ...(turnsByTask.get(taskId) ?? []).filter(
          (turn) => turn.index !== undefined && !fetched.some((item) => item.index === turn.index),
        ),
      ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      const prev = turnsByTask.get(taskId) ?? []
      const same =
        merged.length === prev.length &&
        merged.every(
          (turn, index) =>
            turn.index === prev[index].index &&
            turn.speaker === prev[index].speaker &&
            turn.peerId === prev[index].peerId &&
            turnText(turn) === turnText(prev[index]),
        )
      if (same) return
      turnsByTask.set(taskId, merged)
      bump()
    },
    prompt: (props) =>
      new Promise<string | undefined>((resolve) => {
        api.ui.dialog.replace(
          () => (
            <api.ui.DialogPrompt
              title={props.title}
              placeholder={props.placeholder}
              description={props.description}
              onConfirm={(value) => resolve(value)}
            />
          ),
          () => resolve(undefined),
        )
      }),
    confirm: (title, message) =>
      new Promise<boolean>((resolve) => {
        api.ui.dialog.replace(
          () => (
            <api.ui.DialogConfirm
              title={title}
              message={message}
              onConfirm={() => resolve(true)}
              onCancel={() => resolve(false)}
            />
          ),
          () => resolve(false),
        )
      }),
    choose: (title, options) =>
      new Promise((resolve) => {
        api.ui.dialog.replace(
          () => <api.ui.DialogSelect title={title} options={options} onSelect={(option) => resolve(option.value)} />,
          () => resolve(undefined),
        )
      }),
    busy: (title, text) => api.ui.dialog.replace(() => <BusyView panel={panel} title={title} text={text} />),
    toast: (message, variant = "info") => api.ui.toast({ message, variant }),
    showSessions: () => api.ui.dialog.replace(() => <SessionsView panel={panel} />),
    showPeers: () => api.ui.dialog.replace(() => <PeersView panel={panel} />),
    showThread: (taskId) => api.ui.dialog.replace(() => <ThreadView panel={panel} taskId={taskId} />),
    startFlow,
  }

  api.lifecycle.onDispose(
    api.keymap.registerLayer({
      commands: [
        {
          name: "a2a.new",
          title: "A2A: New conversation",
          category: "A2A",
          namespace: "palette",
          run: () => panel.startFlow(),
        },
        {
          name: "a2a.sessions",
          title: "A2A: Sessions",
          category: "A2A",
          namespace: "palette",
          run: () => panel.showSessions(),
        },
        {
          name: "a2a.peers",
          title: "A2A: Peers",
          category: "A2A",
          namespace: "palette",
          run: () => panel.showPeers(),
        },
      ],
      bindings: [
        ...(api.tuiConfig.keybinds.has("a2a.sessions")
          ? []
          : [{ key: "ctrl+alt+a", cmd: "a2a.sessions", desc: "A2A sessions", group: "A2A" }]),
        ...api.tuiConfig.keybinds.gather("a2a.palette", ["a2a.new", "a2a.sessions", "a2a.peers"]),
      ],
    }),
  )
}

const plugin: TuiPluginModule = {
  id: "a2a",
  tui,
}

export default plugin
