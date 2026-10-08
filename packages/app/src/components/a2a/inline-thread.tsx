import { Icon } from "@opencode-ai/ui/icon"
import { createEffect, createSignal, on, Show } from "solid-js"
import type { A2AThreadData } from "@/a2a/thread-store"
import { A2AConversation } from "@/components/session/a2a-thread"
import { useLanguage } from "@/context/language"

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

// Foldable inline rendering of one task's conversation, anchored beneath the
// `a2a_ask` tool row that initiated it. The caller only mounts this once the
// thread has captured at least one turn.
export function A2AInlineThread(props: A2AInlineThreadProps) {
  const language = useLanguage()
  const { expanded, toggle } = createInlineThreadFold(props)

  const peer = () => {
    const first = props.thread.turns[0]
    if (!first) return ""
    return first.peerId ?? language.t(first.speaker === "local" ? "a2a.thread.peer.local" : "a2a.thread.peer.remote")
  }
  const lastState = () => props.thread.states.at(-1)

  // The virtualized timeline must remeasure as the capture grows, not only when
  // the user folds the box.
  createEffect(
    on(
      () => inlineThreadSignature(props.thread),
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
          {language.t("a2a.hub.sessions.turns", { count: props.thread.turns.length })}
        </span>
      </button>
      <Show when={expanded()}>
        <div class="flex flex-col gap-2 border-t border-border-weak-base px-3 py-2">
          <A2AConversation data={props.thread} />
        </div>
      </Show>
    </section>
  )
}
