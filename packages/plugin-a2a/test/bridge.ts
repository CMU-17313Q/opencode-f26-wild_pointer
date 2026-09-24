// Shared harness for the inbound-side tests: a scripted session runner (no
// real model in CI) plus HTTP helpers for driving the bridge through a real
// A2AServer the way any A2A peer would.
import { A2AClient, type Message, type Task, type TaskState } from "a2a"
import type { A2AConfig } from "../src/config.ts"
import { startInboundServer } from "../src/inbound.ts"
import type { SessionRunner } from "../src/session.ts"

export function configFor(overrides: Partial<A2AConfig> = {}): A2AConfig {
  return { enabled: true, listenPort: 0, allowedPeers: {}, maxTurns: 4, ...overrides }
}

export function fakeRunner(
  options: { replies?: string[]; error?: string; delayMs?: number; gate?: Promise<void> } = {},
) {
  const runs: Array<{ taskId: string; text: string }> = []
  const peers: Array<string | undefined> = []
  const aborted: string[] = []
  let active = 0
  let overlapped = false
  const runner: SessionRunner = {
    async run(taskId, text, peer) {
      runs.push({ taskId, text })
      peers.push(peer)
      active += 1
      if (active > 1) overlapped = true
      if (options.gate) await options.gate
      if (options.delayMs) await Bun.sleep(options.delayMs)
      active -= 1
      if (options.error) throw new Error(options.error)
      return { sessionID: `ses_${taskId}`, text: options.replies?.[runs.length - 1] ?? `reply ${runs.length}` }
    },
    async abort(taskId) {
      aborted.push(taskId)
    },
  }
  return { runner, runs, peers, aborted, overlapped: () => overlapped }
}

export function startBridge(runner: SessionRunner, overrides?: Partial<A2AConfig>) {
  const inbound = startInboundServer({ config: configFor(overrides), runner })
  const baseUrl = `http://localhost:${inbound.port}`
  return { ...inbound, baseUrl, client: new A2AClient({ baseUrl }) }
}

export function userMessage(text: string, extra: Partial<Message> = {}): Message {
  return { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...extra }
}

export async function send(client: A2AClient, message: Message): Promise<Task> {
  const response = await client.sendMessage(message)
  if (!("id" in response)) throw new Error("expected the bridge to return a task")
  return response
}

export async function awaitState(client: A2AClient, taskId: string, ...states: TaskState[]): Promise<Task> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const task = await client.getTask(taskId)
    if (states.includes(task.status.state)) return task
    await Bun.sleep(5)
  }
  throw new Error(`task ${taskId} never reached ${states.join(" or ")}`)
}

export function agentReplies(task: Task): string[] {
  return (task.history ?? [])
    .filter((message) => message.role === "ROLE_AGENT")
    .map((message) => message.parts.map((part) => part.text).join("\n"))
}
