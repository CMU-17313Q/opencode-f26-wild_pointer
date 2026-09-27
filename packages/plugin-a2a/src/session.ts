import type { PluginInput } from "@opencode-ai/plugin"
import { parseModel } from "./config.ts"

// The bridge talks to opencode through this seam only, so tests inject a fake
// runner (or a fake SDK client) instead of a real model.
export type SessionRunner = {
  run: (taskId: string, text: string, peer?: string) => Promise<{ sessionID: string; text: string }>
  abort: (taskId: string) => Promise<void>
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

  const sessionFor = async (taskId: string, peer?: string) => {
    const known = sessions.get(taskId)
    if (known !== undefined) return known
    const created = await input.client.session.create({
      // The session record is the identity trail: title names the peer (the
      // x-a2a-peer header, else the remote address) plus the A2A task id.
      body: { title: peer === undefined ? `A2A ${taskId}` : `A2A ${peer} ${taskId}` },
      throwOnError: true,
    })
    sessions.set(taskId, created.data.id)
    return created.data.id
  }

  return {
    async run(taskId, text, peer) {
      const sessionID = await sessionFor(taskId, peer)
      const result = await input.client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text }],
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(model === undefined ? {} : { model }),
        },
        throwOnError: true,
      })
      if (result.data.info.error) throw new Error(failureText(result.data.info.error))
      // A denied or rejected tool call lands as an errored tool part while the
      // turn may still produce text; surface it as a failed run so the peer
      // sees a clear TASK_STATE_FAILED instead of a polite refusal reply.
      const denied = result.data.parts.find(
        (part) =>
          part.type === "tool" &&
          part.state.status === "error" &&
          PERMISSION_MARK.test(part.state.error),
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

// Provider failures arrive as tagged objects (`{ name, data: { message } }`);
// keep the reason short enough for a task status message.
function failureText(failure: { name: string; data?: Record<string, unknown> }): string {
  const message = typeof failure.data?.message === "string" ? failure.data.message : undefined
  return message === undefined ? failure.name : `${failure.name}: ${message}`
}
