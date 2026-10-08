// Pure reducer that folds `a2a.*` bus events into per-taskId threads. The hub
// dialog renders many tasks at once, so unlike the single-thread view in
// `components/session/a2a-thread.tsx` every task gets its own entry. The dedupe
// semantics match that view: states only append when they differ from the last
// one, turns append in arrival order.

import {
  A2ATaskEventPropertiesSchema,
  A2ATurnEventPropertiesSchema,
  type Artifact,
  type TaskState,
  type Turn,
} from "a2a"

export interface A2AThreadData {
  taskId: string
  turns: Turn[]
  states: TaskState[]
  artifact?: Artifact
  status?: string
}

export type A2AThreads = Record<string, A2AThreadData>

export function emptyThread(taskId: string): A2AThreadData {
  return { taskId, turns: [], states: [] }
}

export function threadFor(threads: A2AThreads, taskId: string): A2AThreadData {
  return threads[taskId] ?? emptyThread(taskId)
}

export function applyA2AEvent(threads: A2AThreads, type: string, properties: unknown): A2AThreads {
  if (type === "a2a.conversation.turn") return applyTurn(threads, properties)
  if (type.startsWith("a2a.task.")) return applyTask(threads, type, properties)
  return threads
}

function applyTurn(threads: A2AThreads, properties: unknown): A2AThreads {
  const parsed = A2ATurnEventPropertiesSchema.safeParse(properties)
  if (!parsed.success) return threads
  const turn = parsed.data
  // A turn without a task cannot be attributed in the multi-task hub.
  if (turn.taskId === undefined) return threads
  const thread = threadFor(threads, turn.taskId)
  const next: A2AThreadData = {
    ...thread,
    turns: [
      ...thread.turns,
      {
        index: turn.turn,
        speaker: turn.speaker,
        peerId: turn.peerId,
        taskId: turn.taskId,
        text: turn.content,
      },
    ],
  }
  return { ...threads, [turn.taskId]: next }
}

function applyTask(threads: A2AThreads, type: string, properties: unknown): A2AThreads {
  const parsed = A2ATaskEventPropertiesSchema.safeParse(properties)
  if (!parsed.success) return threads
  const task = parsed.data
  const thread = threads[task.taskId]

  if (type === "a2a.task.dispatched") {
    // Keep any turns already captured for this task in case a turn event
    // arrives before the dispatch; a fresh task starts empty.
    return {
      ...threads,
      [task.taskId]: {
        taskId: task.taskId,
        turns: thread?.turns ?? [],
        states: [task.state],
        artifact: task.artifact,
        status: task.content,
      },
    }
  }

  const base = thread ?? emptyThread(task.taskId)
  const states = task.state !== base.states.at(-1) ? [...base.states, task.state] : base.states
  return {
    ...threads,
    [task.taskId]: {
      ...base,
      states,
      ...(task.artifact ? { artifact: task.artifact } : {}),
      ...(task.content !== undefined ? { status: task.content } : {}),
    },
  }
}
