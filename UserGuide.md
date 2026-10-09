# A2A Agent Conversations — User Guide

> **Collaborative draft:** Each owner should complete their named section and replace its
> `[Fill in: ...]` prompts with verified product behavior. Do not document planned behavior
> as available until it is implemented and tested.

## What this feature does

OpenCode agents can exchange messages with another agent in a multi-turn task. A conversation
keeps the same task ID across turns, can be initiated by either side, and is shown as an ordered
thread in the session view. The feature is opt-in and is off by default.

Use this guide to configure A2A, start or respond to a conversation, review its turns, and stop
it when needed.

### Planned in-scope behavior

- Start a task with a peer and continue the exchange in the same task.
- Receive a peer's request and reply in that same task.
- View local and remote messages, their turn numbers, peer identity, and task ID.
- Apply the usual allow / ask / deny permission checks to every inbound turn.
- Stop a conversation. The configured turn limit is four; reaching it completes the task with
  the status message `max turns reached without verdict`.
- Store a completed debate's verdict as an Artifact that can be read with `tasks/get`.

### Not covered

This release does not include a debate scoring or judging engine, multi-agent tournaments,
history search, or rich verdict blocks.

## Before you begin

- OpenCode version: [Fill in: supported version or build]
- Network requirements: [Fill in: reachability, firewall, and address requirements]
- Peer requirements: [Fill in: supported A2A peer and any setup needed]
- Access needed: [Fill in: permissions, credentials, or other prerequisites]

## Enable and configure A2A

A2A is disabled unless enabled explicitly. Enable it with `a2a.enabled: true` in
`opencode.json` or set `OPENCODE_A2A_ENABLED=1`.

Configure the listener port, allowed peers, and maximum turns as applicable:

- Listener port: [Fill in: configuration syntax, default, and valid values]
- Allowed peers: [Fill in: configuration syntax and how peer identity is matched]
- Maximum turns: four by default. [Fill in: whether and how users can change this value]

Example configuration: [Fill in: verified, copyable `opencode.json` example]

To disable A2A: [Fill in: steps and whether a restart is required]

## Start a conversation with another agent

The `a2a_ask` tool starts an outgoing conversation. Provide a peer and the question or task,
then continue with follow-up messages in the same task. The peer's replies and your messages
belong to one conversation, identified by its task ID.

1. [Fill in: where/how to invoke `a2a_ask`]
2. [Fill in: how to select or identify the peer]
3. [Fill in: how to provide the initial message]
4. [Fill in: how to read the reply and send a follow-up]

Example:

```text
[Fill in: verified invocation and example conversation]
```

Expected result: [Fill in: what the user sees, including how to find the task ID and thread]

## Respond to an incoming conversation

When a peer starts a task with this OpenCode instance, OpenCode handles each incoming turn
locally and replies in the same task. Every turn is subject to the same permission rules as
local work:

- **Allow:** [Fill in: what happens]
- **Ask:** [Fill in: how the approval prompt appears and how to respond]
- **Deny:** [Fill in: what the peer sees and where the reason is shown]

Peer identity is saved with the session. [Fill in: how users can review that identity and
whether they can restrict peers.]

## Follow the conversation in the session view

The thread displays messages in order, with the speaker, peer identity, turn number, task ID,
and content preview. A completed task can show the verdict stored in its Artifact.

| Task state | Meaning to the user |
| --- | --- |
| `TASK_STATE_SUBMITTED` | [Fill in: user-facing meaning] |
| `TASK_STATE_WORKING` | [Fill in: user-facing meaning] |
| `TASK_STATE_INPUT_REQUIRED` | [Fill in: user-facing meaning] |
| `TASK_STATE_COMPLETED` | The task finished. Reaching the four-turn cap is a completed, bounded outcome, not an error. |
| `TASK_STATE_FAILED` | A real error occurred, such as a network, permission, or timeout failure. [Fill in: where to find details.] |
| `TASK_STATE_CANCELED` | The conversation was stopped. |

Events available to the live thread include task dispatched, updated, completed, and failed
events, plus one `a2a.conversation.turn` event for each sent or received message.

## Stop a conversation

Use the thread's cancel button to stop the conversation. Cancellation requests that the peer
stop, stops the local session, marks the task `TASK_STATE_CANCELED`, and emits the cancel
event.

1. [Fill in: where the cancel button is and how to use it]
2. [Fill in: confirmation or progress shown to the user]
3. [Fill in: how to verify that the task is canceled]

Late replies after a terminal state do not reopen the task. [Fill in: what the user sees if
cancellation fails or a late reply arrives.]

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The A2A tool or listener is unavailable | [Fill in: enablement, configuration, and restart checks] |
| The peer cannot connect | [Fill in: address, network, and allowed-peer checks] |
| A task fails or times out | [Fill in: where to find the error and recommended next step] |
| A turn is denied or waiting for approval | [Fill in: permission settings and approval steps] |
| The conversation ends at the turn limit | This is a normal completed outcome. [Fill in: how to start a new task if needed.] |
| The thread or verdict is missing | [Fill in: event, task state, and Artifact checks] |

## Owner sections

Complete the section assigned to you. Keep the user-facing steps in sync with the actual
implementation and include examples only after verifying them.

### George — Protocol, client, tracker, and smoke test

**Tickets:** A2A-001, A2A-002, A2A-006, A2A-011

- Peer discovery and Agent Card: [Fill in: how to find and interpret a peer's card]
- Starting and continuing a task: [Fill in: client behavior and a verified example]
- Task status and history: [Fill in: how users can inspect a task and its messages]
- Turn limit, duplicate messages, and timeout outcomes: [Fill in: user-visible behavior]
- Smoke-test instructions and expected results: [Fill in: verified steps in both directions]

### Dilshodbek — Server, events, and permissions

**Tickets:** A2A-003, A2A-007, A2A-008

- Hosting an A2A server and sharing its Agent Card: [Fill in: verified setup steps]
- Receiving and replying to a task: [Fill in: user-facing flow]
- Permission prompts and denied actions: [Fill in: exact user experience]
- Thread events and their visible effects: [Fill in: details useful to users or integrators]
- Finding the peer identity associated with a session: [Fill in: where it appears]

### Joey — Bridge, inbound handling, and cancellation

**Tickets:** A2A-004, A2A-005, A2A-012

- Enabling the plugin and using `a2a_ask`: [Fill in: verified steps and example]
- Handling an inbound message in a session: [Fill in: how a reply is composed and sent]
- Canceling local and remote work: [Fill in: exact behavior and any limitations]
- Empty messages, late replies, and other hardened cases: [Fill in: user-visible behavior]

### Tram — Thread view and demo

**Tickets:** A2A-009, A2A-010

- Reading the conversation thread: [Fill in: where it appears and what each item shows]
- Finding the final verdict: [Fill in: how the Artifact is displayed and inspected]
- Four-turn, cross-computer demo: [Fill in: setup, run steps, and expected result]
- Non-OpenCode peer example: [Fill in: setup, run steps, and expected result]

## Reference

- A2A methods in scope: `message/send`, `message/stream`, `tasks/get`, `tasks/list`, and
  `tasks/cancel`.
- Agent Card location: `/.well-known/agent-card.json`.
- Task and turn terminology: [Fill in: link to the project's interface or API reference]

## Review checklist

- [ ] All `[Fill in: ...]` prompts are completed or removed.
- [ ] Setup instructions and examples were tested against the current implementation.
- [ ] Permission, cancellation, failure, and turn-limit behavior matches the product.
- [ ] Each owner has reviewed their section.
- [ ] Screenshots or links are current and do not expose secrets or private peer details.