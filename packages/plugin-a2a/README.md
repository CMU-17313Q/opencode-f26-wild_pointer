# plugin-a2a

opencode's A2A bridge (tickets A2A-004, A2A-005, and A2A-012): an opt-in plugin that gives the model
a multi-turn `a2a_ask` tool for talking to other A2A agents, and serves inbound A2A tasks through
local opencode sessions. Permission parity, turn events, and the thread UI live in separate tickets
(A2A-007, A2A-008, A2A-009).

## Enable

Register the plugin with the options tuple in `opencode.json` (path specs are resolved relative to
the config file):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "./packages/plugin-a2a",
      {
        "a2a": {
          "enabled": true,
          "name": "agent-a",
          "allowedPeers": { "agent-b": "http://peer-b:4321" },
          "maxTurns": 4,
        },
      },
    ],
  ],
}
```

or set `OPENCODE_A2A_ENABLED=1`.

> A top-level `"a2a": { ... }` key in `opencode.json` is **not** supported: opencode rejects
> unknown top-level config keys. Keep the settings inside the plugin options above. The plugin's
> `config` hook already reads an `a2a` section, so nothing changes here if opencode adds one later.

With the flag off, the plugin adds no tools and opens no ports.

## Config

| Field           | Default  | Meaning                                                                                          |
| --------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `enabled`       | `false`  | Turn the plugin on. Also on when `OPENCODE_A2A_ENABLED` is `1` or `true`.                        |
| `listenPort`    | `0`      | Inbound A2A server port. `0` binds an ephemeral port, reported to peers through the agent card.  |
| `allowedPeers`  | `{}`     | Map of peer id to base URL. `a2a_ask` refuses peers that are not listed.                         |
| `maxTurns`      | `4`      | Total conversation turns (all messages, both speakers) before the cap is reached.                |
| `name`          | unset    | Self-identity sent to peers as the `x-a2a-peer` header, and shown as the agent-card name (`opencode` when unset). |
| `agent`         | unset    | Agent for inbound prompts; unset uses the opencode default.                                      |
| `model`         | unset    | Model for inbound prompts as `provider/model`; unset uses the agent's default model.             |
| `turnTimeoutMs` | `120000` | Inbound turn deadline. A run past this is aborted and the task fails, so it never stays WORKING. |

## `a2a_ask`

```
a2a_ask({ peer: string, message: string, taskId?: string })
```

- Omit `taskId` to start a new task; pass the `Task:` value from the previous result to follow up
  in the same task.
- Each result reports the peer, task id, the run's starting turn (`firstTurn`, the index its first
  message occupies in the task) and final turn count, and the reply text. The cap result is
  `max turns reached without verdict` (a bounded outcome, not an error).
- If the peer's Agent Card advertises streaming, the tool consumes `message/stream`; otherwise it
  sends with `message/send` and polls `tasks/get` until a reply or a terminal state.
- Duplicate message ids never append twice, late replies after a terminal state are ignored,
  failures and timeouts surface as errors instead of hanging.
- Interrupting the tool's turn (the session stop/cancel control) cancels the conversation: the
  plugin sends `tasks/cancel` to the peer, emits `a2a.task.updated` with `TASK_STATE_CANCELED`, and
  the turn ends as aborted. Follow-ups on a finished task are answered locally without a request.

## Inbound (A2A-005)

When enabled, the plugin also serves inbound A2A tasks on `listenPort`:

- One opencode session per A2A `taskId`, created on the first message (titled `A2A <taskId>`) and
  reused for the rest of the task, so the agent keeps the conversation's context.
- Each peer message runs through the normal session prompt path — the same agents, tools, and
  safety rules as a local prompt, with the optional `agent`/`model` config pinning the target.
- The assistant's text comes back as a `ROLE_AGENT` message in the same task. Turns are
  `INPUT_REQUIRED` between messages and `COMPLETED` with `max turns reached without verdict` at
  `maxTurns`; runner failures and messages without text surface as `TASK_STATE_FAILED` with a
  short reason.
- Duplicate `messageId`s never re-run the session, `tasks/cancel` aborts the running session, and
  messages arriving mid-run queue behind the current turn. Inbound access is open (no auth) for
  this sprint.
- A session interrupted from the UI settles the task `TASK_STATE_CANCELED` (never `FAILED`), and a
  turn that outlives `turnTimeoutMs` is aborted and fails with `turn timed out after <ms>ms`.
  Late messages for a terminal task are rejected, so a cancel or completion cannot be reopened.

## Local control API

When enabled, the plugin hosts a **loopback-only** admin server (`127.0.0.1`, ephemeral port) so the
Desktop and TUI can drive A2A without any core changes. It is never served on the A2A peer port.
The bound port is written to `<project>/.opencode/a2a/admin.port`; the file is removed when the
plugin is disabled or disposed. All responses are JSON and carry permissive CORS headers.

| Method   | Path                                  | Purpose                                                        |
| -------- | ------------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/a2a/self`                           | This instance's inbound socket (name + URL for peers).         |
| `GET`    | `/a2a/sessions`                       | Session registry, most recent first.                           |
| `GET`    | `/a2a/sessions/:taskId`               | One registry record.                                           |
| `POST`   | `/a2a/conversations`                  | `{ peer, message, origin? }` → start a turn and await it.      |
| `POST`   | `/a2a/conversations/:taskId/messages` | `{ message }` → continue the same task.                        |
| `POST`   | `/a2a/conversations/:taskId/cancel`   | Cancel a task (remote + local cancel paths).                   |
| `GET`    | `/a2a/peers`                          | Effective `allowedPeers` (name + URL).                         |
| `POST`   | `/a2a/peers`                          | `{ name, url }` → validate, JSONC-write, live re-apply.        |
| `DELETE` | `/a2a/peers/:name`                    | Remove a peer and live re-apply.                               |
| `POST`   | `/a2a/peers/:name/test`               | Fetch the peer's agent card; returns its name/description.     |

`origin` is `tui` or `app` and defaults to `app`. Bad input and bad URLs return `400`, unknown
tasks/peers return `404`, and peer/network failures return `502`.

State lives under `<project>/.opencode/a2a/` (never committed):

- `sessions.json` — the last 50 tasks by `updatedAt` (each with its capped turn history, state
  chain, and latest artifact), written atomically (temp file + rename). A task a dead process
  left running settles to `TASK_STATE_FAILED` with `host restarted` on next load.
- `admin.port` — the bound loopback port, while the plugin is enabled.

## Develop

```sh
bun test
bun typecheck
```
