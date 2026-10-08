import type { Artifact, TaskState } from "a2a"
import { CAP_MESSAGE } from "./config.ts"
import type { ControlSession, ControlTurn } from "./control.ts"

// Display rules shared with A2A-015: nickname first, endpoint second and
// dimmed; same-nickname collisions append the endpoint; unnamed peers show
// the endpoint alone. The local allowedPeers key is a label, the peer's
// agent-card name is what they claim on the wire — both are shown.

export const ACTIVE_STATES: readonly TaskState[] = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
]

export const TERMINAL_STATES: readonly TaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]

export function isActive(state: TaskState): boolean {
  return ACTIVE_STATES.includes(state)
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state)
}

// INPUT_REQUIRED is the only state the wire protocol resumes from.
export function canContinue(state: TaskState): boolean {
  return state === "TASK_STATE_INPUT_REQUIRED"
}

export function canCancel(state: TaskState): boolean {
  return isActive(state)
}

export function stateLabel(state: TaskState): string {
  switch (state) {
    case "TASK_STATE_SUBMITTED":
      return "submitted"
    case "TASK_STATE_WORKING":
      return "working"
    case "TASK_STATE_INPUT_REQUIRED":
      return "waiting"
    case "TASK_STATE_COMPLETED":
      return "completed"
    case "TASK_STATE_FAILED":
      return "failed"
    case "TASK_STATE_CANCELED":
      return "canceled"
    case "TASK_STATE_REJECTED":
      return "rejected"
    case "TASK_STATE_AUTH_REQUIRED":
      return "auth required"
    default:
      return "unknown"
  }
}

export type StateTone = "info" | "success" | "warning" | "error" | "muted"

export function stateTone(state: TaskState): StateTone {
  switch (state) {
    case "TASK_STATE_COMPLETED":
      return "success"
    case "TASK_STATE_FAILED":
    case "TASK_STATE_REJECTED":
      return "error"
    case "TASK_STATE_CANCELED":
      return "muted"
    case "TASK_STATE_INPUT_REQUIRED":
    case "TASK_STATE_AUTH_REQUIRED":
      return "warning"
    default:
      return "info"
  }
}

export function toMs(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return value
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function formatAge(value: number | string | undefined, now: number = Date.now()): string {
  const ms = toMs(value)
  if (ms === undefined) return ""
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// Running sessions on top; each group ordered by most recent update.
export function sortSessions(list: readonly ControlSession[]): ControlSession[] {
  return [...list].sort((a, b) => {
    const active = Number(isActive(b.state)) - Number(isActive(a.state))
    if (active !== 0) return active
    return (toMs(b.updatedAt) ?? toMs(b.createdAt) ?? 0) - (toMs(a.updatedAt) ?? toMs(a.createdAt) ?? 0)
  })
}

export function directionMark(direction: ControlSession["direction"]): string {
  if (direction === "outbound") return "→"
  if (direction === "inbound") return "←"
  return "·"
}

export function sessionPeer(session: ControlSession): string {
  return session.peerId ?? "unknown peer"
}

export function turnText(turn: ControlTurn): string {
  return turn.content ?? turn.text ?? ""
}

export function shortId(taskId: string): string {
  return taskId.length <= 8 ? taskId : taskId.slice(0, 8)
}

// The cap is a bounded ending, not an error — the panel renders it as the
// conversation's natural close instead of a failure (A2A-016).
export function isCapMessage(content: string | undefined): boolean {
  return content === CAP_MESSAGE
}

export function artifactText(artifact: Artifact | undefined): string | undefined {
  const text = artifact?.parts.map((part) => part.text).join("").trim()
  return text || undefined
}

// Peer picker: configured peers first, then peer ids seen in sessions that
// have no configured URL (they can be inspected but not dialed).
export function mergePeers(
  peers: readonly { name: string; url: string }[],
  sessions: readonly ControlSession[],
): { name: string; url?: string }[] {
  const known = new Set(peers.map((peer) => peer.name))
  const discovered = [...new Set(sessions.flatMap((session) => (session.peerId ? [session.peerId] : [])))]
    .filter((name) => !known.has(name))
    .map((name) => ({ name }))
  return [...peers.map((peer) => ({ name: peer.name, url: peer.url })), ...discovered]
}
