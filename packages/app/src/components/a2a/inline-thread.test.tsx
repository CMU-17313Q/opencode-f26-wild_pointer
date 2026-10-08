import { describe, expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { render } from "solid-js/web"
import type { A2AThreadData } from "@/a2a/thread-store"
import { LanguageProvider } from "@/context/language"
import { PlatformProvider, type Platform } from "@/context/platform"
import { A2AInlineThread, a2aTaskRunning, createInlineThreadFold, inlineThreadSignature } from "./inline-thread"

const fixture: A2AThreadData = {
  taskId: "t1",
  turns: [
    { index: 0, speaker: "local", peerId: "agent-b", taskId: "t1", text: "hello peer" },
    { index: 1, speaker: "remote", peerId: "agent-a", taskId: "t1", text: "hi back" },
  ],
  states: ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"],
  status: "all done",
  artifact: { artifactId: "a1", parts: [{ text: "verdict text" }] },
}

describe("A2AInlineThread fold logic", () => {
  test("toggle flips expanded and notifies the timeline to remeasure", () => {
    const calls: number[] = []
    createRoot((dispose) => {
      const fold = createInlineThreadFold({ onSizeChange: () => calls.push(calls.length) })
      expect(fold.expanded()).toBe(true)
      fold.toggle()
      expect(fold.expanded()).toBe(false)
      expect(calls).toHaveLength(1)
      fold.toggle()
      expect(fold.expanded()).toBe(true)
      expect(calls).toHaveLength(2)
      dispose()
    })
  })

  test("signature tracks both body-height dimensions", () => {
    expect(inlineThreadSignature(fixture)).toBe("2:3")
    expect(inlineThreadSignature({ ...fixture, turns: fixture.turns.slice(0, 1) })).toBe("1:3")
    expect(inlineThreadSignature({ ...fixture, states: [] })).toBe("2:0")
  })
})

describe("a2aTaskRunning", () => {
  test("only in-flight states keep the registry poll alive", () => {
    expect(a2aTaskRunning("TASK_STATE_SUBMITTED")).toBe(true)
    expect(a2aTaskRunning("TASK_STATE_WORKING")).toBe(true)
    expect(a2aTaskRunning("TASK_STATE_INPUT_REQUIRED")).toBe(false)
    expect(a2aTaskRunning("TASK_STATE_COMPLETED")).toBe(false)
    expect(a2aTaskRunning("TASK_STATE_FAILED")).toBe(false)
    expect(a2aTaskRunning(undefined)).toBe(false)
  })
})

// The app unit suite runs Solid's SSR build under `--conditions=solid` and Bun's
// test loader compiles `.tsx` with the classic React transform, so DOM rendering
// needs a Solid transform/runtime that the unit runner does not provide. Detect
// it and skip rather than fail; a `bun test --conditions=browser` style setup
// with a Solid JSX transform runs the full assertions.
function domRuntime(): boolean {
  if (typeof document === "undefined") return false
  const host = document.createElement("div")
  try {
    const dispose = render(() => null, host)
    dispose()
    return true
  } catch {
    return false
  }
}

const platform: Platform = {
  platform: "web",
  openExternal: () => {},
  restart: async () => {},
  notify: async () => {},
}

function mount(thread: A2AThreadData, onSizeChange: () => void) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: platform,
        get children() {
          return createComponent(LanguageProvider, {
            get children() {
              return createComponent(A2AInlineThread, {
                taskId: thread.taskId,
                get thread() {
                  return thread
                },
                onSizeChange,
              })
            },
          })
        },
      }),
    host,
  )
  return {
    host,
    dispose: () => {
      dispose()
      host.remove()
    },
  }
}

const suite = domRuntime() ? describe : describe.skip

suite("A2AInlineThread DOM", () => {
  test("renders the header and the captured conversation", () => {
    const mounted = mount(fixture, () => {})
    const text = mounted.host.textContent ?? ""
    expect(text).toContain("A2A conversation")
    expect(text).toContain("agent-b")
    expect(text).toContain("2 turns")
    expect(text).toContain("TASK_STATE_COMPLETED")
    expect(text).toContain("hello peer")
    expect(text).toContain("hi back")
    expect(text).toContain("all done")
    expect(text).toContain("verdict text")
    mounted.dispose()
  })

  test("toggles between expanded and collapsed and remeasures", () => {
    const calls: number[] = []
    const mounted = mount(fixture, () => calls.push(calls.length))
    const toggle = mounted.host.querySelector("button")
    expect(toggle?.getAttribute("aria-expanded")).toBe("true")

    toggle?.click()
    expect(mounted.host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false")
    expect(mounted.host.textContent).not.toContain("hello peer")
    expect(mounted.host.textContent).toContain("2 turns")
    expect(calls).toHaveLength(1)

    mounted.host.querySelector("button")?.click()
    expect(mounted.host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true")
    expect(mounted.host.textContent).toContain("hello peer")
    expect(calls).toHaveLength(2)

    mounted.dispose()
  })
})
