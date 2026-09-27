import {
  A2ATaskEventPropertiesSchema,
  A2ATurnEventPropertiesSchema,
  type Artifact,
  type TaskState,
  type Turn,
} from "a2a"
import { For, Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

export interface A2AThreadData {
  taskId: string
  turns: Turn[]
  states: TaskState[]
  artifact?: Artifact
}

export interface A2AThreadProps {
  data?: A2AThreadData
}

const empty: A2AThreadData = { taskId: "", turns: [], states: [] }

// Renders the most recent A2A task thread from the a2a.* events the plugin
// publishes on the event bus (A2A-008). The `data` prop overrides the live
// store for tests and storybook-style fixtures.
export function A2AThread(props: A2AThreadProps) {
  const language = useLanguage()
  const sdk = useSDK()
  const [live, setLive] = createStore<A2AThreadData>(empty)

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
      setLive({ taskId: task.taskId, turns: [], states: [task.state], artifact: task.artifact })
      return
    }
    if (task.taskId !== live.taskId) {
      // Events for a task we never saw dispatched; only adopt one when idle.
      if (live.taskId !== "") return
      setLive({ taskId: task.taskId, turns: [], states: [] })
    }
    if (task.state !== live.states.at(-1)) setLive("states", live.states.length, task.state)
    if (task.artifact) setLive("artifact", task.artifact)
  })
  onCleanup(stop)

  const data = () => props.data ?? live

  return (
    <Show when={data().turns.length > 0}>
      <section
        class="shrink-0 border-t border-border-weak-base bg-surface-base px-4 py-3"
        aria-label={language.t("a2a.thread.ariaLabel")}
      >
        <div class="mx-auto flex w-full max-w-240 flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="text-12-medium text-text-strong">{language.t("a2a.thread.title")}</div>
            <div class="text-11-regular text-text-weak">{language.t("a2a.thread.task", { taskId: data().taskId })}</div>
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
          <Show when={data().artifact && data().states.at(-1) === "TASK_STATE_COMPLETED"}>
            <div class="border-l-2 border-icon-success-base pl-3 text-12-regular text-text-base">
              <span class="text-11-medium text-text-strong">{language.t("a2a.thread.verdict")}</span>
              <div>{data().artifact?.parts.map((part) => part.text).join(" ")}</div>
            </div>
          </Show>
        </div>
      </section>
    </Show>
  )
}
