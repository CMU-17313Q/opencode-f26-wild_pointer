import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { ConversationStore, createAskTool } from "./ask.ts"
import { resolveConfig, type A2AConfig } from "./config.ts"
import { startInboundServer } from "./inbound.ts"
import { createSessionRunner, type SessionRunner } from "./session.ts"

// Registered with the plugin loader and gated on config: when A2A is disabled
// the plugin exposes no tools and starts nothing.
export const A2APlugin: Plugin = async (input: PluginInput, options) => {
  const store = new ConversationStore()
  const hooks: Hooks = {}
  let runner: SessionRunner | undefined
  let inbound: { stop: () => void } | undefined

  const apply = (config: A2AConfig) => {
    if (!config.enabled) {
      delete hooks.tool
      delete hooks.dispose
      inbound?.stop()
      inbound = undefined
      return
    }
    hooks.tool = { a2a_ask: createAskTool({ config, store }) }
    hooks.dispose = async () => {
      inbound?.stop()
      inbound = undefined
    }
    if (inbound !== undefined) return
    try {
      // Created once so taskId → session mappings survive config
      // re-application; the first resolved agent/model wins.
      runner ??= createSessionRunner({ client: input.client, agent: config.agent, model: config.model })
      inbound = startInboundServer({ config, runner })
    } catch (error) {
      // A bind failure (port in use) must never crash plugin init: the
      // outbound tool still works without the inbound listener.
      const message = error instanceof Error ? error.message : String(error)
      input.client.app
        .log({ body: { service: "plugin-a2a", level: "error", message: `inbound A2A listener failed: ${message}` } })
        .catch(() => undefined)
    }
  }

  apply(resolveConfig({ options, env: process.env }))

  // opencode calls this once the merged config is available. Re-applying keeps
  // the hook path working if an `a2a` section ever reaches the config.
  hooks.config = async (config) => {
    apply(resolveConfig({ options, env: process.env, hookConfig: config }))
  }

  return hooks
}

const plugin: PluginModule = { id: "a2a", server: A2APlugin }
export default plugin
