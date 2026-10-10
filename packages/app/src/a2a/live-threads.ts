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
import type { Artifact, TaskState, Turn } from "a2a"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { applyA2AEvent, threadFor, type A2AThreadData, type A2AThreads } from "./thread-store"
import type { A2ASessionRecord } from "./control"

// Structural view of the fields the inline anchor needs. Kept minimal so tests
// can build fixtures without a full SDK tool part.
export interface A2AAskPart {
  type?: unknown
  tool?: unknown
  state?: unknown
}

// One inline box per `a2a_ask` call: the task the call drives and the turn
// index its own run starts at. Initiating calls always start at 0; a
// continuation must carry the plugin-stamped starting turn, otherwise (a call
// made before the stamp existed) it has no defined slice and anchors nothing.
export interface A2AAsk {
  taskId: string
  firstTurn: number
}

export function a2aInlineAsk(part: A2AAskPart | undefined): A2AAsk | undefined {
  if (!part || part.type !== "tool" || part.tool !== "a2a_ask") return
  const state = part.state
  if (typeof state !== "object" || state === null) return
  if ((state as { status?: unknown }).status !== "completed") return
  const metadata = (state as { metadata?: unknown }).metadata
  const input = (state as { input?: unknown }).input
  const inputTaskId = readString(input, "taskId")
  const firstTurn = readNumber(metadata, "firstTurn")
  if (inputTaskId !== undefined) {
    if (firstTurn === undefined) return
    return { taskId: inputTaskId, firstTurn }
  }
  const taskId = readString(metadata, "taskId")
  if (taskId === undefined) return
  return { taskId, firstTurn: firstTurn ?? 0 }
}

// One box's slice of a task: the turns its ask owns. The next ask's starting
// turn (when a later ask exists) is the exclusive end; the index selects the
// matching slice of the task's state chain.
export interface A2AAskSegment {
  firstTurn: number
  next?: number
  index: number
}

// Computes the slice for one ask from every anchor observed for its task in
// the session (its own call included).
export function a2aSegmentFrom(anchors: number[] | undefined, firstTurn: number): A2AAskSegment {
  const sorted = [...(anchors ?? [])].sort((left, right) => left - right)
  const index = sorted.indexOf(firstTurn)
  const next = sorted.find((anchor) => anchor > firstTurn)
  return { firstTurn, ...(next === undefined ? {} : { next }), index: index < 0 ? 0 : index }
}

// Maps a persisted registry record into the thread data that the inline box
// and the bottom panel render, so conversations survive page reloads and any
// live-capture gap. With a segment, only that ask's turns and states are kept;
// the verdict (status + artifact) belongs to the task's last segment alone.
export function threadDataFromRecord(record: A2ASessionRecord, segment?: A2AAskSegment): A2AThreadData {
  const mapped = (record.history ?? []).map(
    (entry, position): Turn => ({
      index: typeof entry.turn === "number" ? entry.turn : position,
      speaker: entry.speaker === "local" ? "local" : "remote",
      ...(typeof entry.peerId === "string" ? { peerId: entry.peerId } : {}),
      ...(typeof entry.taskId === "string" ? { taskId: entry.taskId } : {}),
      text: typeof entry.content === "string" ? entry.content : "",
    }),
  )
  const turns =
    segment === undefined
      ? mapped
      : mapped.filter(
          (turn) => turn.index >= segment.firstTurn && (segment.next === undefined || turn.index < segment.next),
        )
  const chain = (record.states ?? []).filter((state): state is TaskState => typeof state === "string")
  const states = segmentStates(chain, segment)
  const isLast = segment === undefined || segment.next === undefined
  return {
    taskId: record.taskId,
    turns,
    states: states.length > 0 ? states : [record.state],
    ...(isLast && typeof record.message === "string" && record.message !== "" ? { status: record.message } : {}),
    ...(isLast && isArtifact(record.artifact) ? { artifact: record.artifact } : {}),
  }
}

// Slices live-captured thread data the same way records are sliced, so the
// fallback path shows the same per-ask scope.
export function sliceLiveThread(thread: A2AThreadData, segment?: A2AAskSegment): A2AThreadData {
  if (segment === undefined) return thread
  return {
    ...thread,
    turns: thread.turns.filter(
      (turn) => turn.index >= segment.firstTurn && (segment.next === undefined || turn.index < segment.next),
    ),
  }
}

// Every dispatch opens its segment with a SUBMITTED state, so the Nth SUBMITTED
// in the chain starts the Nth segment; slice up to the next SUBMITTED (or the
// end). Falls back to the whole chain when it cannot be sliced.
function segmentStates(chain: TaskState[], segment?: A2AAskSegment): TaskState[] {
  if (segment === undefined) return chain
  const starts = chain.flatMap((state, index) => (state === "TASK_STATE_SUBMITTED" ? [index] : []))
  const from = starts[segment.index]
  if (from === undefined) return chain
  return chain.slice(from, starts[segment.index + 1] ?? chain.length)
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" && field !== "" ? field : undefined
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "number" ? field : undefined
}

function isArtifact(value: unknown): value is Artifact {
  return typeof value === "object" && value !== null && Array.isArray((value as { parts?: unknown }).parts)
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
