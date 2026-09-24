import { describe, expect, test } from "bun:test"
import { CAP_MESSAGE } from "../src/config.ts"
import { agentReplies, awaitState, fakeRunner, send, startBridge, userMessage } from "./bridge.ts"

describe("inbound bridge", () => {
  test("first turn replies with the session output and asks for input", async () => {
    const fake = fakeRunner({ replies: ["4"] })
    const bridge = startBridge(fake.runner)
    try {
      const task = await send(bridge.client, userMessage("What is 2+2?"))
      const settled = await awaitState(bridge.client, task.id, "TASK_STATE_INPUT_REQUIRED")
      expect(agentReplies(settled)).toEqual(["4"])
      expect(fake.runs).toEqual([{ taskId: task.id, text: "What is 2+2?" }])
    } finally {
      bridge.stop()
    }
  })

  test("second turn reuses the session and completes at the cap", async () => {
    const fake = fakeRunner({ replies: ["4", "because 2+2 is 4"] })
    const bridge = startBridge(fake.runner)
    try {
      const first = await send(bridge.client, userMessage("What is 2+2?"))
      await awaitState(bridge.client, first.id, "TASK_STATE_INPUT_REQUIRED")

      await send(bridge.client, userMessage("Why?", { taskId: first.id }))
      const done = await awaitState(bridge.client, first.id, "TASK_STATE_COMPLETED")
      expect(done.status.message?.parts[0]?.text).toBe(CAP_MESSAGE)
      expect(agentReplies(done)).toEqual(["4", "because 2+2 is 4"])
      expect(fake.runs.map((run) => run.taskId)).toEqual([first.id, first.id])
      expect(fake.runs.map((run) => run.text)).toEqual(["What is 2+2?", "Why?"])
    } finally {
      bridge.stop()
    }
  })

  test("a third message is rejected once the cap completes the task", async () => {
    const fake = fakeRunner({ replies: ["4", "reason"] })
    const bridge = startBridge(fake.runner)
    try {
      const task = await send(bridge.client, userMessage("one"))
      await awaitState(bridge.client, task.id, "TASK_STATE_INPUT_REQUIRED")
      await send(bridge.client, userMessage("two", { taskId: task.id }))
      await awaitState(bridge.client, task.id, "TASK_STATE_COMPLETED")

      await expect(send(bridge.client, userMessage("three", { taskId: task.id }))).rejects.toThrow(
        "cannot accept messages",
      )
      expect(fake.runs.length).toBe(2)
    } finally {
      bridge.stop()
    }
  })

  test("a duplicate messageId skips the run and leaves the settled turn", async () => {
    const fake = fakeRunner({ replies: ["4"] })
    const bridge = startBridge(fake.runner)
    try {
      const message = userMessage("What is 2+2?")
      const task = await send(bridge.client, message)
      await awaitState(bridge.client, task.id, "TASK_STATE_INPUT_REQUIRED")

      await send(bridge.client, { ...message, taskId: task.id })
      await Bun.sleep(50)

      expect(fake.runs.length).toBe(1)
      const after = await bridge.client.getTask(task.id)
      expect(after.status.state).toBe("TASK_STATE_INPUT_REQUIRED")
      expect(agentReplies(after)).toEqual(["4"])
    } finally {
      bridge.stop()
    }
  })

  test("a failing session run fails the task with a short reason", async () => {
    const fake = fakeRunner({ error: "provider exploded" })
    const bridge = startBridge(fake.runner)
    try {
      const task = await send(bridge.client, userMessage("hello"))
      const failed = await awaitState(bridge.client, task.id, "TASK_STATE_FAILED")
      expect(failed.status.message?.parts[0]?.text).toContain("provider exploded")
      expect(agentReplies(failed)).toEqual([])
    } finally {
      bridge.stop()
    }
  })

  test("an empty message fails without running the session", async () => {
    const fake = fakeRunner()
    const bridge = startBridge(fake.runner)
    try {
      const task = await send(bridge.client, userMessage("   "))
      const failed = await awaitState(bridge.client, task.id, "TASK_STATE_FAILED")
      expect(failed.status.message?.parts[0]?.text).toBe("message contained no text")
      expect(fake.runs.length).toBe(0)
    } finally {
      bridge.stop()
    }
  })

  test("cancel aborts the session and discards the late reply", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = fakeRunner({ replies: ["too late"], gate })
    const bridge = startBridge(fake.runner)
    try {
      const task = await send(bridge.client, userMessage("never finishes"))
      await awaitState(bridge.client, task.id, "TASK_STATE_WORKING")

      const canceled = await bridge.client.cancelTask(task.id)
      expect(canceled.status.state).toBe("TASK_STATE_CANCELED")
      expect(fake.aborted).toEqual([task.id])

      release()
      await Bun.sleep(20)
      const after = await bridge.client.getTask(task.id)
      expect(after.status.state).toBe("TASK_STATE_CANCELED")
      expect(agentReplies(after)).toEqual([])
    } finally {
      bridge.stop()
    }
  })

  test("messages arriving mid-run queue behind the current run", async () => {
    const fake = fakeRunner({ delayMs: 40, replies: ["first", "second"] })
    const bridge = startBridge(fake.runner)
    try {
      const first = await send(bridge.client, userMessage("one"))
      await send(bridge.client, userMessage("two", { taskId: first.id }))

      const done = await awaitState(bridge.client, first.id, "TASK_STATE_COMPLETED")
      expect(fake.runs.map((run) => run.text)).toEqual(["one", "two"])
      expect(fake.overlapped()).toBe(false)
      expect(agentReplies(done)).toEqual(["first", "second"])
      expect(done.status.message?.parts[0]?.text).toBe(CAP_MESSAGE)
    } finally {
      bridge.stop()
    }
  })

  test("the agent card carries the bound port", async () => {
    const fake = fakeRunner()
    const bridge = startBridge(fake.runner)
    try {
      expect(bridge.port).toBeGreaterThan(0)
      const card = await bridge.client.fetchAgentCard()
      expect(card.supportedInterfaces[0].url).toBe(`http://localhost:${bridge.port}/`)
      expect(card.capabilities.streaming).toBe(true)
    } finally {
      bridge.stop()
    }
  })

  test("stopping the listener closes the port", async () => {
    const fake = fakeRunner()
    const bridge = startBridge(fake.runner)
    const cardUrl = `${bridge.baseUrl}/.well-known/agent-card.json`
    expect((await fetch(cardUrl)).status).toBe(200)

    bridge.stop()
    await Bun.sleep(10)
    await expect(fetch(cardUrl)).rejects.toThrow()
  })
})
