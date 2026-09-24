import type { Artifact, TaskState, Turn } from "a2a"
import { For, Show } from "solid-js"

export interface A2AThreadData {
  taskId: string
  turns: Turn[]
  states: TaskState[]
  artifact?: Artifact
}

export interface A2AThreadProps {
  data?: A2AThreadData
}

const mockData: A2AThreadData = {
  taskId: "A2A-008",
  turns: [
    {
      index: 0,
      speaker: "local",
      peerId: "Agent A",
      taskId: "A2A-008",
      text: "Please review the task and propose an approach.",
    },
    {
      index: 1,
      speaker: "remote",
      peerId: "Agent B",
      taskId: "A2A-008",
      text: "I found the relevant events and will validate the state transition.",
    },
    {
      index: 2,
      speaker: "local",
      peerId: "Agent A",
      taskId: "A2A-008",
      text: "The transition is ready. Please check the completed-task artifact.",
    },
    {
      index: 3,
      speaker: "remote",
      peerId: "Agent B",
      taskId: "A2A-008",
      text: "The implementation matches the expected four-turn conversation.",
    },
  ],
  states: ["TASK_STATE_SUBMITTED", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_COMPLETED"],
  artifact: {
    artifactId: "A2A-008-verdict",
    parts: [{ text: "Verdict: approved. The four-turn conversation and state progression are complete." }],
    name: "A2A-008 verdict",
  },
}

export function A2AThread(props: A2AThreadProps) {
  const data = () => props.data ?? mockData

  return (
    <section class="shrink-0 border-t border-border-weak-base bg-surface-base px-4 py-3" aria-label="A2A thread">
      <div class="mx-auto flex w-full max-w-240 flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="text-12-medium text-text-strong">A2A thread</div>
          <div class="text-11-regular text-text-weak">Task {data().taskId}</div>
        </div>
        <div class="flex min-w-0 gap-2 overflow-x-auto pb-1">
          <For each={data().turns}>
            {(turn) => (
              <article class="min-w-56 max-w-72 flex-1 rounded-md border border-border-weak-base bg-surface-panel px-3 py-2">
                <div class="flex items-center justify-between gap-2 text-11-medium text-text-strong">
                  <span>{turn.peerId ?? (turn.speaker === "local" ? "local peer" : "remote peer")}</span>
                  <span class="text-text-weak">Turn {turn.index + 1}</span>
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
            <span class="text-11-medium text-text-strong">Verdict</span>
            <div>{data().artifact?.parts.map((part) => part.text).join(" ")}</div>
          </div>
        </Show>
      </div>
    </section>
  )
}