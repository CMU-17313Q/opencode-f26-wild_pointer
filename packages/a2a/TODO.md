### A2A-001: Scaffold packages/a2a and freeze types

## What to do

- [x] Create the package.
- [x] Define and export the minimal A2A types: `Task`, `TaskState`, `Message`, `Part` (text only), `AgentCard`, plus conversation types `Turn` and `Speaker` (local / remote) to track who said what and in which order.
- [x] Use `zod` for validation.
- [x] Write a one-page `INTERFACES.md` that lists the exact JSON-RPC method names (`message/send`, `message/stream`, `tasks/get`, `tasks/list`, `tasks/cancel`) and the request and response shapes.
- [x] Do not import anything from opencode in this package.

## Acceptance

- [x] `bun run build` passes.
- [x] A valid Task and Turn JSON pass schema validation.
- [x] `INTERFACES.md` is published and reviewed.

## Merge

- [ ] `feat/a2a` on Day 1.
