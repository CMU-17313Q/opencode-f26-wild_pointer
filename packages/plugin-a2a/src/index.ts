import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { ConversationStore, createAskTool } from "./ask.ts"
import { resolveConfig, type A2AConfig } from "./config.ts"

// Registered with the plugin loader and gated on config: when A2A is disabled
// the plugin exposes no tools and starts nothing.
export const A2APlugin: Plugin = async (_input: PluginInput, options) => {
  const store = new ConversationStore()
  const hooks: Hooks = {}

  const apply = (config: A2AConfig) => {
    if (!config.enabled) {
      delete hooks.tool
      return
    }
    hooks.tool = { a2a_ask: createAskTool({ config, store }) }
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
