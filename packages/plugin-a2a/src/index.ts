import path from "node:path"
import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { startAdminServer, type AdminServer } from "./admin.ts"
import { createAskTool } from "./ask.ts"
import { createCanceller } from "./cancel.ts"
import { resolveConfig, type A2AConfig } from "./config.ts"
import { createConversationCore, ConversationStore } from "./conversation.ts"
import { createEventEmitter } from "./events.ts"
import { startInboundServer } from "./inbound.ts"
import { createPeerManager } from "./peers.ts"
import { createConversationRegistry } from "./registry.ts"
import { createSessionRunner, type SessionRunner } from "./session.ts"

// Registered with the plugin loader and gated on config: when A2A is disabled
// the plugin exposes no tools and starts nothing.
export const A2APlugin: Plugin = async (input: PluginInput, options) => {
  const store = new ConversationStore()
  // a2a.* UI events (a2a.conversation.turn, a2a.task.*) go on the host's global
  // bus tagged with this directory so the app's event stream can route them.
  const emit = createEventEmitter(input.directory)
  const hooks: Hooks = {}
  const stateDir = path.join(input.directory, ".opencode", "a2a")
  // The session registry mirrors every a2a.* event and persists the last 50
  // tasks; a task a dead process left running settles as failed on load.
  const registry = createConversationRegistry({ file: path.join(stateDir, "sessions.json") })
  await registry.load()
  let runner: SessionRunner | undefined
  let inbound: ReturnType<typeof startInboundServer> | undefined
  let admin: AdminServer | undefined
  // A2A-013: apply() runs once on load and again from the config hook. The
  // missing-name notice is per plugin instance, so remember that it went out.
  let nameNoticeSent = false
  let hookConfig: unknown
  // The live resolved config the tool and control API read; peer edits replace
  // it in place so a new peer is usable without restarting the host.
  let config = resolveConfig({ options, env: process.env })
  // A2A-012: one cancel routine for the whole plugin. Remote tasks go through
  // the conversation's client, local tasks through the inbound listener; the
  // canceller attempts both and tolerates whichever side is absent.
  const cancel = createCanceller({ store, emit, local: () => inbound?.cancel })
  // A2A-014: the conversation core is shared by a2a_ask, the local control API,
  // and the session registry, so every path keeps the same semantics.
  const core = createConversationCore({ config: () => config, store, emit, cancel, registry })
  const peers = createPeerManager({
    directory: input.directory,
    config: () => config,
    resolve: (options) => resolveConfig({ options, env: process.env, hookConfig }),
    apply: (next) => {
      config = next
    },
  })

  const apply = async (next: A2AConfig) => {
    config = next
    if (!config.enabled) {
      delete hooks.tool
      delete hooks.dispose
      inbound?.stop()
      inbound = undefined
      if (admin !== undefined) {
        const server = admin
        admin = undefined
        await server.stop()
      }
      return
    }
    hooks.tool = { a2a_ask: createAskTool({ config: () => config, core }) }
    hooks.dispose = async () => {
      inbound?.stop()
      inbound = undefined
      if (admin !== undefined) {
        const server = admin
        admin = undefined
        await server.stop()
      }
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
    if (inbound === undefined) {
      try {
        // Created once so taskId → session mappings survive config
        // re-application; the first resolved agent/model wins.
        runner ??= createSessionRunner({ client: input.client, agent: config.agent, model: config.model })
        inbound = startInboundServer({ config, runner, emit, registry })
      } catch (error) {
        // A bind failure (port in use) must never crash plugin init: the
        // outbound tool still works without the inbound listener.
        const message = error instanceof Error ? error.message : String(error)
        input.client.app
          .log({ body: { service: "plugin-a2a", level: "error", message: `inbound A2A listener failed: ${message}` } })
          .catch(() => undefined)
      }
    }
    if (admin === undefined) {
      try {
        admin = await startAdminServer({
          registry,
          core,
          peers,
          config: () => config,
          inboundPort: () => inbound?.port,
          portFile: path.join(stateDir, "admin.port"),
        })
      } catch (error) {
        // Mirror the inbound listener: a bind failure on the loopback control
        // API must never crash plugin init.
        const message = error instanceof Error ? error.message : String(error)
        input.client.app
          .log({
            body: { service: "plugin-a2a", level: "error", message: `admin control API failed: ${message}` },
          })
          .catch(() => undefined)
      }
    }
  }

  await apply(config)

  // opencode calls this once the merged config is available. Re-applying keeps
  // the hook path working if an `a2a` section ever reaches the config.
  hooks.config = async (next) => {
    hookConfig = next
    await apply(resolveConfig({ options, env: process.env, hookConfig: next }))
  }

  return hooks
}

const plugin: PluginModule = { id: "a2a", server: A2APlugin }
export default plugin
