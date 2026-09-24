# plugin-a2a

opencode's A2A bridge (tickets A2A-004 and A2A-005): an opt-in plugin that gives the model a
multi-turn `a2a_ask` tool for talking to other A2A agents, and serves inbound A2A tasks through
local opencode sessions. Permission parity, turn events, and the thread UI live in separate
tickets (A2A-007, A2A-008, A2A-009).

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

| Field          | Default | Meaning                                                                                         |
| -------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `enabled`      | `false` | Turn the plugin on. Also on when `OPENCODE_A2A_ENABLED` is `1` or `true`.                       |
| `listenPort`   | `0`     | Inbound A2A server port. `0` binds an ephemeral port, reported to peers through the agent card. |
| `allowedPeers` | `{}`    | Map of peer id to base URL. `a2a_ask` refuses peers that are not listed.                        |
| `maxTurns`     | `4`     | Total conversation turns (all messages, both speakers) before the cap is reached.               |
| `agent`        | unset   | Agent for inbound prompts; unset uses the opencode default.                                     |
| `model`        | unset   | Model for inbound prompts as `provider/model`; unset uses the agent's default model.            |

## `a2a_ask`

```
a2a_ask({ peer: string, message: string, taskId?: string })
```

- Omit `taskId` to start a new task; pass the `Task:` value from the previous result to follow up
  in the same task.
- Each result reports the peer, task id, turn count, and reply text. The cap result is
  `max turns reached without verdict` (a bounded outcome, not an error).
- If the peer's Agent Card advertises streaming, the tool consumes `message/stream`; otherwise it
  sends with `message/send` and polls `tasks/get` until a reply or a terminal state.
- Duplicate message ids never append twice, late replies after a terminal state are ignored,
  failures and timeouts surface as errors instead of hanging.

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

## Develop

```sh
bun test
bun typecheck
```
