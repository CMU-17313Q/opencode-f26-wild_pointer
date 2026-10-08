// Folds the live `a2a.*` bus events into per-taskId threads so the session
// timeline can render each initiated conversation inline. The reducer itself
// lives in `thread-store.ts`; this module only owns the single bus subscription.

import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { applyA2AEvent, threadFor, type A2AThreadData, type A2AThreads } from "./thread-store"

// Structural view of the fields the inline anchor needs. Kept minimal so tests
// can build fixtures without a full SDK tool part.
export interface A2AAskPart {
  type?: unknown
  tool?: unknown
  state?: unknown
}

// Returns the task id only for the call that initiated the conversation: a
// completed `a2a_ask` whose metadata carries a task id, with no `input.taskId`.
// Continuations pass `input.taskId` and must not anchor a second inline box.
export function a2aInlineTaskId(part: A2AAskPart | undefined): string | undefined {
  if (!part || part.type !== "tool" || part.tool !== "a2a_ask") return
  const state = part.state
  if (typeof state !== "object" || state === null) return
  if ((state as { status?: unknown }).status !== "completed") return
  const metadata = (state as { metadata?: unknown }).metadata
  if (typeof metadata !== "object" || metadata === null) return
  const taskId = (metadata as { taskId?: unknown }).taskId
  if (typeof taskId !== "string" || taskId === "") return
  const input = (state as { input?: unknown }).input
  if (typeof input === "object" && input !== null && (input as { taskId?: unknown }).taskId !== undefined) return
  return taskId
}

export function createLiveThreads() {
  const sdk = useSDK()
  const [live, setLive] = createStore<{ threads: A2AThreads }>({ threads: {} })

  const stop = sdk().event.listen((event) => {
    const details = event.details as { type?: string; properties?: unknown }
    if (details.type === undefined || !details.type.startsWith("a2a.")) return
    setLive("threads", (threads) => applyA2AEvent(threads, details.type as string, details.properties))
  })
  onCleanup(stop)

  return { threadFor: (taskId: string): A2AThreadData => threadFor(live.threads, taskId) }
}
