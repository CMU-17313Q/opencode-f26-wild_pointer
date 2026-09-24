import { describe, expect, test } from "bun:test"
import { resolveConfig } from "../src/config.ts"

describe("resolveConfig", () => {
  test("is disabled with safe defaults", () => {
    expect(resolveConfig({ env: {} })).toEqual({
      enabled: false,
      listenPort: 0,
      allowedPeers: {},
      maxTurns: 4,
    })
  })

  test("enables through the environment variable", () => {
    expect(resolveConfig({ env: { OPENCODE_A2A_ENABLED: "1" } }).enabled).toBe(true)
    expect(resolveConfig({ env: { OPENCODE_A2A_ENABLED: "true" } }).enabled).toBe(true)
    expect(resolveConfig({ env: { OPENCODE_A2A_ENABLED: "0" } }).enabled).toBe(false)
    expect(resolveConfig({ env: { OPENCODE_A2A_ENABLED: "" } }).enabled).toBe(false)
  })

  test("reads nested plugin options", () => {
    const config = resolveConfig({
      env: {},
      options: {
        a2a: {
          enabled: true,
          listenPort: 4321,
          allowedPeers: { "peer-a": "http://peer-a.test:4321" },
          maxTurns: 6,
        },
      },
    })
    expect(config).toEqual({
      enabled: true,
      listenPort: 4321,
      allowedPeers: { "peer-a": "http://peer-a.test:4321" },
      maxTurns: 6,
    })
  })

  test("reads flat plugin options", () => {
    const config = resolveConfig({
      env: {},
      options: { enabled: true, maxTurns: 2 },
    })
    expect(config.enabled).toBe(true)
    expect(config.maxTurns).toBe(2)
  })

  test("hook config wins over plugin options", () => {
    const config = resolveConfig({
      env: {},
      options: { enabled: true, maxTurns: 3 },
      hookConfig: { a2a: { maxTurns: 2 } },
    })
    expect(config.maxTurns).toBe(2)
  })

  test("hook config only reads an explicit a2a section", () => {
    const stray = resolveConfig({
      env: {},
      hookConfig: { $schema: "https://opencode.ai/config.json", model: "x", enabled: true, maxTurns: 2 },
    })
    expect(stray.enabled).toBe(false)
    expect(stray.maxTurns).toBe(4)

    const explicit = resolveConfig({ env: {}, hookConfig: { a2a: { enabled: true, maxTurns: 2 } } })
    expect(explicit.enabled).toBe(true)
    expect(explicit.maxTurns).toBe(2)
  })

  test("enabled is an OR across sources", () => {
    const config = resolveConfig({
      env: {},
      options: { enabled: false },
      hookConfig: { a2a: { enabled: true } },
    })
    expect(config.enabled).toBe(true)
  })

  test("rejects a non-positive maxTurns", () => {
    expect(() => resolveConfig({ env: {}, options: { maxTurns: 0 } })).toThrow()
    expect(() => resolveConfig({ env: {}, options: { maxTurns: 1.5 } })).toThrow()
  })

  test("rejects an invalid peer URL", () => {
    expect(() => resolveConfig({ env: {}, options: { allowedPeers: { "peer-a": "not a url" } } })).toThrow(
      'Invalid URL for A2A peer "peer-a"',
    )
  })
})
