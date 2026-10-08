import { Icon } from "@opencode-ai/ui/icon"
import { createEffect, createResource, createSignal, on, Show } from "solid-js"
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

// One fetch per task per page: hydrated conversations are immutable history.
const hydratedCache = new Map<string, A2AThreadData>()

// Foldable inline rendering of one task's conversation, anchored beneath the
// `a2a_ask` tool row that initiated it. Live-captured turns win when present;
// otherwise the conversation is hydrated from the plugin registry, so page
// reloads and live-capture gaps cannot hide the history.
export function A2AInlineThread(props: A2AInlineThreadProps) {
  const language = useLanguage()
  const sdk = useSDK()
  const { expanded, toggle } = createInlineThreadFold(props)

  const [hydrated] = createResource(
    () => (props.thread.turns.length === 0 ? props.taskId : undefined),
    async (taskId: string): Promise<A2AThreadData | undefined> => {
      const cached = hydratedCache.get(taskId)
      if (cached !== undefined) return cached
      const control = createA2AControl({
        directory: sdk().directory,
        readPort: () =>
          sdk()
            .client.file.read({ path: ADMIN_PORT_PATH })
            .then((result) => result.data?.content)
            .catch(() => undefined),
      })
      const record = await control.getSession(taskId).catch(() => undefined)
      if (record === undefined) return undefined
      const data = threadDataFromRecord(record)
      hydratedCache.set(taskId, data)
      return data
    },
  )

  const data = (): A2AThreadData =>
    props.thread.turns.length > 0
      ? props.thread
      : (hydrated() ?? { taskId: props.taskId, turns: [], states: [] })

  const peer = () => {
    const first = data().turns[0]
    if (!first) return ""
    return first.peerId ?? language.t(first.speaker === "local" ? "a2a.thread.peer.local" : "a2a.thread.peer.remote")
  }
  const lastState = () => data().states.at(-1)

  // The virtualized timeline must remeasure as the capture grows or hydrates,
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
          <Show when={data().turns.length === 0 && !hydrated.loading}>
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
