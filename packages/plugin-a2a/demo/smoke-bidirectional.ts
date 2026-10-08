#!/usr/bin/env bun
// A2A-011 bidirectional smoke test: both directions complete a 2-turn exchange
// with turn events present, one taskId per direction.
//
// Direction A (opencode → peer) goes through the REAL a2a_ask tool with a
// recording emitter. Direction B (peer → opencode) speaks raw A2A to a live
// inbound bridge while turn events are captured off the serve SSE stream, the
// same fan-out the app UI reads.
//
//   bun run demo/smoke-bidirectional.ts \
//     --peer http://<peer-host>:<port> --peer-id agent-a \
//     --inbound http://localhost:<own-a2a-port> --serve http://localhost:4096 \
//     --name agent-b
//
// Loopback (one machine, real model): point --peer at your own A2A port with a
// self entry in allowedPeers. Cross-machine: --peer is the friend's URL and
// --inbound/--serve are yours; the friend mirrors with the flags flipped.

import { A2AClient, A2A_PEER_HEADER, type Message, type Task } from "a2a"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { ConversationStore, createAskTool } from "../src/ask.ts"
import type { A2AConfig } from "../src/config.ts"
import type { A2AEventEmitter } from "../src/events.ts"

const INTERRUPTED = new Set(["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"])
const TERMINAL = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
])
const SETTLED = new Set([...INTERRUPTED, ...TERMINAL])

const ASK_Q1 = "What is 12+12? Reply with just the number."
const ASK_Q2 = "And 13+13? Reply with just the number."
const IN_Q1 = "What is 20+20? Reply with just the number."
const IN_Q2 = "And 30+30? Reply with just the number."

type RecordedEvent = { type: string; properties: Record<string, unknown> }

function eventLog() {
  const events: RecordedEvent[] = []
  const emit: A2AEventEmitter = (type, properties) => {
    events.push({ type, properties: { ...properties } })
  }
  return { events, emit }
}

function context(): ToolContext {
  return {
    sessionID: "ses_smoke",
    messageID: "msg_smoke",
    agent: "build",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  }
}

function args(): { peer: string; peerId: string; inbound: string; serve: string; name: string } {
  const flag = (name: string) => {
    const index = process.argv.indexOf(name)
    return index === -1 ? undefined : process.argv[index + 1]
  }
  const peer = flag("--peer")
  const inbound = flag("--inbound")
  const serve = flag("--serve")
  if (!peer || !inbound || !serve) {
    console.error(
      "usage: bun run demo/smoke-bidirectional.ts --peer http://<peer-host>:<port> --peer-id agent-a --inbound http://localhost:<own-a2a-port> --serve http://localhost:4096 [--name agent-b]",
    )
    process.exit(2)
  }
  return { peer, peerId: flag("--peer-id") ?? "agent-a", inbound, serve, name: flag("--name") ?? "agent-b" }
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(`SMOKE FAIL: ${message}`)
  console.log(`ok: ${message}`)
}

function agentReplies(task: Task): string[] {
  return (task.history ?? [])
    .filter((message) => message.role === "ROLE_AGENT")
    .map((message) => message.parts.map((part) => part.text).join("\n"))
}

function turnSpeakers(events: RecordedEvent[], taskId: string): string[] {
  return events
    .filter((event) => event.type === "a2a.conversation.turn" && event.properties.taskId === taskId)
    .map((event) => `${String(event.properties.speaker)}@${String(event.properties.turn)}`)
}

// Long-lived SSE subscription to the serve global event stream. Resolves with
// a collector holding every a2a.* payload seen while the test runs.
async function subscribeServeEvents(serve: string) {
  const seen: RecordedEvent[] = []
  const controller = new AbortController()
  const response = await fetch(`${serve}/global/event`, { signal: controller.signal })
  if (!response.ok || !response.body) throw new Error(`event stream failed: HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const text = line.startsWith("data:") ? line.slice(5).trim() : ""
          if (!text) continue
          try {
            const payload = (JSON.parse(text) as { payload?: { type?: string; properties?: Record<string, unknown> } })
              .payload
            if (payload?.type?.startsWith("a2a."))
              seen.push({ type: payload.type, properties: payload.properties ?? {} })
          } catch {
            // heartbeat framing or partial chunk: ignore
          }
        }
      }
    } catch {
      // aborted at the end of the run
    }
  }
  const done = pump()
  return { seen, stop: async () => {
    controller.abort()
    await done
  } }
}

function userMessage(text: string, taskId?: string): Message {
  return {
    messageId: crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [{ text }],
    ...(taskId ? { taskId } : {}),
  }
}

async function waitFor(client: A2AClient, taskId: string, label: string): Promise<Task> {
  const deadline = Date.now() + 180_000
  for (;;) {
    const task = await client.getTask(taskId)
    if (SETTLED.has(task.status.state)) return task
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} on task ${taskId}`)
    await Bun.sleep(1000)
  }
}

async function main() {
  const { peer, peerId, inbound, serve, name } = args()

  console.log("--- subscribing to serve event stream ---")
  const stream = await subscribeServeEvents(serve)
  console.log(`ok: event stream open on ${serve}`)

  try {
    console.log("\n--- direction A: opencode -> peer via a2a_ask ---")
    const askLog = eventLog()
    const config: A2AConfig = {
      enabled: true,
      listenPort: 0,
      allowedPeers: { [peerId]: peer },
      maxTurns: 4,
      name,
    }
    const ask = createAskTool({ config, store: new ConversationStore(), emit: askLog.emit, timeoutMs: 180_000 })
    const call = async (message: string, taskId?: string) => {
      const result = await ask.execute({ peer: peerId, message, taskId }, context())
      if (typeof result === "string") throw new Error(`a2a_ask returned a string: ${result}`)
      return result
    }

    const first = await call(ASK_Q1)
    const taskId = String(first.metadata?.taskId)
    check(typeof first.metadata?.taskId === "string", `direction A turn 1 reply under task ${taskId}`)
    console.log(`  reply: ${(first.output.split("\n").find((line) => line.startsWith("Reply:")) ?? "").slice(0, 80)}`)
    const second = await call(ASK_Q2, taskId)
    check(second.metadata?.taskId === taskId, "direction A turn 2 reuses the same taskId")
    const askTurns = turnSpeakers(askLog.events, taskId)
    check(
      JSON.stringify(askTurns) === JSON.stringify(["local@0", "remote@1", "local@2", "remote@3"]),
      `direction A turn events present (${askTurns.join(", ")})`,
    )
    check(
      askLog.events.some((event) => event.type === "a2a.task.dispatched"),
      "direction A task.dispatched event present",
    )

    console.log("\n--- direction B: peer -> opencode inbound reply path ---")
    const client = new A2AClient({ baseUrl: inbound, headers: { [A2A_PEER_HEADER]: name } })
    const card = await client.fetchAgentCard()
    console.log(`peer card: ${card.name} @ ${inbound}`)
    const opened = await client.sendMessage(userMessage(IN_Q1))
    if (!("id" in opened)) throw new Error("SMOKE FAIL: inbound answered with a bare message; expected a task")
    const inTaskId = opened.id
    console.log(`task ${inTaskId} created`)
    const reply1 = await waitFor(client, inTaskId, "first reply")
    check(agentReplies(reply1).length === 1, `direction B turn 1 reply: ${agentReplies(reply1)[0]?.slice(0, 60)}`)
    await client.sendMessage(userMessage(IN_Q2, inTaskId))
    const reply2 = await waitFor(client, inTaskId, "second reply")
    check(agentReplies(reply2).length === 2, `direction B turn 2 reply: ${agentReplies(reply2)[1]?.slice(0, 60)}`)
    const inTurns = turnSpeakers(stream.seen, inTaskId)
    check(
      JSON.stringify(inTurns) === JSON.stringify(["remote@0", "local@1", "remote@2", "local@3"]),
      `direction B turn events present on serve stream (${inTurns.join(", ")})`,
    )

    console.log(`\nSMOKE PASS: both directions completed 2 turns (tasks ${taskId}, ${inTaskId}) with turn events`)
  } finally {
    await stream.stop()
  }
}

await main()
