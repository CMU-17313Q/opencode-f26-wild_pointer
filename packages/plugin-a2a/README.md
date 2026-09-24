# plugin-a2a

Outbound half of opencode's A2A bridge (ticket A2A-004): an opt-in plugin that gives the model a
multi-turn `a2a_ask` tool for talking to another A2A agent.

This package only handles outgoing conversations. The inbound server, permission parity, turn
events, and the thread UI live in separate tickets (A2A-003, A2A-005, A2A-007, A2A-008, A2A-009).

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

| Field          | Default | Meaning                                                                           |
| -------------- | ------- | --------------------------------------------------------------------------------- |
| `enabled`      | `false` | Turn the tool on. Also on when `OPENCODE_A2A_ENABLED` is `1` or `true`.           |
| `listenPort`   | `0`     | Reserved for the inbound server (A2A-005); unused by this ticket.                 |
| `allowedPeers` | `{}`    | Map of peer id to base URL. `a2a_ask` refuses peers that are not listed.          |
| `maxTurns`     | `4`     | Total conversation turns (all messages, both speakers) before the cap is reached. |

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

## Develop

```sh
bun test
bun typecheck
```
