import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import plugin, { A2APlugin } from "../src/index.ts"

const input = {
  directory: process.cwd(),
  worktree: process.cwd(),
  // Enabling A2A now starts the inbound listener; it is only reached through
  // Bun.serve, and app.log exists so a bind failure can be reported.
  client: { app: { log: async () => undefined } },
} as unknown as PluginInput

beforeEach(() => {
  delete process.env.OPENCODE_A2A_ENABLED
})

afterEach(() => {
  delete process.env.OPENCODE_A2A_ENABLED
})

describe("plugin module", () => {
  test("exports the loader shape", () => {
    expect(plugin.id).toBe("a2a")
    expect(typeof plugin.server).toBe("function")
  })

  test("adds no tools and opens no ports when disabled", async () => {
    const serve = spyOn(Bun, "serve")
    const hooks = await A2APlugin(input)
    expect(hooks.tool).toBeUndefined()
    expect(serve).not.toHaveBeenCalled()
    serve.mockRestore()
  })
})

describe("opt-in", () => {
  test("enables through OPENCODE_A2A_ENABLED", async () => {
    process.env.OPENCODE_A2A_ENABLED = "1"
    const hooks = await A2APlugin(input)
    expect(hooks.tool?.a2a_ask).toBeDefined()
    await hooks.dispose?.()
  })

  test("enables through plugin options", async () => {
    const hooks = await A2APlugin(input, { a2a: { enabled: true } })
    expect(hooks.tool?.a2a_ask).toBeDefined()
    await hooks.dispose?.()
  })

  test("config hook can enable the tool", async () => {
    const hooks = await A2APlugin(input, { a2a: { enabled: false } })
    expect(hooks.tool).toBeUndefined()
    await hooks.config?.({ a2a: { enabled: true } } as unknown as Config)
    expect(hooks.tool?.a2a_ask).toBeDefined()
    await hooks.dispose?.()
  })

  test("config hook ignores stray top-level config keys", async () => {
    const hooks = await A2APlugin(input)
    await hooks.config?.({ $schema: "https://opencode.ai/config.json", enabled: true } as unknown as Config)
    expect(hooks.tool).toBeUndefined()
  })
})
