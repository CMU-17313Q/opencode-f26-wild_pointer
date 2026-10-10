import { GlobalBus } from "opencode/bus/global"
import type { A2ATaskEventProperties, A2ATaskEventType, A2ATurnEventProperties } from "a2a"

// The plugin runs inside the opencode process, so a2a.* events go on the
// host's global bus — the same fan-out the app's /global/event stream reads.
export interface A2AEventEmitter {
  (type: A2ATaskEventType, properties: A2ATaskEventProperties): void
  (type: "a2a.conversation.turn", properties: A2ATurnEventProperties): void
}

export const noopEmitter: A2AEventEmitter = () => undefined

export function createEventEmitter(directory: string): A2AEventEmitter {
  return (type, properties) => void GlobalBus.emit("event", { directory, payload: { type, properties } })
}
