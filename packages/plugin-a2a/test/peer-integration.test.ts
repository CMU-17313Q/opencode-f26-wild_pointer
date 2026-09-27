// Acceptance scenario as far as CI can go: the outbound a2a_ask tool talking to
// the real inbound bridge (A2AServer + session runner seam) over HTTP, with the
// session side scripted so no model is needed.
import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { ConversationStore, createAskTool } from "../src/ask.ts"
import { CAP_MESSAGE, type A2AConfig } from "../src/config.ts"
import { agentReplies, awaitState, configFor, fakeRunner, send, startBridge, userMessage } from "./bridge.ts"

function context(): ToolContext {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  }
}

async function call(
  toolDef: ReturnType<typeof createAskTool>,
  args: { peer: string; message: string; taskId?: string },
) {
  const result = await toolDef.execute(args, context())
  if (typeof result === "string") return { title: "", output: result, metadata: undefined }
  return result
}

describe("a2a_ask against the inbound bridge", () => {
  test("two turns in one task over message/stream, then the caps close it", async () => {
    const fake = fakeRunner({ replies: ["4", "because 2+2 is 4"] })
    const bridge = startBridge(fake.runner)
    try {
      const config: A2AConfig = { ...configFor(), allowedPeers: { "agent-b": bridge.baseUrl } }
      const toolDef = createAskTool({ config, store: new ConversationStore() })

      const first = await call(toolDef, { peer: "agent-b", message: "What is 2+2?" })
      expect(first.output).toContain("Reply: 4")
      expect(first.metadata?.turn).toBe(2)
      expect(first.metadata?.state).toBe("TASK_STATE_INPUT_REQUIRED")
      expect(typeof first.metadata?.taskId).toBe("string")

      const taskId = String(first.metadata?.taskId)
      const second = await call(toolDef, { peer: "agent-b", message: "Why?", taskId })
      expect(second.metadata?.taskId).toBe(taskId)
      expect(second.metadata?.turn).toBe(4)
      expect(second.metadata?.state).toBe("TASK_STATE_COMPLETED")
      // The completed status carries the cap reason to the peer...
      expect(second.output).toContain(CAP_MESSAGE)
      // ...while the final answer stays in the task history.
      const task = await bridge.client.getTask(taskId)
      expect(agentReplies(task)).toContain("because 2+2 is 4")

      // Our own cap stops a third ask before it reaches the network.
      const third = await call(toolDef, { peer: "agent-b", message: "One more?", taskId })
      expect(third.output).toContain(CAP_MESSAGE)
      expect(fake.runs.map((run) => run.text)).toEqual(["What is 2+2?", "Why?"])
    } finally {
      bridge.stop()
    }
  })

  test("message/send drives the same bridge without streaming", async () => {
    const fake = fakeRunner({ replies: ["4", "because 2+2 is 4"] })
    const bridge = startBridge(fake.runner)
    try {
      const first = await send(bridge.client, userMessage("What is 2+2?"))
      const waiting = await awaitState(bridge.client, first.id, "TASK_STATE_INPUT_REQUIRED")
      expect(agentReplies(waiting)).toEqual(["4"])

      await send(bridge.client, userMessage("Why?", { taskId: first.id }))
      const done = await awaitState(bridge.client, first.id, "TASK_STATE_COMPLETED")
      expect(agentReplies(done)).toEqual(["4", "because 2+2 is 4"])
      expect(done.status.message?.parts[0]?.text).toBe(CAP_MESSAGE)
      expect(fake.runs.map((run) => run.taskId)).toEqual([first.id, first.id])
    } finally {
      bridge.stop()
    }
  })
})
