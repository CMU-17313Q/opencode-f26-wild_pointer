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
| `name`         | unset   | The nickname this instance claims in `x-a2a-peer` and its agent card. Unset peers see your socket address instead. |
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

## TUI panel (A2A-016)

The package ships a `./tui` target (`{ id: "a2a", tui }`) — register the plugin and the TUI picks up
three palette commands plus a default `ctrl+alt+a` binding for the session list:

- **A2A: Sessions** — current and past tasks (peer, direction, state, turns, age; running on top).
  Enter opens the live thread: turns in order with speaker labels, the state chip, the verdict
  artifact when present, and the turn-cap message rendered as the bounded ending rather than an
  error. Inside a thread: `m`/`enter` reply, `x` cancel a running task, `b`/`backspace` back,
  arrows/`pageup`/`pagedown` scroll, `r` refresh, `esc` close.
- **A2A: New conversation** — peer picker (configured `allowedPeers` plus names seen in sessions)
  then a message prompt. Follow-ups reuse the same `taskId`.
- **A2A: Peers** — the `allowedPeers` map plus your own identity and listener status. Enter on a
  peer offers Test (fetches the agent card — the peer's claimed name, which may differ from the
  local key) and Remove; "Add peer" asks for a name and URL.

The panel only talks to the local A2A-014 control API — no direct plugin imports. Live updates ride
the existing `a2a.task.*` / `a2a.conversation.turn` bus events; a 2.5s poll keeps views fresh when
the events are unavailable (e.g. the control stub).

## Control API discovery

The panel resolves the loopback control endpoint in order:

1. `OPENCODE_A2A_ADMIN_URL` — explicit override (dev, tests, the stub below).
2. The opencode server's own `/a2a/*` routes — the preferred A2A-014 transport.
3. `.opencode/a2a/admin.port` under the worktree/project dir — the plugin-hosted fallback.

Each candidate is probed (`GET /a2a/sessions`) before use, so stale port files and older server
builds fall through cleanly.

## Control stub (`demo/control-stub.ts`)

Until A2A-014 lands, the demo stub serves the same `/a2a/*` contract on loopback in front of a real
loopback A2A peer (the production inbound bridge + a scripted echo runner — no model needed):

```sh
bun demo/control-stub.ts            # writes .opencode/a2a/admin.port in the cwd
OPENCODE_A2A_ADMIN_URL=http://127.0.0.1:<port>  # or set it explicitly
```

It exposes a `loop` peer pointing at its own inbound server, so "New conversation → loop → message"
produces a real 4-turn exchange ending in `TASK_STATE_COMPLETED` with a verdict artifact. Peer
add/remove is in-memory only — the real control plane writes `allowedPeers` back to `opencode.json`.

## Develop

```sh
bun test
bun typecheck
```
