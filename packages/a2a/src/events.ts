// Local opencode-side event contract — NOT part of the A2A wire protocol.
// The plugin emits these on the host event bus so the UI can render a task's
// thread live from events alone. Payloads are the `properties` field of a
// { type, properties } bus event.

import { z } from "zod";
import { SpeakerSchema } from "./conversation.ts";
import { TaskStateSchema } from "./types.ts";

export const A2A_TASK_EVENT_TYPES = [
  "a2a.task.dispatched",
  "a2a.task.updated",
  "a2a.task.completed",
  "a2a.task.failed",
] as const;
export const A2A_TURN_EVENT_TYPE = "a2a.conversation.turn" as const;

export const A2AEventTypeSchema = z.enum([...A2A_TASK_EVENT_TYPES, A2A_TURN_EVENT_TYPE]);
export type A2AEventType = z.infer<typeof A2AEventTypeSchema>;
export type A2ATaskEventType = (typeof A2A_TASK_EVENT_TYPES)[number];

// Lifecycle events. `state` is the task's state at emit time; `content`
// carries status message text when the transition carried one.
export const A2ATaskEventPropertiesSchema = z.object({
  taskId: z.string(),
  peerId: z.string().optional(),
  state: TaskStateSchema,
  content: z.string().optional(),
});
export type A2ATaskEventProperties = z.infer<typeof A2ATaskEventPropertiesSchema>;

// One per message on either side of the conversation. `turn` is the 0-based
// turn index within the task; `peerId` names the speaker (our configured name
// for local turns, the peer's identity for remote turns).
export const A2ATurnEventPropertiesSchema = z.object({
  speaker: SpeakerSchema,
  turn: z.number().int().nonnegative(),
  taskId: z.string().optional(),
  peerId: z.string().optional(),
  content: z.string(),
});
export type A2ATurnEventProperties = z.infer<typeof A2ATurnEventPropertiesSchema>;
