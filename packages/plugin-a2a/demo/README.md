# A2A-010 cross-computer demo / A2A-011 bidirectional smoke test

Two scripts that prove an opencode instance speaks real A2A on the wire:

- `debate.ts` — Bun + `A2AClient`. Plays Agent A in a four-turn debate
  (A opens, B replies, A challenges, B finalizes) against an opencode peer,
  then reads the verdict `Artifact` back via `tasks/get`.
- `peer-check.py` — Python 3 stdlib only. A non-opencode client that starts a
  task, replies on the same `taskId`, and reads both answers. No `a2a-sdk`,
  no dependencies — plain JSON-RPC over HTTP.
- `smoke-bidirectional.ts` — A2A-011. Both directions complete a 2-turn
  exchange with turn events present, one `taskId` per direction. Direction A
  (opencode → peer) goes through the real `a2a_ask` tool with a recording
  emitter; direction B (peer → opencode) speaks raw A2A to a live inbound
  bridge while turn events are captured off the serve SSE stream
  (`/global/event`), the same fan-out the app UI reads. Fails loudly on any
  missing reply, taskId reuse break, or absent turn events.

## Setup (Agent B machine — the opencode peer)

1. Build the workspace and register the plugin (`packages/plugin-a2a`) in
   `opencode.json`:

   ```json
   {
     "plugin": ["file:///abs/path/to/packages/plugin-a2a"]
   }
   ```

   or, if running from this repo, point `plugin` at a published/built spec per
   your team's convention.

2. Enable the inbound bridge in plugin options:

   ```json
   {
     "a2a": {
       "enabled": true,
       "listenPort": 4000,
       "name": "agent-b",
       "allowedPeers": { "agent-a": "http://agent-a-host:4000" },
       "maxTurns": 4
     }
   }
   ```

   `listenPort: 0` picks an ephemeral port; fix one for cross-machine use.
   The listener binds on all interfaces — open the port in the firewall.

3. Start opencode in a directory that has the plugin configured. The bridge
   logs `a2a listen url=http://0.0.0.0:4000` once it is up. Agent B needs a
   working model credential, since its session runner does the replying.

## Run the debate (Agent A machine)

```sh
cd packages/plugin-a2a
bun run demo/debate.ts --peer http://<agent-b-host>:4000 --name agent-a
```

Expected output:

```
peer card: agent-b @ http://<host>:4000

[turn 1] agent-a → Resolved: spaces are objectively better than tabs ...
task <id> created (TASK_STATE_SUBMITTED)

[turn 2] agent-b → <B's reply>

[turn 3] agent-a → Weak argument. EditorConfig and gofmt ...
[turn 4] agent-b → <B's final answer>

final state: TASK_STATE_COMPLETED
verdict artifact (<id>-verdict):
Verdict: <B's verdict text>
```

The same `taskId` carries all four turns. The script fails loudly if the task
never completes or if `tasks/get` returns no verdict artifact.

## Run the Python peer check

```sh
python3 demo/peer-check.py http://<agent-b-host>:4000
```

Expected:

```
peer card: agent-b @ http://<host>:4000
task <id> created (TASK_STATE_SUBMITTED)
turn 1 reply: ...
turn 2 reply: ...
final state: TASK_STATE_INPUT_REQUIRED
peer check passed: same taskId carried both turns and both replies came back.
```

Two turns only, so the task lands in `INPUT_REQUIRED` awaiting a third turn;
`maxTurns: 2` on the B side makes it `COMPLETED` instead. Either is a pass —
what matters is both replies arrive on the same task over raw JSON-RPC.

## Run the A2A-011 bidirectional smoke test

Needs your own serve + A2A listener up (steps 1–3 above), since direction B
targets your live inbound and reads your serve event stream:

```sh
cd packages/plugin-a2a
bun run demo/smoke-bidirectional.ts \
  --peer http://<peer-host>:4000 --peer-id agent-a \
  --inbound http://localhost:4000 --serve http://localhost:4096 \
  --name agent-b
```

Loopback (one machine, real model): point `--peer` at your own A2A port, as
above. Cross-machine: `--peer` is the friend's URL while `--inbound`/`--serve`
stay yours; the friend mirrors with the flags flipped. Expected tail:

```
SMOKE PASS: both directions completed 2 turns (tasks <id-a>, <id-b>) with turn events
```

Direction A asserts both replies arrive under one `taskId` through `a2a_ask`
plus `local@0, remote@1, local@2, remote@3` turn events and `task.dispatched`.
Direction B asserts the same over the wire plus `remote@0, local@1, remote@2,
local@3` turn events observed on the serve SSE stream. Paste this transcript
into the merge PR as the A2A-011 evidence.

## Notes

- `allowedPeers` is required for _outbound_ `a2a_ask` calls on that side; the
  inbound bridge accepts any caller that knows the URL, recording its
  `x-a2a-peer` header (or socket address) as the task's peer identity.
- If Agent A is also opencode, use `a2a_ask` in a session instead of
  `debate.ts` — same wire calls, events included.
- While a turn is running, the app's A2A thread view shows `Cancel thread`.
  Clicking it interrupts the local session, sends `tasks/cancel` to the peer,
  and both sides settle the task as `TASK_STATE_CANCELED` (the peer's
  `INPUT_REQUIRED`/`WORKING` task included). The button is disabled once the
  task reaches a terminal state or while the viewed session is idle.
- Ports must be reachable across both machines; `debate.ts` and
  `peer-check.py` can run on the same host as opencode with `--peer
http://localhost:4000` for a smoke test.
