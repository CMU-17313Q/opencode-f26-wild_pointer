import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { createSessionRunner } from "../src/session.ts"

type Part = { type: string; text: string; synthetic?: boolean; ignored?: boolean }
type PromptBody = { parts: Part[]; agent?: string; model?: { providerID: string; modelID: string } }
type PromptReply = {
  info?: { error?: { name: string; data?: Record<string, unknown> } }
  parts: Part[]
}

// A fake SDK client that records what the runner did. The runner only ever
// touches `session.create/prompt/abort`, so the rest of OpencodeClient stays
// out of the way; the cast mirrors that narrow surface.
function fakeClient(reply?: (call: { id: string; body: PromptBody }) => PromptReply) {
  const created: Array<{ title?: string }> = []
  const prompts: Array<{ id: string; body: PromptBody }> = []
  const aborted: string[] = []
  let sessions = 0
  const client = {
    session: {
      create: async (options: { body?: { title?: string } }) => {
        created.push(options.body ?? {})
        sessions += 1
        return { data: { id: `ses_${sessions}` } }
      },
      prompt: async (options: { path: { id: string }; body: PromptBody }) => {
        prompts.push({ id: options.path.id, body: options.body })
        const custom = reply?.({ id: options.path.id, body: options.body })
        // The real prompt response always carries `info`; custom replies only
        // override it when they model an assistant error.
        return { data: { info: {}, parts: [{ type: "text", text: "ok" }], ...custom } }
      },
      abort: async (options: { path: { id: string } }) => {
        aborted.push(options.path.id)
        return { data: true }
      },
    },
  }
  return { client: client as unknown as PluginInput["client"], created, prompts, aborted }
}

describe("session runner", () => {
  test("creates one session per task and reuses it", async () => {
    const fake = fakeClient()
    const runner = createSessionRunner({ client: fake.client })

    const first = await runner.run("task-1", "hi")
    const second = await runner.run("task-1", "again")
    const other = await runner.run("task-2", "hi")

    expect(first.sessionID).toBe("ses_1")
    expect(second.sessionID).toBe("ses_1")
    expect(other.sessionID).toBe("ses_2")
    expect(fake.created).toEqual([{ title: "A2A task-1" }, { title: "A2A task-2" }])
    expect(fake.prompts.map((call) => call.id)).toEqual(["ses_1", "ses_1", "ses_2"])
  })

  test("passes the peer's text through as one text part", async () => {
    const fake = fakeClient()
    const runner = createSessionRunner({ client: fake.client })
    await runner.run("task-1", "What is 2+2?")
    expect(fake.prompts[0].body).toEqual({ parts: [{ type: "text", text: "What is 2+2?" }] })
  })

  test("passes agent and a provider/model string through", async () => {
    const fake = fakeClient()
    const runner = createSessionRunner({
      client: fake.client,
      agent: "build",
      model: "anthropic/claude-sonnet-4-5",
    })
    await runner.run("task-1", "hi")
    expect(fake.prompts[0].body).toEqual({
      parts: [{ type: "text", text: "hi" }],
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    })
  })

  test("splits the model on the first slash only", async () => {
    const fake = fakeClient()
    const runner = createSessionRunner({ client: fake.client, model: "openrouter/vendor/model" })
    await runner.run("task-1", "hi")
    expect(fake.prompts[0].body.model).toEqual({ providerID: "openrouter", modelID: "vendor/model" })
  })

  test("extracts only visible text from the reply", async () => {
    const fake = fakeClient(() => ({
      parts: [
        { type: "text", text: "hello" },
        { type: "reasoning", text: "thinking out loud" },
        { type: "text", text: "auto", synthetic: true },
        { type: "text", text: "hidden", ignored: true },
        { type: "text", text: "world" },
      ],
    }))
    const runner = createSessionRunner({ client: fake.client })
    const result = await runner.run("task-1", "hi")
    expect(result.text).toBe("hello\nworld")
  })

  test("throws when the assistant message carries an error", async () => {
    const fake = fakeClient(() => ({
      info: { error: { name: "UnknownError", data: { message: "provider exploded" } } },
      parts: [{ type: "text", text: "partial" }],
    }))
    const runner = createSessionRunner({ client: fake.client })
    await expect(runner.run("task-1", "hi")).rejects.toThrow("UnknownError: provider exploded")
  })

  test("throws when the reply has no visible text", async () => {
    const reasoningOnly = fakeClient(() => ({ parts: [{ type: "reasoning", text: "hmm" }] }))
    const whitespace = fakeClient(() => ({ parts: [{ type: "text", text: "   " }] }))
    await expect(createSessionRunner({ client: reasoningOnly.client }).run("task-1", "hi")).rejects.toThrow(
      "no text reply",
    )
    await expect(createSessionRunner({ client: whitespace.client }).run("task-1", "hi")).rejects.toThrow(
      "no text reply",
    )
  })

  test("aborts only sessions it created", async () => {
    const fake = fakeClient()
    const runner = createSessionRunner({ client: fake.client })
    await runner.run("task-1", "hi")

    await runner.abort("task-1")
    expect(fake.aborted).toEqual(["ses_1"])

    await runner.abort("unknown-task")
    expect(fake.aborted).toEqual(["ses_1"])
  })
})
