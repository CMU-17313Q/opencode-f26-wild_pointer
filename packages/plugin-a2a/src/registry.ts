import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TaskState } from "a2a"
import type { A2AEventEmitter } from "./events.ts"

export type ConversationDirection = "outbound" | "inbound"
export type ConversationOrigin = "tool" | "tui" | "app" | "peer"

// The context that makes a task record meaningful but that the a2a.* events do
// not carry: who started it, which side of the bridge it is on, and (when there
// is one) the host session behind it.
export type RegistryContext = {
  direction: ConversationDirection
  origin: ConversationOrigin
  peerId?: string
  sessionId?: string
}

export type TaskRecord = {
  taskId: string
  direction: ConversationDirection
  origin: ConversationOrigin
  peerId?: string
  state: TaskState
  turns: number
  sessionId?: string
  message?: string
  createdAt: number
  updatedAt: number
}

const TERMINAL_STATES = new Set<TaskState>([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
])

// A process that died leaves tasks marked WORKING/SUBMITTED; a restarted host
// has no way to continue them, so they settle as failed rather than looking
// live forever.
const RESTART_MESSAGE = "host restarted"
const DEFAULT_LIMIT = 50

export type Registry = {
  // Wrap the base emitter so every a2a.task.* / a2a.conversation.turn goes to
  // the bus and the registry from the same call — the two cannot drift.
  attach: (base: A2AEventEmitter, ctx: RegistryContext) => A2AEventEmitter
  setSession: (taskId: string, sessionId: string) => void
  list: () => TaskRecord[]
  get: (taskId: string) => TaskRecord | undefined
  // Read the persisted state and settle any task a dead process left running.
  load: () => Promise<void>
  // Resolves once every scheduled write has landed; used by tests.
  flush: () => Promise<void>
}

export function createConversationRegistry(input: {
  file: string
  limit?: number
  now?: () => number
}): Registry {
  const limit = input.limit ?? DEFAULT_LIMIT
  const now = input.now ?? (() => Date.now())
  const records = new Map<string, TaskRecord>()
  let pending: Promise<void> = Promise.resolve()

  const createRecord = (taskId: string, ctx: RegistryContext, timestamp: number): TaskRecord => ({
    taskId,
    direction: ctx.direction,
    origin: ctx.origin,
    ...(ctx.peerId === undefined ? {} : { peerId: ctx.peerId }),
    state: "TASK_STATE_SUBMITTED",
    turns: 0,
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })

  const prune = () => {
    if (records.size <= limit) return
    const newestFirst = [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const record of newestFirst.slice(limit)) records.delete(record.taskId)
  }

  const persist = async () => {
    prune()
    const payload = JSON.stringify({ version: 1, tasks: [...records.values()] }, null, 2)
    await mkdir(path.dirname(input.file), { recursive: true })
    // Atomic: write a sibling temp file, then swap it into place.
    const tmp = `${input.file}.tmp`
    await writeFile(tmp, payload, "utf8")
    await rename(tmp, input.file)
  }

  const schedule = () => {
    pending = pending.then(persist).catch(() => undefined)
  }

  const observe = (type: string, properties: Record<string, unknown>, ctx: RegistryContext) => {
    const taskId = typeof properties.taskId === "string" ? properties.taskId : undefined
    if (taskId === undefined) return
    const existing = records.get(taskId)
    const timestamp = now()
    if (type === "a2a.conversation.turn") {
      const turn = typeof properties.turn === "number" ? properties.turn : 0
      const record = existing ?? createRecord(taskId, ctx, timestamp)
      record.turns = Math.max(record.turns, turn + 1)
      record.updatedAt = timestamp
      records.set(taskId, record)
      schedule()
      return
    }
    const record = existing ?? createRecord(taskId, ctx, timestamp)
    if (typeof properties.state === "string") record.state = properties.state as TaskState
    if (typeof properties.content === "string") record.message = properties.content
    if (ctx.sessionId !== undefined) record.sessionId = ctx.sessionId
    record.updatedAt = timestamp
    records.set(taskId, record)
    schedule()
  }

  const restore = async (text: string) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) return
    for (const entry of parsed.tasks) {
      if (!isRecord(entry) || typeof entry.taskId !== "string") continue
      records.set(entry.taskId, entry as unknown as TaskRecord)
    }
    let changed = false
    for (const record of records.values()) {
      if (TERMINAL_STATES.has(record.state)) continue
      record.state = "TASK_STATE_FAILED"
      record.message = RESTART_MESSAGE
      record.updatedAt = now()
      changed = true
    }
    if (changed) schedule()
  }

  return {
    attach: (base, ctx) => {
      const wrapped = (type: string, properties: Record<string, unknown>) => {
        base(type as never, properties as never)
        observe(type, properties, ctx)
      }
      return wrapped as unknown as A2AEventEmitter
    },
    setSession: (taskId, sessionId) => {
      const record = records.get(taskId)
      if (record === undefined) return
      record.sessionId = sessionId
      record.updatedAt = now()
      schedule()
    },
    list: () => [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    get: (taskId) => records.get(taskId),
    load: async () => {
      // A missing or malformed file is an empty registry: the plugin must still
      // start when its state file is corrupt.
      const text = await readFile(input.file, "utf8").catch(() => undefined)
      if (text !== undefined && text.trim() !== "") await restore(text)
    },
    flush: () => pending,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
