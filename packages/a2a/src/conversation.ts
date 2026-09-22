// Local conversation tracking. Speaker is viewer-relative (local = us,
// remote = them) and never flips, unlike the connection-relative A2A Role.
// Turn stores the chronological transcript; messageId/taskId optionally link
// a turn back to its wire Message/Task without coupling the two models,
// and peerId feeds the peer identity on `a2a.conversation.turn` events.

import { z } from "zod";

export const SpeakerSchema = z.enum([
  "local",
  "remote",
]);
export type Speaker = z.infer<typeof SpeakerSchema>;

export const TurnSchema = z.object({
  index: z.number().int().nonnegative(),
  speaker: SpeakerSchema,
  text: z.string().min(1),
  messageId: z.string().optional(),
  taskId: z.string().optional(),
  peerId: z.string().optional(),
});
export type Turn = z.infer<typeof TurnSchema>;
