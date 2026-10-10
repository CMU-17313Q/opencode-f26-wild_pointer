import type { PluginInput } from "@opencode-ai/plugin"
import { parseModel } from "./config.ts"

// The bridge talks to opencode through this seam only, so tests inject a fake
// runner (or a fake SDK client) instead of a real model.
export type SessionRunner = {
  run: (taskId: string, text: string, peer?: string) => Promise<{ sessionID: string; text: string }>
  abort: (taskId: string) => Promise<void>
}

// A run that ended because the session was interrupted (a human pressed
// cancel/stop). The bridge maps this to TASK_STATE_CANCELED instead of FAILED.
export class SessionAbortedError extends Error {
  constructor(message = "session run aborted") {
    super(message)
    this.name = "SessionAbortedError"
  }
}

// The SDK surfaces aborts either as a thrown tagged object or as the assistant
// message's `info.error`; both carry the name MessageAbortedError.
export function isSessionAborted(error: unknown): boolean {
  if (error instanceof SessionAbortedError) return true
  if (error instanceof Error) return isAbortName(error.name)
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string")
    return isAbortName(error.name)
  return false
}

function isAbortName(name: string): boolean {
  return name === "MessageAbortedError" || name === "AbortError"
}

// PermissionV1 denial and rejection messages each carry one of these phrases;
// a tool part carrying either means the turn was refused, not answered.
const PERMISSION_MARK = /rejected permission|prevents you from using this specific tool call/

// One opencode session per A2A task id, created on first contact and reused
// afterwards so the agent keeps the whole conversation's context. Prompts take
// the normal session path, so the project's default safety rules apply.
export function createSessionRunner(input: {
  client: PluginInput["client"]
  agent?: string
  model?: string
}): SessionRunner {
  const sessions = new Map<string, string>()
  const model = input.model === undefined ? undefined : parseModel(input.model)

  const sessionFor = async (taskId: string, text: string, peer?: string) => {
    const known = sessions.get(taskId)
    if (known !== undefined) return known
    const created = await input.client.session.create({
      // Titles are user-facing (sessions list, tabs): lead with the A2A marker
      // and the peer (the x-a2a-peer header, else the remote address), then a
      // snippet of the opening message. The task id stays out of the title;
      // the registry record and the hub are the identity trail.
      body: { title: sessionTitle(peer, text, taskId) },
      throwOnError: true,
    })
    sessions.set(taskId, created.data.id)
    return created.data.id
  }

  return {
    async run(taskId, text, peer) {
      const sessionID = await sessionFor(taskId, text, peer)
      const result = await input.client.session
        .prompt({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text }],
            ...(input.agent === undefined ? {} : { agent: input.agent }),
            ...(model === undefined ? {} : { model }),
          },
          throwOnError: true,
        })
        .catch((error: unknown) => {
          if (isSessionAborted(error)) throw new SessionAbortedError()
          throw error
        })
      if (result.data.info.error) {
        if (isSessionAborted(result.data.info.error)) throw new SessionAbortedError()
        throw new Error(failureText(result.data.info.error))
      }
      // A denied or rejected tool call lands as an errored tool part while the
      // turn may still produce text; surface it as a failed run so the peer
      // sees a clear TASK_STATE_FAILED instead of a polite refusal reply.
      const denied = result.data.parts.find(
        (part) => part.type === "tool" && part.state.status === "error" && PERMISSION_MARK.test(part.state.error),
      )
      if (denied !== undefined && denied.type === "tool" && denied.state.status === "error")
        throw new Error(`permission denied: ${denied.state.error}`)
      // The reply is the assistant's visible text: skip reasoning, synthetic,
      // and ignored parts, then reject an empty result so the bridge fails the
      // turn instead of appending a blank agent message.
      const reply = result.data.parts
        .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
        .join("\n")
        .trim()
      if (!reply) throw new Error(`session ${sessionID} returned no text reply`)
      return { sessionID, text: reply }
    },
    async abort(taskId) {
      const sessionID = sessions.get(taskId)
      if (sessionID === undefined) return
      await input.client.session.abort({ path: { id: sessionID }, throwOnError: true })
    },
  }
}

// Keep titles scannable in the sessions list: one line, bounded length, cut
// at a word boundary where possible.
const TITLE_LIMIT = 48

function sessionTitle(peer: string | undefined, text: string, taskId: string) {
  const collapsed = text.replace(/\s+/g, " ").trim()
  const window = collapsed.slice(0, TITLE_LIMIT)
  const lastSpace = window.lastIndexOf(" ")
  const clipped =
    collapsed.length <= TITLE_LIMIT
      ? collapsed
      : `${window.slice(0, lastSpace === -1 ? TITLE_LIMIT : lastSpace).trimEnd()}…`
  const label = clipped === "" ? taskId : clipped
  return peer === undefined ? `A2A · ${label}` : `A2A ${peer} · ${label}`
}

// Provider failures arrive as tagged objects (`{ name, data: { message } }`);
// keep the reason short enough for a task status message.
function failureText(failure: { name: string; data?: Record<string, unknown> }): string {
  const message = typeof failure.data?.message === "string" ? failure.data.message : undefined
  return message === undefined ? failure.name : `${failure.name}: ${message}`
}
