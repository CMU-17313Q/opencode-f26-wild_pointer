#!/usr/bin/env bun
// A2A-010 demo: Agent A's side of the four-turn cross-computer debate.
//
// Agent B is an opencode instance running plugin-a2a with its inbound bridge
// listening. This script plays Agent A over the real A2A wire protocol — the
// same calls a2a_ask makes: message/send to open the task, a follow-up on the
// same taskId, tasks/get polling between turns.
//
//   bun run demo/debate.ts --peer http://<agent-b-host>:<port> [--name agent-a]
//
// The debate is four turns: A opens, B replies, A challenges, B finalizes.
// B's bridge completes the task at its turn cap and attaches the verdict as
// an Artifact, which this script prints from tasks/get.

import { A2AClient, A2A_PEER_HEADER, type Message, type Task } from "a2a"

const INTERRUPTED = new Set(["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"])
const TERMINAL = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
])

function args(): { peer: string; name: string; topic: string } {
  const flag = (name: string) => {
    const index = process.argv.indexOf(name)
    return index === -1 ? undefined : process.argv[index + 1]
  }
  const peer = flag("--peer")
  if (!peer) {
    console.error("usage: bun run demo/debate.ts --peer http://<host>:<port> [--name agent-a] [--topic <question>]")
    process.exit(2)
  }
  return {
    peer,
    name: flag("--name") ?? "agent-a",
    topic: flag("--topic") ?? "spaces are objectively better than tabs for code style",
  }
}

function userMessage(text: string, taskId?: string): Message {
  return {
    messageId: crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [{ text }],
    ...(taskId ? { taskId } : {}),
  }
}

function agentReply(task: Task): string {
  const last = (task.history ?? []).filter((message) => message.role === "ROLE_AGENT").at(-1)
  return last ? last.parts.map((part) => part.text).join("\n") : "(no reply yet)"
}

async function waitFor(client: A2AClient, taskId: string, label: string): Promise<Task> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const task = await client.getTask(taskId)
    const state = task.status.state
    if (INTERRUPTED.has(state) || TERMINAL.has(state)) return task
    await Bun.sleep(500)
  }
  throw new Error(`timed out waiting for ${label} on task ${taskId}`)
}

async function main() {
  const { peer, name, topic } = args()
  const client = new A2AClient({ baseUrl: peer, headers: { [A2A_PEER_HEADER]: name } })
  const opening = `Resolved: ${topic}. Take the opposing position and defend it in one short paragraph.`
  const challenge =
    "I disagree with your reasoning — the evidence cuts the other way. Concede or give your final verdict."

  const card = await client.fetchAgentCard()
  console.log(`peer card: ${card.name} @ ${peer}`)

  console.log(`\n[turn 1] ${name} → ${opening}`)
  const opened = await client.sendMessage(userMessage(opening))
  if (!("id" in opened)) throw new Error("peer answered with a bare message; expected a task")
  const taskId = opened.id
  console.log(`task ${taskId} created (${opened.status.state})`)

  const first = await waitFor(client, taskId, "first reply")
  console.log(`\n[turn 2] ${card.name} → ${agentReply(first)}`)

  console.log(`\n[turn 3] ${name} → ${challenge}`)
  await client.sendMessage(userMessage(challenge, taskId))

  const done = await waitFor(client, taskId, "verdict")
  console.log(`\n[turn 4] ${card.name} → ${agentReply(done)}`)
  console.log(`\nfinal state: ${done.status.state}`)

  const verdict = done.artifacts?.at(-1)
  if (!verdict) throw new Error(`task ${taskId} completed without a verdict artifact`)
  console.log(`verdict artifact (${verdict.artifactId}):`)
  console.log(verdict.parts.map((part) => part.text).join("\n"))
}

await main()
