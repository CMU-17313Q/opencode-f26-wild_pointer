### A2A-006: [Bridge] Conversation tracker + turn cap

## What to do

- [x] Build a generic conversation tracker: turn number, speaker order, idempotency by `messageId`, timing (`timeoutMs`)
- [x] Keep turn policy with the caller: `maxTurns` + cap message via `conversationOutcome(tracker, policy)`
- [x] Capped outcome is `TASK_STATE_COMPLETED` with the caller's cap message
- [x] Reserve `TASK_STATE_FAILED` for real errors (network, permission, timeout)

## Acceptance

- [x] A 6-turn attempt stops at 4 and returns `TASK_STATE_COMPLETED` with `status.message` = "max turns reached without verdict"
- [x] A duplicate reply with the same `messageId` does not append a second copy
- [x] A task stuck past a timeout is marked as `TASK_STATE_FAILED`

## Merge

- [ ] `feat/a2a` on Day 5.
