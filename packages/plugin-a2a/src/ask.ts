import { tool, type ToolResult } from "@opencode-ai/plugin/tool"
import { CAP_MESSAGE } from "./config.ts"
import type { Canceller } from "./cancel.ts"
import type { A2AEventEmitter } from "./events.ts"
import {
  ConversationStore,
  createConversationCore,
  readConfig,
  type ConfigProvider,
  type ConversationCore,
  type ConversationResult,
} from "./conversation.ts"
import type { Registry } from "./registry.ts"

export { ConversationStore, createConversationCore } from "./conversation.ts"
export type { Conversation, ConversationResult, ConfigProvider } from "./conversation.ts"

type AskArgs = {
  peer: string
  message: string
  taskId?: string
}

// A2A-014: the tool is now a thin wrapper over the shared conversation core.
// Callers that already own a core (the plugin) pass it in; tests may pass the
// original deps and the core is built here.
export function createAskTool(input: {
  config: ConfigProvider
  core?: ConversationCore
  store?: ConversationStore
  emit?: A2AEventEmitter
  cancel?: Canceller
  timeoutMs?: number
  pollMs?: number
  registry?: Registry
}) {
  const core =
    input.core ??
    createConversationCore({
      config: input.config,
      store: input.store ?? new ConversationStore(),
      emit: input.emit,
      cancel: input.cancel,
      timeoutMs: input.timeoutMs,
      pollMs: input.pollMs,
      registry: input.registry,
    })
  return tool({
    description:
      "Ask an allowed A2A peer agent a question and read its reply. " +
      "To follow up in the same conversation, pass the task id returned by the previous call.",
    args: {
      peer: tool.schema.string().describe("Peer name from the allowedPeers config"),
      message: tool.schema.string().describe("Text question or message to send to the peer"),
      taskId: tool.schema
        .string()
        .optional()
        .describe("Task id from a previous a2a_ask call; pass it to continue the same task"),
    },
    execute: async (args, context) => {
      const result = await core.startConversation(args.peer, args.message, {
        taskId: args.taskId,
        origin: "tool",
        sessionId: context?.sessionID,
        signal: context?.abort,
      })
      return renderResult(readConfig(input.config), args.peer, result)
    },
  })
}

function renderResult(config: { maxTurns: number }, peer: string, result: ConversationResult): ToolResult {
  if (result.terminal) return terminalResult(peer, result)
  if (result.capped) return capResult(config, peer, result)
  const lines = [`Peer: ${peer}`]
  if (result.taskId) lines.push(`Task: ${result.taskId}`)
  if (result.turn !== undefined) lines.push(`Turn: ${turnLabel(config, result.turn)}`)
  lines.push(result.reply ? `Reply: ${result.reply}` : "Reply: (none)")
  if (result.artifact) lines.push(`Artifact: ${result.artifact}`)
  return {
    title: result.turn !== undefined ? `${peer} turn ${turnLabel(config, result.turn)}` : `${peer} reply`,
    output: lines.join("\n"),
    metadata: {
      peerId: peer,
      ...(result.taskId ? { taskId: result.taskId } : {}),
      ...(result.turn !== undefined ? { turn: result.turn } : {}),
      state: result.state,
    },
  }
}

function turnLabel(config: { maxTurns: number }, turn: number) {
  return config.maxTurns > 0 ? `${turn}/${config.maxTurns}` : String(turn)
}

function terminalResult(peer: string, result: ConversationResult): ToolResult {
  const lines = [`Peer: ${peer}`]
  if (result.taskId) lines.push(`Task: ${result.taskId}`)
  lines.push(
    `State: ${result.state}`,
    "This task is already finished; send a new message without a taskId to start a new task.",
  )
  return {
    title: `task ${result.state}`,
    output: lines.join("\n"),
    metadata: {
      peerId: peer,
      ...(result.taskId ? { taskId: result.taskId } : {}),
      state: result.state,
    },
  }
}

function capResult(config: { maxTurns: number }, peer: string, result: ConversationResult): ToolResult {
  return {
    title: `max turns reached (${peer})`,
    output: [
      `Peer: ${peer}`,
      `Task: ${result.taskId}`,
      `Turn: ${result.turn}/${config.maxTurns}`,
      CAP_MESSAGE,
    ].join("\n"),
    metadata: {
      peerId: peer,
      taskId: result.taskId,
      turn: result.turn,
      state: "TASK_STATE_COMPLETED",
    },
  }
}
