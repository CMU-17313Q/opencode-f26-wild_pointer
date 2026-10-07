import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { ConversationStore, createAskTool } from "./ask.ts"
import { createCanceller } from "./cancel.ts"
import { resolveConfig, type A2AConfig } from "./config.ts"
import { createEventEmitter } from "./events.ts"
import { startInboundServer } from "./inbound.ts"
import { createSessionRunner, type SessionRunner } from "./session.ts"

// Registered with the plugin loader and gated on config: when A2A is disabled
// the plugin exposes no tools and starts nothing.
export const A2APlugin: Plugin = async (input: PluginInput, options) => {
  const store = new ConversationStore()
  // a2a.* UI events (a2a.conversation.turn, a2a.task.*) go on the host's global
  // bus tagged with this directory so the app's event stream can route them.
  const emit = createEventEmitter(input.directory)
  const hooks: Hooks = {}
  let runner: SessionRunner | undefined
  let inbound: ReturnType<typeof startInboundServer> | undefined
  // A2A-013: apply() runs once on load and again from the config hook. The
  // missing-name notice is per plugin instance, so remember that it went out.
  let nameNoticeSent = false
  // A2A-012: one cancel routine for the whole plugin. Remote tasks go through
  // the conversation's client, local tasks through the inbound listener; the
  // canceller attempts both and tolerates whichever side is absent.
  const cancel = createCanceller({ store, emit, local: () => inbound?.cancel })

  const apply = (config: A2AConfig) => {
    if (!config.enabled) {
      delete hooks.tool
      delete hooks.dispose
      inbound?.stop()
      inbound = undefined
      return
    }
    hooks.tool = { a2a_ask: createAskTool({ config, store, emit, cancel }) }
    hooks.dispose = async () => {
      inbound?.stop()
      inbound = undefined
    }
    // A2A-013: name is optional for back-compat, but without it peers only see
    // this instance's socket address. Nudge once per plugin instance, never on
    // every config re-apply.
    if (config.name === undefined && !nameNoticeSent) {
      nameNoticeSent = true
      input.client.app
        .log({
          body: {
            service: "plugin-a2a",
            level: "warn",
            message:
              "A2A is enabled without a name — peers will see your socket address; set `a2a.name` in the plugin options",
          },
        })
        .catch(() => undefined)
    }
    if (inbound !== undefined) return
    try {
      // Created once so taskId → session mappings survive config
      // re-application; the first resolved agent/model wins.
      runner ??= createSessionRunner({ client: input.client, agent: config.agent, model: config.model })
      inbound = startInboundServer({ config, runner, emit })
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
