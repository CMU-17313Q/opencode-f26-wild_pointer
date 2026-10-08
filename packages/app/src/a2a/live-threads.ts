// Captures the live `a2a.*` bus events into per-taskId threads so the session
// timeline can render each initiated conversation inline.
//
// The capture subscribes on the server-level event bus (keyed by directory)
// instead of the ref-counted directory SDK context, and keeps its store for the
// lifetime of the page. Route churn (draft -> session) or context re-creation
// must not drop events, otherwise the first conversation of a brand-new session
// is missed while the page transitions. Stores are shared per (server,
// directory) so every consumer sees the same capture.

import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
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

export type LiveThreads = {
  threadFor: (taskId: string) => A2AThreadData
}

// Page-lifetime stores: intentionally never disposed. Bounded by the number of
// (server, directory) pairs a page visits, and immune to the ref-counted
// directory SDK context being torn down mid-navigation.
const liveStores = new Map<string, LiveThreads>()

export function useLiveThreads() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()

  return createMemo<LiveThreads>(() => {
    const directory = sdk().directory
    const key = `${serverSDK().url}\u0000${directory}`
    const cached = liveStores.get(key)
    if (cached) return cached

    const [store, setStore] = createStore<{ threads: A2AThreads }>({ threads: {} })
    serverSDK().event.on(directory, (event) => {
      const type = event?.type
      if (typeof type !== "string" || !type.startsWith("a2a.")) return
      setStore("threads", (threads) => applyA2AEvent(threads, type, event.properties))
    })

    const entry: LiveThreads = { threadFor: (taskId) => threadFor(store.threads, taskId) }
    liveStores.set(key, entry)
    return entry
  })
}
