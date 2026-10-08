import { A2ATaskEventPropertiesSchema, A2ATurnEventPropertiesSchema, type TaskState } from "a2a"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { For, Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { type A2AThreadData } from "@/a2a/thread-store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

export type { A2AThreadData }

export interface A2AThreadProps {
  data?: A2AThreadData
  // Cancels the running conversation: interrupts the local session, which the
  // plugin turns into tasks/cancel on the peer and TASK_STATE_CANCELED.
  onCancel?: () => void | Promise<void>
  // Whether the viewed session is currently running. A turn can only be
  // stopped while it runs, so the button is disabled otherwise.
  isRunning?: () => boolean
  // When provided, the thread renders a follow-up composer. The hub uses this to
  // continue an outbound task; the session page omits it entirely.
  onFollowUp?: (text: string) => Promise<void> | void
  followUpPending?: boolean
  followUpDisabled?: boolean
}

export interface A2AConversationProps {
  data: A2AThreadData
}

const empty: A2AThreadData = { taskId: "", turns: [], states: [] }

const TERMINAL_STATES: readonly TaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]

function isTerminal(state: TaskState | undefined) {
  return state !== undefined && TERMINAL_STATES.includes(state)
}

function isError(state: TaskState | undefined) {
  return state === "TASK_STATE_FAILED" || state === "TASK_STATE_CANCELED"
}

// The peer's final product. Consumers render it after the conversation, like a
// normal message, rather than inside the foldable conversation box.
export function a2aVerdictText(data: A2AThreadData): string | undefined {
  if (!data.artifact || data.states.at(-1) !== "TASK_STATE_COMPLETED") return undefined
  return data.artifact.parts.map((part) => part.text).join(" ")
}

// Conversation body shared by the bottom thread panel and the inline timeline
// box: the exchanges as `speaker: message` lines, color-coded by side, plus an
// explanation line when the task ended without a verdict. Diagnostic details
// (task ids, turn numbers, state chains) are deliberately omitted, and messages
// always render in full. The surrounding shell (header, cancel, follow-up
// composer, verdict) stays in A2AThread.
export function A2AConversation(props: A2AConversationProps) {
  const language = useLanguage()

  return (
    <>
      <div class="flex flex-col gap-1.5">
        <For each={props.data.turns}>
          {(turn) => (
            <p class="break-words whitespace-pre-wrap text-12-regular text-text-base">
              <span
                class={`text-12-medium ${turn.speaker === "local" ? "text-text-interactive-base" : "text-icon-warning-base"}`}
              >
                {turn.peerId ??
                  language.t(turn.speaker === "local" ? "a2a.thread.peer.local" : "a2a.thread.peer.remote")}
                {": "}
              </span>
              {turn.text}
            </p>
          )}
        </For>
      </div>
      <Show when={props.data.status && !props.data.artifact}>
        <div
          class={`break-words text-11-regular ${isError(props.data.states.at(-1)) ? "text-icon-warning-base" : "text-text-weak"}`}
        >
          {props.data.status}
        </div>
      </Show>
    </>
  )
}

// Renders the most recent A2A task thread from the a2a.* events the plugin
// publishes on the event bus (A2A-008). The `data` prop overrides the live
// store for tests and storybook-style fixtures.
export function A2AThread(props: A2AThreadProps) {
  const language = useLanguage()
  const sdk = useSDK()
  const [live, setLive] = createStore<A2AThreadData>(empty)
  const [followUp, setFollowUp] = createStore({ draft: "" })

  const stop = sdk().event.listen((evt) => {
    const details = evt.details as { type?: string; properties?: unknown }
    if (details.type === undefined || !details.type.startsWith("a2a.")) return
    if (details.type === "a2a.conversation.turn") {
      const parsed = A2ATurnEventPropertiesSchema.safeParse(details.properties)
      if (!parsed.success) return
      const turn = parsed.data
      if (turn.taskId !== undefined && live.taskId !== "" && turn.taskId !== live.taskId) return
      setLive("turns", live.turns.length, {
        index: turn.turn,
        speaker: turn.speaker,
        peerId: turn.peerId,
        taskId: turn.taskId,
        text: turn.content,
      })
      return
    }
    const parsed = A2ATaskEventPropertiesSchema.safeParse(details.properties)
    if (!parsed.success) return
    const task = parsed.data
    if (details.type === "a2a.task.dispatched") {
      // A newly dispatched task takes over the single-thread view.
      setLive({ taskId: task.taskId, turns: [], states: [task.state], artifact: task.artifact, status: task.content })
      return
    }
    if (task.taskId !== live.taskId) {
      // Events for a task we never saw dispatched; only adopt one when idle.
      if (live.taskId !== "") return
      setLive({ taskId: task.taskId, turns: [], states: [], status: task.content })
    }
    if (task.state !== live.states.at(-1)) setLive("states", live.states.length, task.state)
    if (task.artifact) setLive("artifact", task.artifact)
    if (task.content !== undefined) setLive("status", task.content)
  })
  onCleanup(stop)

  const data = () => props.data ?? live
  const cancelable = () => data().taskId !== "" && !isTerminal(data().states.at(-1)) && props.onCancel !== undefined
  const running = () => props.isRunning?.() ?? true

  const submitFollowUp = async () => {
    if (!props.onFollowUp || props.followUpPending || props.followUpDisabled) return
    const text = followUp.draft.trim()
    if (text === "") return
    setFollowUp("draft", "")
    try {
      await props.onFollowUp(text)
    } catch {
      // Keep the text so the user can retry after a failed turn.
      setFollowUp("draft", text)
    }
  }

  return (
    <Show when={data().turns.length > 0}>
      <section
        class="shrink-0 border-t border-border-weak-base bg-surface-base px-4 py-3"
        aria-label={language.t("a2a.thread.ariaLabel")}
      >
        <div class="mx-auto flex w-full max-w-240 flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="text-12-medium text-text-strong">{language.t("a2a.thread.title")}</div>
            <div class="flex items-center gap-2">
              <div class="text-11-regular text-text-weak">
                {language.t("a2a.thread.task", { taskId: data().taskId })}
              </div>
              <Show when={cancelable()}>
                <button
                  type="button"
                  class="rounded-md border border-border-weak-base px-2 py-0.5 text-11-medium text-text-strong transition-colors hover:bg-surface-panel disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!running()}
                  onClick={() => void props.onCancel?.()}
                >
                  {language.t("a2a.thread.cancel")}
                </button>
              </Show>
            </div>
          </div>
          <A2AConversation data={data()} />
          <Show when={a2aVerdictText(data())}>
            {(verdict) => (
              <div class="break-words whitespace-pre-wrap text-12-regular text-text-base">{verdict()}</div>
            )}
          </Show>
          <Show when={props.onFollowUp}>
            <form
              class="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void submitFollowUp()
              }}
            >
              <TextareaV2
                class="min-h-0 flex-1"
                rows={2}
                value={followUp.draft}
                disabled={props.followUpPending === true || props.followUpDisabled === true}
                placeholder={language.t("a2a.thread.followUp.placeholder")}
                aria-label={language.t("a2a.thread.followUp.ariaLabel")}
                onInput={(event) => setFollowUp("draft", event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    void submitFollowUp()
                  }
                }}
              />
              <ButtonV2
                type="submit"
                size="small"
                variant="contrast"
                disabled={
                  props.followUpPending === true || props.followUpDisabled === true || followUp.draft.trim() === ""
                }
              >
                {props.followUpPending
                  ? language.t("a2a.thread.followUp.pending")
                  : language.t("a2a.thread.followUp.send")}
              </ButtonV2>
            </form>
          </Show>
        </div>
      </section>
    </Show>
  )
}
