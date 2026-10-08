import { Icon } from "@opencode-ai/ui/icon"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import type { A2AThreadData } from "@/a2a/thread-store"
import { ADMIN_PORT_PATH, createA2AControl } from "@/a2a/control"
import { threadDataFromRecord } from "@/a2a/live-threads"
import { A2AConversation } from "@/components/session/a2a-thread"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

export interface A2AInlineThreadProps {
  taskId: string
  thread: A2AThreadData
  onSizeChange?: () => void
  // Cheap monotonic proxy for "the surrounding session gained parts": every new
  // message, tool row, or streamed part bumps it. The box refetches its record
  // when it changes, so continuation calls update the conversation without a
  // reload even when live event capture misses.
  revision?: () => number
}

// Body-height dimensions the virtualized timeline must remeasure when they
// change. Kept pure so the growth tracking is unit-testable without a DOM.
export function inlineThreadSignature(thread: A2AThreadData) {
  return `${thread.turns.length}:${thread.states.length}`
}

// Fold state for the inline box. Exposed so the toggle + remeasure contract can
// be unit-tested directly; the component is the only production consumer.
export function createInlineThreadFold(props: { onSizeChange?: () => void }) {
  const [expanded, setExpanded] = createSignal(true)
  const toggle = () => {
    setExpanded((value) => !value)
    props.onSizeChange?.()
  }
  return { expanded, toggle }
}

const RUNNING_STATES = new Set(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"])

// Whether the box should keep polling the registry for progress.
export function a2aTaskRunning(state: string | undefined) {
  return RUNNING_STATES.has(state ?? "")
}

// Bounded retry window while the registry has no record yet (the box can mount
// a beat before the task's first event lands).
const UNRESOLVED_POLL_WINDOW_MS = 30_000
const POLL_MS = 2_000
const TRIGGER_GAP_MS = 1_500

// Last fetched record per task, per page. Continuously refreshed by polling and
// activity triggers; the registry is preferred over live capture because it
// records every turn, while live capture can miss whole events.
const recordCache = new Map<string, A2AThreadData>()

// Foldable inline rendering of one task's conversation, anchored beneath the
// `a2a_ask` tool row that initiated it. Renders from the plugin registry
// (hydrated on mount and kept fresh while the task runs), falling back to any
// live-captured turns when no record can be fetched.
export function A2AInlineThread(props: A2AInlineThreadProps) {
  const language = useLanguage()
  const sdk = useSDK()
  const { expanded, toggle } = createInlineThreadFold(props)

  const [record, setRecord] = createSignal<A2AThreadData | undefined>(recordCache.get(props.taskId))
  const [fetching, setFetching] = createSignal(record() === undefined)
  const start = Date.now()
  let inFlight = false

  const control = createA2AControl({
    directory: sdk().directory,
    readPort: () =>
      sdk()
        .client.file.read({ path: ADMIN_PORT_PATH })
        .then((result) => result.data?.content)
        .catch(() => undefined),
  })

  const refetch = async () => {
    if (inFlight) return
    inFlight = true
    setFetching(true)
    try {
      const entry = await control.getSession(props.taskId).catch(() => undefined)
      if (entry === undefined) return
      const next = threadDataFromRecord(entry)
      recordCache.set(props.taskId, next)
      setRecord(next)
    } finally {
      inFlight = false
      setFetching(false)
    }
  }

  onMount(() => {
    if (record() === undefined) void refetch()
  })

  const data = (): A2AThreadData =>
    record() ?? (props.thread.turns.length > 0 ? props.thread : { taskId: props.taskId, turns: [], states: [] })

  // Poll while the task is running, and for a bounded window while the registry
  // still has no record. The memos dedupe so the interval survives unchanged
  // states; it is recreated only when the state value actually flips.
  const runState = createMemo(() => data().states.at(-1))
  const unresolved = createMemo(() => record() === undefined)
  createEffect(() => {
    if (!a2aTaskRunning(runState()) && !unresolved()) return
    const timer = setInterval(() => {
      if (unresolved() && Date.now() - start > UNRESOLVED_POLL_WINDOW_MS) clearInterval(timer)
      else void refetch()
    }, POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  // Activity triggers: new session parts (a continuation arrives as a new
  // `a2a_ask` call) and any live-captured turn for this task. Throttled so a
  // burst of streamed parts collapses into one fetch.
  let lastTriggered = 0
  const triggered = () => {
    const now = Date.now()
    if (now - lastTriggered < TRIGGER_GAP_MS) return
    lastTriggered = now
    void refetch()
  }
  createEffect(on(() => props.revision?.(), triggered, { defer: true }))
  createEffect(on(() => inlineThreadSignature(props.thread), triggered, { defer: true }))

  const peer = () => {
    const first = data().turns[0]
    if (!first) return ""
    return first.peerId ?? language.t(first.speaker === "local" ? "a2a.thread.peer.local" : "a2a.thread.peer.remote")
  }
  const lastState = () => data().states.at(-1)

  // The virtualized timeline must remeasure as the capture grows or refreshes,
  // not only when the user folds the box.
  createEffect(
    on(
      () => inlineThreadSignature(data()),
      () => props.onSizeChange?.(),
      { defer: true },
    ),
  )

  return (
    <section
      data-task-id={props.taskId}
      class="mt-2 flex flex-col overflow-hidden rounded-md border border-border-weak-base bg-surface-panel"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-base"
        aria-expanded={expanded()}
        aria-label={language.t(expanded() ? "a2a.inline.collapse" : "a2a.inline.expand")}
        onClick={toggle}
      >
        <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" class="shrink-0 text-icon-weak" />
        <span class="text-12-medium text-text-strong">{language.t("a2a.inline.title")}</span>
        <Show when={peer()}>
          <span class="text-11-regular text-text-weak">{peer()}</span>
        </Show>
        <Show when={lastState()}>
          <span class="text-11-regular text-text-weak">{lastState()}</span>
        </Show>
        <span class="ml-auto text-11-regular text-text-weak">
          {language.t("a2a.hub.sessions.turns", { count: data().turns.length })}
        </span>
      </button>
      <Show when={expanded()}>
        <div class="flex flex-col gap-2 border-t border-border-weak-base px-3 py-2">
          <Show when={data().turns.length === 0 && !fetching()}>
            <div class="text-11-regular text-text-weak">{language.t("a2a.inline.empty")}</div>
          </Show>
          <Show when={data().turns.length > 0}>
            <A2AConversation data={data()} />
          </Show>
        </div>
      </Show>
    </section>
  )
}
