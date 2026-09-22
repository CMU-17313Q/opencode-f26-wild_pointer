### A2A-001: Scaffold packages/a2a and freeze types

- [x] Create the package. 
- [x] Define and export the minimal A2A types: Task, TaskState, Message, Part (text only), AgentCard.
- [ ] Define and export the minimal conversation types Turn and Speaker (local / remote) to track who said what and in which order. 
- [ ] Use zod for validation. 
- [ ] Write a one-page INTERFACES.md that lists the exact JSON-RPC method names (message/send, message/reply, tasks/get, tasks/cancel) and the request and response shapes. 
- [ ] Do not import anything from opencode in this package.

Acceptance
- [ ] bun run build passes. 
- [ ] A valid Task and Turn JSON pass schema validation. 
- [ ] INTERFACES.md is published and reviewed.

Merge
- [ ] feat/a2a on Day 1.