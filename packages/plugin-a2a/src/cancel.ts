import type { ConversationStore } from "./ask.ts"
import { noopEmitter, type A2AEventEmitter } from "./events.ts"

// The cancel path the inbound bridge exposes: cancels the local task owned by
// this process, returning false when the task is unknown or already settled.
export type LocalCancel = (taskId: string) => Promise<boolean>

// A2A-012: one cancel routine for every interruption. A cancel can apply to a
// remote task (an a2a_ask conversation), a local one (an inbound task this
// process serves), or both, so every invocation attempts both sides and
// tolerates absence. Used by the tool on abort and by the bridge on a local
// run abort.
export type Canceller = (taskId: string | undefined, reason?: string) => Promise<void>

export function createCanceller(input: {
  store: ConversationStore
  emit?: A2AEventEmitter
  local?: () => LocalCancel | undefined
}): Canceller {
  const emit = input.emit ?? noopEmitter
  const done = new Set<string>()

  return async (taskId, reason) => {
    if (taskId === undefined || taskId === "" || done.has(taskId)) return
    done.add(taskId)
    const properties = {
      taskId,
      state: "TASK_STATE_CANCELED" as const,
      ...(reason === undefined ? {} : { content: reason }),
    }
    let emitted = false
    const conversation = input.store.get(taskId)
    if (conversation) {
      // Mark the conversation terminal before the request so a concurrent
      // follow-up cannot start another turn on a task we are cancelling.
      conversation.terminal = "TASK_STATE_CANCELED"
      try {
        await conversation.client.cancelTask(taskId)
      } catch {
        // Unreachable or already settled peers still end the local thread.
      }
      emit("a2a.task.updated", { ...properties, peerId: conversation.peerId })
      emitted = true
    }
    const local = input.local?.()
    if (local && (await local(taskId))) emitted = true
    // The local path emits through A2AServer.onCancel; without either side
    // there is still a thread in the UI that needs its terminal state.
    if (!emitted) emit("a2a.task.updated", properties)
  }
}
