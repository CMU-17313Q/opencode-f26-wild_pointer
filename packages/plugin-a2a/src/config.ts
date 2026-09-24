import { z } from "zod"

// Turn cap outcome shared by the plugin and the tracker: a capped conversation
// is a bounded result, not a crash.
export const CAP_MESSAGE = "max turns reached without verdict"

export const A2AConfigSchema = z.object({
  enabled: z.boolean().default(false),
  listenPort: z.number().int().min(0).max(65535).default(0),
  allowedPeers: z.record(z.string(), z.string()).default({}),
  maxTurns: z.number().int().positive().default(4),
})
export type A2AConfig = z.infer<typeof A2AConfigSchema>

// Config can arrive from three places:
//   1. plugin options in opencode.json: ["plugin", [[spec, { a2a: {...} }]]]
//   2. OPENCODE_A2A_ENABLED=1
//   3. the plugin `config` hook, once opencode exposes an `a2a` section
// Precedence is hook > options > env > defaults; `enabled` is an OR.
export function resolveConfig(input: {
  options?: Record<string, unknown>
  env?: Record<string, string | undefined>
  hookConfig?: unknown
}): A2AConfig {
  const options = optionsSection(input.options)
  const hook = hookSection(input.hookConfig)
  const parsed = A2AConfigSchema.parse({
    ...options,
    ...hook,
    enabled: options.enabled === true || hook.enabled === true || envEnabled(input.env),
  })
  for (const [id, url] of Object.entries(parsed.allowedPeers)) requireUrl(id, url)
  return parsed
}

// Plugin options may be written nested (`{ "a2a": {...} }`) or flat
// (`{ "enabled": true }`), so both shapes read naturally in opencode.json.
function optionsSection(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  if (isRecord(value.a2a)) return value.a2a
  return value
}

// The config hook receives the whole merged opencode config. Only an explicit
// `a2a` section belongs to this plugin; never treat the rest as options, or a
// future top-level key like `enabled` could switch A2A on by accident.
function hookSection(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  return isRecord(value.a2a) ? value.a2a : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function envEnabled(env: Record<string, string | undefined> | undefined) {
  const value = env?.OPENCODE_A2A_ENABLED?.toLowerCase()
  return value === "1" || value === "true"
}

function requireUrl(id: string, url: string) {
  try {
    new URL(url)
  } catch {
    throw new Error(`Invalid URL for A2A peer "${id}": ${url}`)
  }
}
