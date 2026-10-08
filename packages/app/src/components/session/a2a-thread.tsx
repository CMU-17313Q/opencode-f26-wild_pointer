import {
  A2ATaskEventPropertiesSchema,
  A2ATurnEventPropertiesSchema,
  type Artifact,
  type TaskState,
  type Turn,
} from "a2a"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { For, Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

export interface A2AThreadData {
  taskId: string
  turns: Turn[]
  states: TaskState[]
  artifact?: Artifact
  // Latest task status message (cap notice, failure reason, cancel note) so
  // terminal states explain themselves without breaking the thread.
  status?: string
}

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
          <div class="flex min-w-0 gap-2 overflow-x-auto pb-1">
            <For each={data().turns}>
              {(turn) => (
                <article class="min-w-56 max-w-72 flex-1 rounded-md border border-border-weak-base bg-surface-panel px-3 py-2">
                  <div class="flex items-center justify-between gap-2 text-11-medium text-text-strong">
                    <span>
                      {turn.peerId ??
                        language.t(turn.speaker === "local" ? "a2a.thread.peer.local" : "a2a.thread.peer.remote")}
                    </span>
                    <span class="text-text-weak">{language.t("a2a.thread.turn", { turn: turn.index + 1 })}</span>
                  </div>
                  <div class="mt-1 text-11-regular text-text-weak">
                    {turn.speaker} · {turn.taskId ?? data().taskId}
                  </div>
                  <p class="mt-2 line-clamp-2 text-12-regular text-text-base">{turn.text}</p>
                </article>
              )}
            </For>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 text-11-regular text-text-weak">
            <For each={data().states}>
              {(state, index) => (
                <>
                  <span class={index() === data().states.length - 1 ? "text-text-strong" : ""}>{state}</span>
                  <Show when={index() < data().states.length - 1}>
                    <span aria-hidden>&gt;</span>
                  </Show>
                </>
              )}
            </For>
          </div>
          <Show when={data().status}>
            <div
              class={`text-11-regular ${isError(data().states.at(-1)) ? "text-icon-warning-base" : "text-text-weak"}`}
            >
              {data().status}
            </div>
          </Show>
          <Show when={data().artifact && data().states.at(-1) === "TASK_STATE_COMPLETED"}>
            <div class="border-l-2 border-icon-success-base pl-3 text-12-regular text-text-base">
              <span class="text-11-medium text-text-strong">{language.t("a2a.thread.verdict")}</span>
              <div>
                {data()
                  .artifact?.parts.map((part) => part.text)
                  .join(" ")}
              </div>
            </div>
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
