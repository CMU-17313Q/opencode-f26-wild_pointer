import type { Speaker, Turn } from "./conversation";
import type { Message, Task, TaskStatus } from "./types";

export interface TrackerOptions {
  taskId: string;
  peerId?: string;
  timeoutMs?: number;
  now?: () => number;
}

export type NoteResult =
  | { kind: "added"; turn: Turn }
  | { kind: "duplicate"; turn: Turn };

export interface CapPolicy {
  maxTurns: number;
  capMessage: string;
}

export class ConversationTracker {
  readonly taskId: string;
  private readonly timeoutMs: number;
  private readonly peerId: string | undefined;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly turns: Turn[] = [];
  private readonly seenIds = new Map<string, Turn>();

  constructor(options: TrackerOptions) {
    this.taskId = options.taskId;
    this.peerId = options.peerId;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  note(message: Message, speaker: Speaker): NoteResult {
    const existing = this.seenIds.get(message.messageId);
    if (existing !== undefined) return { kind: "duplicate", turn: existing };
    const turn: Turn = {
      index: this.turns.length,
      speaker,
      text: messageText(message),
      messageId: message.messageId,
      taskId: this.taskId,
      peerId: this.peerId,
    };
    this.turns.push(turn);
    this.seenIds.set(message.messageId, turn);
    return { kind: "added", turn };
  }

  sync(task: Task, speakerOf: (message: Message) => Speaker): NoteResult[] {
    if (task.history === undefined) return [];
    return task.history.map((message) => this.note(message, speakerOf(message)));
  }

  history(): Turn[] {
    return [...this.turns];
  }

  timedOut(): boolean {
    return this.now() - this.startedAt >= this.timeoutMs;
  }
}

export function conversationOutcome(tracker: ConversationTracker, policy: CapPolicy): TaskStatus {
  if (tracker.timedOut()) return { state: "TASK_STATE_FAILED" };
  if (tracker.history().length >= policy.maxTurns)
    return {
      state: "TASK_STATE_COMPLETED",
      message: {
        messageId: "tracker-cap",
        role: "ROLE_AGENT",
        parts: [{ text: policy.capMessage }],
      },
    };
  return { state: "TASK_STATE_WORKING" };
}

function messageText(message: Message): string {
  return message.parts.map((part) => part.text).join("\n");
}
