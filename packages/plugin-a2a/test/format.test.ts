import { describe, expect, test } from "bun:test"
import { array, assert, property, stringMatching, uniqueArray } from "fast-check"
import {
  artifactText,
  canCancel,
  canContinue,
  directionMark,
  formatAge,
  isActive,
  isCapMessage,
  isTerminal,
  mergePeers,
  sessionPeer,
  shortId,
  sortSessions,
  stateLabel,
  stateTone,
  toMs,
  turnText,
} from "../src/format.ts"
import { CAP_MESSAGE } from "../src/config.ts"
import type { ControlSession, ControlTurn } from "../src/control.ts"

const session = (overrides: Partial<ControlSession> = {}): ControlSession => ({
  taskId: "task-1",
  state: "TASK_STATE_SUBMITTED",
  ...overrides,
})

describe("state classification", () => {
  test("active states are non-terminal and cancelable", () => {
    for (const state of ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_INPUT_REQUIRED"] as const) {
      expect(isActive(state)).toBe(true)
      expect(isTerminal(state)).toBe(false)
      expect(canCancel(state)).toBe(true)
    }
  })

  test("terminal states are settled and not cancelable", () => {
    for (const state of [
      "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED",
      "TASK_STATE_CANCELED",
      "TASK_STATE_REJECTED",
    ] as const) {
      expect(isActive(state)).toBe(false)
      expect(isTerminal(state)).toBe(true)
      expect(canCancel(state)).toBe(false)
    }
  })

  test("only INPUT_REQUIRED can be continued", () => {
    expect(canContinue("TASK_STATE_INPUT_REQUIRED")).toBe(true)
    expect(canContinue("TASK_STATE_WORKING")).toBe(false)
    expect(canContinue("TASK_STATE_COMPLETED")).toBe(false)
  })

  test("labels and tones cover every state", () => {
    expect(stateLabel("TASK_STATE_COMPLETED")).toBe("completed")
    expect(stateLabel("TASK_STATE_INPUT_REQUIRED")).toBe("your turn")
    expect(stateLabel("TASK_STATE_INPUT_REQUIRED", "outbound")).toBe("your turn")
    expect(stateLabel("TASK_STATE_INPUT_REQUIRED", "inbound")).toBe("awaiting input")
    expect(stateLabel("TASK_STATE_UNSPECIFIED")).toBe("unknown")
    expect(stateTone("TASK_STATE_COMPLETED")).toBe("success")
    expect(stateTone("TASK_STATE_FAILED")).toBe("error")
    expect(stateTone("TASK_STATE_CANCELED")).toBe("muted")
    expect(stateTone("TASK_STATE_INPUT_REQUIRED")).toBe("warning")
    expect(stateTone("TASK_STATE_WORKING")).toBe("info")
  })
})

describe("timestamps", () => {
  test("toMs accepts numbers and ISO strings", () => {
    expect(toMs(1700000000000)).toBe(1700000000000)
    expect(toMs("2023-11-14T22:13:20Z")).toBe(1700000000000)
    expect(toMs(undefined)).toBeUndefined()
    expect(toMs("not a date")).toBeUndefined()
  })

  test("formatAge buckets seconds, minutes, hours, days", () => {
    const now = Date.parse("2024-01-02T00:00:00Z")
    expect(formatAge(now - 5_000, now)).toBe("5s")
    expect(formatAge(now - 3 * 60_000, now)).toBe("3m")
    expect(formatAge(now - 2 * 3_600_000, now)).toBe("2h")
    expect(formatAge(now - 4 * 86_400_000, now)).toBe("4d")
    expect(formatAge(undefined, now)).toBe("")
    expect(formatAge(now + 60_000, now)).toBe("0s")
  })
})

describe("session rows", () => {
  test("sortSessions puts running tasks first, then most recent", () => {
    const list = sortSessions([
      session({ taskId: "old-done", state: "TASK_STATE_COMPLETED", updatedAt: 1000 }),
      session({ taskId: "new-done", state: "TASK_STATE_FAILED", updatedAt: 9000 }),
      session({ taskId: "running", state: "TASK_STATE_WORKING", updatedAt: 500 }),
    ])
    expect(list.map((item) => item.taskId)).toEqual(["running", "new-done", "old-done"])
  })

  test("directionMark and sessionPeer render the row identity", () => {
    expect(directionMark("outbound")).toBe("→")
    expect(directionMark("inbound")).toBe("←")
    expect(directionMark(undefined)).toBe("·")
    expect(sessionPeer(session({ peerId: "agent-b" }))).toBe("agent-b")
    expect(sessionPeer(session())).toBe("unknown peer")
  })

  test("shortId truncates to 8 chars", () => {
    expect(shortId("abc")).toBe("abc")
    expect(shortId("0123456789abcdef")).toBe("01234567")
  })
})

describe("turns and verdicts", () => {
  test("turnText prefers content, falls back to text", () => {
    const turn: ControlTurn = { speaker: "remote", content: "hi" }
    expect(turnText(turn)).toBe("hi")
    expect(turnText({ speaker: "remote", text: "legacy" })).toBe("legacy")
    expect(turnText({ speaker: "remote" })).toBe("")
  })

  test("isCapMessage matches the shared cap constant", () => {
    expect(isCapMessage(CAP_MESSAGE)).toBe(true)
    expect(isCapMessage("failed hard")).toBe(false)
    expect(isCapMessage(undefined)).toBe(false)
  })

  test("artifactText joins part text", () => {
    expect(
      artifactText({ artifactId: "v", parts: [{ text: "verdict: " }, { text: "yes" }] }),
    ).toBe("verdict: yes")
    expect(artifactText({ artifactId: "v", parts: [{ text: " " }] })).toBeUndefined()
    expect(artifactText(undefined)).toBeUndefined()
  })
})

describe("peer merge", () => {
  test("R8: configured and previously seen peers remain visible without making unknown peers dialable", () => {
    // R8: The local peer picker shows configured and history-only peers without making history-only peers dialable.
    // Kind: model/oracle. Generated session names include duplicates and configured peers to exercise discovery boundaries.
    assert(
      property(
        uniqueArray(stringMatching(/^[a-z][a-z0-9-]{0,8}$/), { maxLength: 10 }),
        array(stringMatching(/^[a-z][a-z0-9-]{0,8}$/), { maxLength: 20 }),
        (configuredNames, seenNames) => {
          const configured = configuredNames.map((name) => ({ name, url: `http://${name}.test` }))
          const sessions = seenNames.map((name, index) => session({ taskId: `task-${index}`, peerId: name }))
          const expectedHistoryOnly = [...new Set(seenNames)]
            .filter((name) => !configuredNames.includes(name))
            .map((name) => ({ name }))

          expect(mergePeers(configured, sessions)).toEqual([...configured, ...expectedHistoryOnly])
        },
      ),
    )
  })

  test("configured peers first, discovered session peers appended", () => {
    const merged = mergePeers(
      [{ name: "agent-b", url: "http://b:4322" }],
      [
        session({ peerId: "agent-b" }),
        session({ peerId: "intruder" }),
        session({ peerId: "intruder" }),
        session(),
      ],
    )
    expect(merged).toEqual([
      { name: "agent-b", url: "http://b:4322" },
      { name: "intruder" },
    ])
  })
})
