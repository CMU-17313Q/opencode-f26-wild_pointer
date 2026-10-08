import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { For, Show, createMemo, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import {
  ADMIN_PORT_PATH,
  A2AControlError,
  createA2AControl,
  type A2AConversationResult,
  type A2APeer,
  type A2ASessionRecord,
} from "@/a2a/control"
import { applyA2AEvent, threadFor, type A2AThreadData, type A2AThreads } from "@/a2a/thread-store"
import { A2AThread } from "@/components/session/a2a-thread"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"
import { legacySessionHref } from "@/utils/session-route"
import { useNavigate } from "@solidjs/router"

type HubView = "start" | "browse" | "detail"

const TERMINAL_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
])

export interface DialogA2AHubProps {
  initialView?: HubView
}

export const DialogA2AHub: Component<DialogA2AHubProps> = (props) => {
  const language = useLanguage()
  const sdk = useSDK()
  const dialog = useDialog()
  const navigate = useNavigate()
  const showSettings = useSettingsDialog("a2a")

  const [store, setStore] = createStore({
    view: (props.initialView ?? "start") as HubView,
    pluginMissing: false,
    peers: [] as A2APeer[],
    peersLoading: false,
    peersError: false,
    peer: "",
    message: "",
    starting: false,
    sessions: [] as A2ASessionRecord[],
    sessionsLoading: false,
    sessionsError: false,
    detailId: "",
    threads: {} as A2AThreads,
    cancelPending: false,
    followUpPending: false,
  })

  const control = createMemo(() =>
    createA2AControl({
      directory: sdk().directory,
      readPort: () => {
        const client = sdk().client
        return client.file
          .read({ path: ADMIN_PORT_PATH })
          .then((result) => result.data?.content)
          .catch(() => undefined)
      },
    }),
  )

  const errorText = (error: unknown) => {
    if (error instanceof A2AControlError) {
      if (error.kind === "port") return language.t("a2a.error.port")
      if (error.kind === "network") return language.t("a2a.error.network")
      return error.message
    }
    return error instanceof Error ? error.message : String(error)
  }

  const loadPeers = async () => {
    setStore("peersLoading", true)
    setStore("peersError", false)
    try {
      const peers = await control().listPeers()
      setStore("peers", peers)
      setStore("pluginMissing", false)
      if (!peers.some((peer) => peer.name === store.peer)) setStore("peer", peers[0]?.name ?? "")
    } catch (error) {
      if (error instanceof A2AControlError && error.kind === "port") setStore("pluginMissing", true)
      setStore("peersError", true)
      setStore("peers", [])
    } finally {
      setStore("peersLoading", false)
    }
  }

  const loadSessions = async () => {
    setStore("sessionsLoading", true)
    setStore("sessionsError", false)
    try {
      setStore("sessions", await control().listSessions())
      setStore("pluginMissing", false)
    } catch (error) {
      if (error instanceof A2AControlError && error.kind === "port") setStore("pluginMissing", true)
      setStore("sessionsError", true)
    } finally {
      setStore("sessionsLoading", false)
    }
  }

  onMount(() => {
    void loadPeers()
    void loadSessions()
  })

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void loadSessions(), 250)
  }

  const stop = sdk().event.listen((event) => {
    const details = event.details as { type?: string; properties?: unknown }
    if (details.type === undefined || !details.type.startsWith("a2a.")) return
    setStore("threads", (threads) => applyA2AEvent(threads, details.type as string, details.properties))
    if (details.type !== "a2a.conversation.turn") scheduleRefresh()
  })
  onCleanup(stop)
  onCleanup(() => {
    if (refreshTimer) clearTimeout(refreshTimer)
  })

  const detail = createMemo(() => store.sessions.find((record) => record.taskId === store.detailId))

  const detailThread = createMemo<A2AThreadData>(() => {
    const record = detail()
    const thread = threadFor(store.threads, store.detailId)
    if (!record) return thread
    return {
      ...thread,
      taskId: store.detailId,
      states: thread.states.length > 0 ? thread.states : [record.state],
      status: thread.status ?? record.message,
    }
  })

  const activeDetail = () => {
    const record = detail()
    return record !== undefined && !TERMINAL_STATES.has(record.state)
  }
  const canFollowUp = () => {
    const record = detail()
    return record !== undefined && record.direction === "outbound" && !TERMINAL_STATES.has(record.state)
  }

  const upsert = (record: A2ASessionRecord) => {
    setStore("sessions", (records) => {
      const exists = records.some((entry) => entry.taskId === record.taskId)
      if (!exists) return [record, ...records]
      return records.map((entry) => (entry.taskId === record.taskId ? record : entry))
    })
  }

  const openDetail = async (taskId: string) => {
    setStore("detailId", taskId)
    setStore("view", "detail")
    if (store.sessions.some((record) => record.taskId === taskId)) return
    try {
      upsert(await control().getSession(taskId))
    } catch {
      // The detail renders from the event store when the registry has no record.
    }
  }

  const start = async () => {
    const peer = store.peer
    const message = store.message.trim()
    if (peer === "" || message === "" || store.starting) return
    setStore("starting", true)
    try {
      const result: A2AConversationResult = await control().startConversation({ peer, message, origin: "app" })
      setStore("message", "")
      if (result.taskId !== undefined) {
        setStore("detailId", result.taskId)
        if (store.view === "start") setStore("view", "detail")
      }
      void loadSessions()
    } catch (error) {
      showToast({ title: language.t("a2a.hub.start.error"), description: errorText(error) })
    } finally {
      setStore("starting", false)
    }
  }

  const cancel = async (taskId: string) => {
    if (store.cancelPending) return
    setStore("cancelPending", true)
    try {
      await control().cancelConversation(taskId)
      void loadSessions()
    } catch (error) {
      showToast({ title: language.t("a2a.hub.detail.error"), description: errorText(error) })
    } finally {
      setStore("cancelPending", false)
    }
  }

  const followUp = async (text: string) => {
    const taskId = store.detailId
    if (taskId === "" || store.followUpPending) return
    setStore("followUpPending", true)
    try {
      await control().sendMessage(taskId, text)
      void loadSessions()
    } catch (error) {
      showToast({ title: language.t("a2a.hub.detail.error"), description: errorText(error) })
      throw error
    } finally {
      setStore("followUpPending", false)
    }
  }

  const openSession = (sessionId: string) => {
    dialog.close()
    navigate(legacySessionHref(sdk().directory, sessionId))
  }

  const relative = createMemo(() => new Intl.RelativeTimeFormat(language.intl(), { numeric: "auto" }))
  const age = (timestamp: number) => {
    const diff = timestamp - Date.now()
    const absolute = Math.abs(diff)
    if (absolute < 60_000) return relative().format(Math.round(diff / 1000), "second")
    if (absolute < 3_600_000) return relative().format(Math.round(diff / 60_000), "minute")
    if (absolute < 86_400_000) return relative().format(Math.round(diff / 3_600_000), "hour")
    return relative().format(Math.round(diff / 86_400_000), "day")
  }

  const directionLabel = (direction: A2ASessionRecord["direction"]) =>
    language.t(direction === "inbound" ? "a2a.hub.direction.inbound" : "a2a.hub.direction.outbound")
  const originLabel = (origin: A2ASessionRecord["origin"]) => language.t(`a2a.hub.origin.${origin}`)

  return (
    <Dialog size="large" class="h-full w-full">
      <DialogHeader>
        <DialogTitle>{language.t("a2a.hub.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <Show
          when={!store.pluginMissing}
          fallback={
            <div class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <div class="text-13-medium text-text-strong">{language.t("a2a.hub.disabled.title")}</div>
              <div class="max-w-96 text-12-regular text-text-weak">{language.t("a2a.hub.disabled.description")}</div>
              <ButtonV2 size="small" variant="outline" onClick={() => showSettings()}>
                {language.t("a2a.hub.disabled.action")}
              </ButtonV2>
            </div>
          }
        >
          <div class="flex items-center gap-1">
            <ButtonV2
              size="small"
              variant={store.view === "start" ? "contrast" : "ghost"}
              onClick={() => setStore("view", "start")}
            >
              {language.t("a2a.hub.tab.new")}
            </ButtonV2>
            <ButtonV2
              size="small"
              variant={store.view === "browse" || store.view === "detail" ? "contrast" : "ghost"}
              onClick={() => setStore("view", "browse")}
            >
              {language.t("a2a.hub.tab.sessions")}
            </ButtonV2>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <Show when={store.view === "start"}>
              <div class="flex flex-col gap-3">
                <Show
                  when={store.peers.length > 0}
                  fallback={
                    <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-4">
                      <span class="text-12-regular text-text-weak">
                        {store.peersError ? language.t("a2a.hub.peers.error") : language.t("a2a.hub.peers.empty")}
                      </span>
                      <span class="text-11-regular text-text-weak">{language.t("a2a.hub.peers.emptyHint")}</span>
                      <ButtonV2 size="small" variant="outline" onClick={() => showSettings()}>
                        {language.t("a2a.hub.disabled.action")}
                      </ButtonV2>
                    </div>
                  }
                >
                  <label class="flex flex-col gap-1 text-11-medium text-text-weak">
                    {language.t("a2a.hub.start.peer")}
                    <SelectV2
                      appearance="base"
                      options={store.peers}
                      current={store.peers.find((peer) => peer.name === store.peer)}
                      value={(peer) => peer.name}
                      label={(peer) => peer.name}
                      placeholder={language.t("a2a.hub.start.peer.placeholder")}
                      onSelect={(peer) => peer && setStore("peer", peer.name)}
                    />
                  </label>
                  <label class="flex flex-col gap-1 text-11-medium text-text-weak">
                    {language.t("a2a.hub.start.message")}
                    <TextareaV2
                      rows={4}
                      value={store.message}
                      placeholder={language.t("a2a.hub.start.message.placeholder")}
                      disabled={store.starting}
                      onInput={(event) => setStore("message", event.currentTarget.value)}
                    />
                  </label>
                  <div class="flex items-center gap-2">
                    <ButtonV2
                      size="small"
                      variant="contrast"
                      disabled={store.starting || store.peer === "" || store.message.trim() === ""}
                      onClick={() => void start()}
                    >
                      {language.t("a2a.hub.start.submit")}
                    </ButtonV2>
                    <Show when={store.starting}>
                      <span class="text-11-regular text-text-weak">{language.t("a2a.hub.start.pending")}</span>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={store.view === "browse"}>
              <SessionsList
                records={store.sessions}
                loading={store.sessionsLoading}
                error={store.sessionsError}
                onOpen={(taskId) => void openDetail(taskId)}
                onCancel={(taskId) => void cancel(taskId)}
                onOpenSession={openSession}
                age={age}
                directionLabel={directionLabel}
              />
            </Show>

            <Show when={store.view === "detail"}>
              <div class="flex flex-col gap-3">
                <div class="flex items-center gap-2">
                  <ButtonV2 size="small" variant="ghost" onClick={() => setStore("view", "browse")}>
                    {language.t("a2a.hub.back")}
                  </ButtonV2>
                  <span class="truncate text-11-regular text-text-weak">{store.detailId}</span>
                </div>
                <Show when={detail()}>
                  {(record) => (
                    <div class="rounded-md border border-border-weak-base bg-surface-panel p-3">
                      <div class="flex flex-wrap items-center gap-2 text-12-medium text-text-strong">
                        <span>{record().peerId ?? originLabel(record().origin)}</span>
                        <span class="text-text-weak">·</span>
                        <span class="text-text-weak">{directionLabel(record().direction)}</span>
                        <span class="text-text-weak">·</span>
                        <span class="text-text-weak">{record().state}</span>
                        <span class="text-text-weak">·</span>
                        <span class="text-text-weak">{age(record().updatedAt)}</span>
                      </div>
                      <div class="mt-2 flex items-center gap-2">
                        <Show when={record().sessionId}>
                          {(sessionId) => (
                            <ButtonV2 size="small" variant="outline" onClick={() => openSession(sessionId())}>
                              {language.t("a2a.hub.sessions.open")}
                            </ButtonV2>
                          )}
                        </Show>
                        <Show when={activeDetail()}>
                          <ButtonV2
                            size="small"
                            variant="danger"
                            disabled={store.cancelPending}
                            onClick={() => void cancel(record().taskId)}
                          >
                            {language.t("a2a.hub.sessions.cancel")}
                          </ButtonV2>
                        </Show>
                      </div>
                    </div>
                  )}
                </Show>
                <Show
                  when={detailThread().turns.length > 0}
                  fallback={
                    <div class="rounded-md border border-border-weak-base p-4 text-12-regular text-text-weak">
                      <Show
                        when={detailThread().status}
                        fallback={<span>{language.t("a2a.hub.detail.noTurns")}</span>}
                      >
                        <span>{detailThread().status}</span>
                      </Show>
                    </div>
                  }
                >
                  <A2AThread
                    data={detailThread()}
                    onCancel={activeDetail() ? () => void cancel(store.detailId) : undefined}
                    isRunning={() => !store.cancelPending}
                    onFollowUp={canFollowUp() ? followUp : undefined}
                    followUpPending={store.followUpPending}
                  />
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </DialogBody>
    </Dialog>
  )
}

interface SessionsListProps {
  records: A2ASessionRecord[]
  loading: boolean
  error: boolean
  onOpen: (taskId: string) => void
  onCancel: (taskId: string) => void
  onOpenSession: (sessionId: string) => void
  age: (timestamp: number) => string
  directionLabel: (direction: A2ASessionRecord["direction"]) => string
}

function SessionsList(props: SessionsListProps) {
  const language = useLanguage()
  return (
    <Show
      when={props.records.length > 0}
      fallback={
        <div class="rounded-md border border-border-weak-base p-4 text-12-regular text-text-weak">
          <Show when={props.error} fallback={language.t("a2a.hub.sessions.empty")}>
            {language.t("a2a.hub.sessions.error")}
          </Show>
        </div>
      }
    >
      <ul class="flex flex-col gap-2">
        <For each={props.records}>
          {(record) => (
            <li>
              <div class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base bg-surface-panel px-3 py-2">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
                  onClick={() => props.onOpen(record.taskId)}
                >
                  <span class="flex items-center gap-2 text-12-medium text-text-strong">
                    <span class="truncate">{record.peerId ?? record.origin}</span>
                    <span class="text-text-weak">{props.directionLabel(record.direction)}</span>
                  </span>
                  <span class="flex flex-wrap items-center gap-2 text-11-regular text-text-weak">
                    <span>{record.state}</span>
                    <span>·</span>
                    <span>{language.t("a2a.hub.sessions.turns", { count: record.turns })}</span>
                    <span>·</span>
                    <span>{props.age(record.updatedAt)}</span>
                  </span>
                </button>
                <div class="flex shrink-0 items-center gap-1">
                  <Show when={record.sessionId}>
                    {(sessionId) => (
                      <ButtonV2 size="small" variant="ghost" onClick={() => props.onOpenSession(sessionId())}>
                        {language.t("a2a.hub.sessions.open")}
                      </ButtonV2>
                    )}
                  </Show>
                  <Show when={!TERMINAL_STATES.has(record.state)}>
                    <ButtonV2 size="small" variant="ghost" onClick={() => props.onCancel(record.taskId)}>
                      {language.t("a2a.hub.sessions.cancel")}
                    </ButtonV2>
                  </Show>
                </div>
              </div>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}
