# A2A Agent Conversations — User Guide

This guide describes the A2A feature set implemented in this repository's `feat/a2a` branch.
It is intended for local development and testing; it does not describe a released OpenCode
distribution.

**Structure:** 1. What A2A adds · 2. Quickstart · 3. Configuration reference · 4. Features ·
5. Demos · 6. Troubleshooting · 7. Reference · 8. Appendix (test coverage & CI). Feature
sections include use instructions, user-test scenarios, and automated-test pointers.

## 1. What A2A adds to opencode

OpenCode agents can exchange messages with another agent in a multi-turn task. A conversation
keeps the same task ID across turns and can be initiated by either side. Its messages are
available in the session thread, Desktop A2A hub, and TUI panel. The feature is opt-in and is
off by default.

Use this guide to configure A2A, start or respond to a conversation, review its turns, and stop
it when needed.

### In scope

- Start a task with a peer and continue the exchange in the same task.
- Receive a peer's request and reply in that same task.
- View local and remote messages, peer identity, and task ID; the TUI also shows turn numbers.
- Apply the usual allow / ask / deny permission checks to every inbound turn.
- Stop a conversation. The configured turn limit is four; reaching it completes the task with
  the status message `max turns reached without verdict`.
- Store a completed debate's verdict as an Artifact that can be read with `tasks/get`.

### Not covered

This release does not include a debate scoring or judging engine, multi-agent tournaments,
history search, or rich verdict blocks.

### Core concepts

- A **peer** is another A2A-speaking agent. The peer's Agent Card is served at
  `/.well-known/agent-card.json`; it includes the agent name and the JSON-RPC endpoint.
- A **task** is the durable conversation shared by the two agents. Its `taskId` stays the
  same when either side sends a follow-up. `tasks/get` reads the task state, history, and
  artifacts.
- A **turn** is one message from either participant, not a request/response pair. The
  configured `maxTurns` counts both local and remote messages; the default is four and `0`
  means no configured cap. A repeated `messageId` is idempotent and does not append another
  turn.
- The **local** speaker is this OpenCode instance; the **remote** speaker is the peer.
  Peer identity comes from the `x-a2a-peer` header and falls back to the caller's socket
  address when no name is sent.
- `TASK_STATE_SUBMITTED` means a task was created; `TASK_STATE_WORKING` means the receiver is
  processing a turn; `TASK_STATE_INPUT_REQUIRED` means the current reply is ready and the
  conversation can continue; `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, and
  `TASK_STATE_CANCELED` are terminal outcomes. A turn timeout fails the task rather than
  leaving it in `WORKING`.

The protocol types and JSON-RPC shapes are in
[`packages/a2a/INTERFACES.md`](./packages/a2a/INTERFACES.md) and
[`packages/a2a/src/types.ts`](./packages/a2a/src/types.ts).

## 2. Quickstart

Use a checkout that contains the A2A work (this guide targets `feat/a2a`), Bun, and a
configured model provider key. A loopback peer needs no LAN firewall or NAT configuration;
the peer URL must be reachable from the same machine. For a remote peer, follow
[`packages/plugin-a2a/demo/TWO-MACHINE.md`](./packages/plugin-a2a/demo/TWO-MACHINE.md) and
open or tunnel the inbound port.

1. From the repository root, install dependencies with `bun install`. Add a model credential
   using `bun run --conditions=browser ./packages/opencode/src/index.ts auth login`, or set a
   supported provider API-key environment variable.
2. In the workspace where you will run OpenCode, register the plugin and configure a loopback
   peer in `opencode.json`. Use the plugin-options structure from §3, setting:

   ```json
   {
     "a2a": {
       "enabled": true,
       "name": "agent-a",
       "listenPort": 4000,
       "allowedPeers": { "loopback": "http://127.0.0.1:4000" },
       "maxTurns": 4
     }
   }
   ```

   Put this object inside the options object in the plugin tuple; `a2a` is not a top-level
   OpenCode config key. Set the plugin path to the absolute path of
   `packages/plugin-a2a` if the workspace is outside the repository.
3. Start the interactive TUI from that workspace:

   ```sh
   bun run --conditions=browser <absolute-repo-path>/packages/opencode/src/index.ts
   ```

   Confirm the bridge is reachable and its Agent Card responds:

   ```sh
   curl http://127.0.0.1:4000/.well-known/agent-card.json
   ```

   The response is JSON and should identify the configured `agent-a`.
4. In the TUI, run `/a2a-new`, choose `loopback`, and send a short prompt. Alternatively,
   ask the session model: “Use `a2a_ask` to ask `loopback` what 2+2 is, then send one
   follow-up in the same task asking it to double the answer.”

**Expected result:** an A2A task appears with one stable task ID; replies arrive for each
message, and the session thread or **A2A: Sessions** detail shows the conversation. With the
four-turn cap, the task ends with `TASK_STATE_COMPLETED` and the status
`max turns reached without verdict` if it reaches the cap first. See §4.5 for what each UI
surface displays and §6 for common setup failures.

The reusable two-machine setup and model credential requirements are documented in
[`packages/plugin-a2a/demo/TWO-MACHINE.md`](./packages/plugin-a2a/demo/TWO-MACHINE.md).

## 3. Configuration reference

All A2A settings live in the plugin's options inside `opencode.json` — inside the plugin tuple, **not** at the top level (opencode rejects unknown top-level keys):

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
          "listenPort": 4000,
          "allowedPeers": { "agent-b": "http://peer-b:4321" },
          "maxTurns": 4
        }
      }
    ]
  ]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Turns the plugin on. Also on when `OPENCODE_A2A_ENABLED` is `1` or `true`. |
| `name` | unset | Your identity: sent to peers as the `x-a2a-peer` header and shown as the agent-card name (`opencode` when unset). |
| `listenPort` | `0` | Inbound A2A server port. `0` picks a free port and reports it through the agent card; fix a number for cross-machine use. |
| `allowedPeers` | `{}` | Map of peer name → base URL. `a2a_ask` refuses peers that are not listed. |
| `maxTurns` | `4` | Total turns (all messages, both speakers) before the cap. `0` means unbounded. |
| `agent` | unset | Agent for inbound prompts; unset uses the opencode default. |
| `model` | unset | Model for inbound prompts as `provider/model`; unset uses the agent's default model. |
| `turnTimeoutMs` | `120000` | Inbound turn deadline. A run past this is aborted and the task fails, so a task never stays WORKING. |

- **Precedence:** config hook > plugin options > environment > defaults. `enabled` is an OR across all sources.
- **No name configured?** The plugin logs a one-time notice at startup: peers will see your socket address.
- Peers added or removed from Settings → A2A (or the TUI panel) are written back to this config and applied **live** — no restart. Other option changes take effect when opencode reloads the plugin.

**How to user-test.**
1. Disable the plugin (or remove it): no `a2a_ask` tool is registered, nothing listens on any port, and no control-port file appears.
2. Enable it with a name and one peer, restart opencode: the log shows `a2a listen url=http://0.0.0.0:4000` (your port), and Settings → A2A shows the control API as **Running**.

**Automated tests.** `packages/plugin-a2a/test/config.test.ts` (defaults, env, nested vs flat option shapes, precedence, invalid values) and `test/plugin.test.ts` (flag off adds no tools and opens no ports; enabled via env, options, or config hook). The tests parse through the same schema the plugin uses at runtime, so the reference above and the live behavior cannot drift.

## 4. Features

One section per shipped ticket (A2A-004 → A2A-016). Each section covers: what it does · how to
use it · how to user-test it · where its automated tests live and why they're sufficient.

### 4.1 Outbound conversations — the `a2a_ask` tool (A2A-004)

**What it does.** `a2a_ask` lets the model start a conversation with a configured peer and keep it going inside one A2A task: the same `taskId` across turns, the turn count tracked locally, and a soft stop at `maxTurns` (default 4). A capped conversation is a bounded outcome, not an error.

**How to use.**
1. Enable the plugin and put at least one peer in `allowedPeers` (see §3, Configuration reference).
2. In any session, ask the model to use the tool — e.g. "Use `a2a_ask` to ask agent-b whether tabs or spaces won, then follow up with why."
3. Arguments: `peer` (a name from `allowedPeers`), `message`, and optional `taskId` (from a previous result, to continue that conversation).
4. One call = one exchange. The result reads:

   ```
   Peer: agent-b
   Task: <taskId>
   Turn: 2/4
   Reply: <the peer's reply>
   ```

   Turns count every message in both directions, so your first ask gets you to `2/<maxTurns>`. Pass that `Task:` value back as `taskId` to continue; each follow-up adds two more turns. An `Artifact:` line appears when the peer sends one.
5. The cap: once the task holds `maxTurns` turns, further asks return `max turns reached without verdict` without contacting the peer. Start a fresh task (omit `taskId`) to keep talking.

To stop a running conversation early, see §4.6, Canceling a conversation. Guard rails: an unknown peer is refused with the allowed list and zero network requests; empty messages are rejected; duplicate message ids never count twice; a peer that never replies times out (and the remote task is canceled) instead of hanging; a follow-up on an already-finished task is answered locally without touching the peer.

**How to user-test (loopback, one machine).**
1. In `opencode.json` set `enabled: true`, `name: "agent-a"`, `listenPort: 4000`, `allowedPeers: { "agent-a": "http://localhost:4000" }` — the peer is your own listener. Restart opencode; the log shows the listen line.
2. Prompt: "Use `a2a_ask` with peer agent-a to ask: What is 2+2?" Expected: `Reply: 4`, `Turn: 2/4`.
3. Follow up: "Use `a2a_ask` again with taskId `<taskId>` and ask: Why?" Expected: a reason, `Turn: 4/4`.
4. Ask once more. Expected: `max turns reached without verdict` — and no new request leaves the process.

**Automated tests.** `packages/plugin-a2a/test/ask.test.ts` (one task across turns ending at the cap, resume counts prior turns, streaming transport, and the guard rails above), `test/plugin.test.ts` (off = no tools and no ports; opt-in paths), `test/peer-integration.test.ts` (both transports end-to-end over HTTP). The tool tests run against a real in-process A2A peer (`Bun.serve`) — the same protocol code as production, not mocks — covering the exact scenarios listed here.

### 4.2 Inbound conversations — answering a peer (A2A-005)

**What it does.** With the plugin enabled, your opencode instance also *serves* A2A: it publishes an agent card and accepts tasks from peers on `listenPort`, answering every turn from a real opencode session. One session per task, so context carries across turns, and each reply goes back in the same task.

**How to use.** Nothing to invoke — enable the plugin, and fix `listenPort` for cross-machine use. Peers find you at `http://<host>:<port>/.well-known/agent-card.json`. What to expect:
- The first message creates a session titled `A2A <peer> · <opening message snippet>`, which appears in your session list like any other session — you can watch it work.
- Each message runs through the normal session prompt path: same agent, tools, and permission rules as local work. The `agent` / `model` options can pin the responder.
- Between messages the task waits as `TASK_STATE_INPUT_REQUIRED`; at the cap it closes as `TASK_STATE_COMPLETED` with `max turns reached without verdict`. Runner failures and text-less messages surface as `TASK_STATE_FAILED` with a short reason.
- Duplicate messages are skipped, messages arriving mid-turn queue behind it, and a turn that outlives `turnTimeoutMs` is aborted and fails (`turn timed out after <ms>ms`) — a task can never hang in WORKING.
- Inbound access is open (no auth) in this release and the listener binds on all interfaces, so keep it on trusted networks (loopback or your LAN).

**How to user-test.** Drive it from another A2A client — a second opencode, or the dependency-free Python check from §5 (Demos):

```sh
python3 packages/plugin-a2a/demo/peer-check.py http://<your-host>:4000
```

Expected (abridged):

```
peer card: agent-b @ http://<host>:4000
task <id> created (TASK_STATE_SUBMITTED)
turn 1 reply: ...
turn 2 reply: ...
peer check passed: same taskId carried both turns and both replies came back.
```

On your side, the session list shows the `A2A …` session and both turns land in the task history. Manually: send "What is 2+2?" then "Why?" — expect "4" then a reason, both on one `taskId`, using only standard A2A fields.

**Automated tests.** `test/inbound.test.ts` (session creation and reuse, replies, cap, dedupe, mid-run queueing, timeout, listener close), `test/session.test.ts` (one session per task; permission-denied runs fail), `test/peer-integration.test.ts` (two-turn exchanges over `message/send` and `message/stream` against a real HTTP server). The suite drives the actual server over the wire with a scripted runner, and `peer-check.py` re-proves the non-opencode path.

### 4.3 Permission parity (A2A-007)

**What it does.** Every inbound turn runs through the same session prompt path — and therefore
the same allow / ask / deny permission checks — as a prompt you typed yourself. Parity is by
construction: the inbound bridge calls the normal `SessionRunner`, so a peer message can do
nothing your local agent couldn't. The peer's identity (its `x-a2a-peer` name, or its socket
address when it sends none) is recorded on the task and the backing session, so you can always
see *who* triggered a run.

**How to use.** There is nothing to configure — your existing permission rules apply as-is:

- **allow** — the tool call executes inside the task's session and the reply goes back to the
  peer, like any other turn.
- **ask** — the approval prompt appears in your session UI (the task's session is a normal
  opencode session titled `A2A <peer> · …`); the turn waits until you approve or reject.
- **deny** — a rule-denied tool call or a rejected prompt fails the turn: the task settles
  `TASK_STATE_FAILED` with a short reason, and the peer sees that state instead of a reply. You
  see the failed run inside the `A2A …` session with the permission error attached.

**How to user-test.**
1. Enable the plugin with a rule that denies an easy-to-trigger tool (for example, deny `edit`
  in your permission config) and a peer that can reach you.
2. Have the peer send a message that would use that tool. Expected: the task ends
   `TASK_STATE_FAILED`; the peer's follow-up view shows the failure, and the task's session in
   your session list shows the denied call plus which peer caused it.
3. Repeat with an `ask`-level tool: the approval prompt appears in the task's session, and the
   turn proceeds only after you decide.

**Automated tests.** `packages/plugin-a2a/test/session.test.ts` › "a rule-denied tool call
fails the run with the permission error" and "a rejected permission prompt fails the run even
without reply text" (deny/ask both surface as failures, not silent replies); `test/inbound.test.ts`
› "a self-identified peer name reaches the task record and the runner" and "the remote address
identifies peers that send no header" (peer identity lands where the run and the thread can show
it); `packages/a2a/test/server.test.ts` › the `x-a2a-peer` header tests. The denied-run tests
drive the real `SessionRunner` permission path — the same code local prompts use — so parity
can't silently regress behind a mock.

### 4.4 Conversation turn events (A2A-008)

**What it does.** Every A2A activity emits typed events on opencode's global event bus — the
same fan-out the Desktop and TUI panels read — so a third-party integration can follow a
conversation as it happens instead of polling. The contract is five event types:

- `a2a.task.dispatched` — a task was created (first seen on this side), with its initial state.
- `a2a.task.updated` — the task moved between non-terminal states (`WORKING`,
  `INPUT_REQUIRED`, `CANCELED`, …).
- `a2a.task.completed` / `a2a.task.failed` — the task reached a terminal state; the payload's
  `content` carries the closing message (the turn-cap line or the failure reason) and a
  completed task with a verdict also carries `artifact`.
- `a2a.conversation.turn` — one event per message, in *both* directions:
  `{ speaker: "local" | "remote", turn, taskId, peerId, content }`. `local` is this instance's
  own message, `remote` the peer's — so a loopback exchange emits both halves of every pair.

Task events carry `{ taskId, peerId, state, content? }`; cancels emit the same
`a2a.task.updated` with `TASK_STATE_CANCELED`.

**How to use.** Read them from the serve event stream — the same SSE endpoint the app subscribes
to:

```sh
curl -N http://localhost:4096/global/event
```

Each A2A event arrives as `{ type: "a2a.task.*" | "a2a.conversation.turn", properties }` while a
conversation runs — you can watch a peer's `a2a_ask` call produce `dispatched` → `turn` (local) →
`turn` (remote) → `updated` in real time.

**How to user-test.**
1. Start `opencode serve` with the plugin enabled and subscribe to `/global/event` as above.
2. Drive one exchange (an `a2a_ask` in a session, or §5's demos). Expected: the events arrive in
   order — `task.dispatched` once, one `conversation.turn` per message alternating
   `local`/`remote`, and `task.updated`/`task.completed` (or `failed`) as the task settles.
3. Cancel mid-run (§4.6): an `a2a.task.updated` with `TASK_STATE_CANCELED` lands on the stream
   too — cancels are not a hidden path.

**Automated tests.** `packages/a2a/test/events.test.ts` (the five-type contract and the payload
shape — task events carry `taskId`/`state`, turn events carry `speaker`/`turn`/`content`);
`packages/plugin-a2a/test/events.test.ts` (a full inbound exchange emits `dispatched` → turns →
`INPUT_REQUIRED`; the cap emits `task.completed`; cancel emits `TASK_STATE_CANCELED`; a failing
run emits `task.failed` with the reason; the outbound `a2a_ask` path emits the same sequence; and
`createEventEmitter` delivers everything onto the real `GlobalBus`). Both directions and every
terminal path are asserted on the bus itself — the contract integrators consume, not an internal
shim.

### 4.5 The thread in the session view (A2A-009)

The thread displays messages in order. The exact metadata shown depends on the surface:
the session view and Desktop hub show the peer and message text, while the TUI also shows
the task ID, turn numbers, and a completed task's verdict Artifact.

| Task state | Meaning to the user |
| --- | --- |
| `TASK_STATE_SUBMITTED` | The task was accepted and created; its first turn is starting. |
| `TASK_STATE_WORKING` | The receiving agent is processing a message. |
| `TASK_STATE_INPUT_REQUIRED` | A reply is ready; the peer may send a follow-up turn. |
| `TASK_STATE_COMPLETED` | The task finished. Reaching the four-turn cap is a completed, bounded outcome, not an error. |
| `TASK_STATE_FAILED` | A real error occurred, such as a network, permission, or timeout failure. Inspect the task's status message with `tasks/get` and check the receiving session for its error details. |
| `TASK_STATE_CANCELED` | The conversation was stopped. |

**Where to find the thread.**

- In a session, the timeline shows a foldable **A2A conversation** under the outbound A2A
  request. Expand it to read the ordered message lines; the header identifies the remote
  peer and turn count.
- The session view also shows the live A2A thread panel when a conversation has turns. It
  includes the task ID and renders each message as the peer identity followed by the full
  message text. The Desktop A2A hub's task detail uses the same thread and can offer a
  follow-up for an active outbound task.
- In the TUI, open **A2A: Sessions** and select a task. The detail shows its state, peer,
  shortened task ID, numbered turns, and a verdict section when the task has an Artifact.

The desktop conversation body deliberately does **not** render a separate verdict block:
the Artifact usually repeats the final peer reply. To inspect the stored Artifact directly,
call `tasks/get` with the task ID (see §5.1); the TUI detail renders its text under
**verdict**.

**How to user-test.**
1. Run the §2 loopback exchange and open its originating session. Expand the **A2A
   conversation** under the outbound request; in the Desktop hub, open **A2A: Sessions** and
   select the same task.
2. Expected: the messages appear in order with the remote peer identity and full reply text.
   The session panel shows the task ID; the inline header shows the peer and turn count.
3. Open the same task from the TUI's **A2A: Sessions**. Expected: the detail shows peer,
   task ID, state, numbered messages, and the Artifact under **verdict** if one exists.

Events available to the live thread include task dispatched, updated, completed, and failed
events, plus one `a2a.conversation.turn` event for each sent or received message. The data
path is covered by `packages/app/src/a2a/thread-store.test.ts` (`dispatched starts a task
with its first state and status`, `only appends a state when it differs from the last`,
`attaches a verdict artifact and status message`, and `appends turns in arrival order with
their index and speaker`) and `packages/app/src/a2a/live-threads.test.ts` (`maps persisted
history and states into thread data`, `a segment keeps only its own turns and states; the
verdict stays with the last one`, and `filters live turns to the segment's range`). The UI
surface is covered by `packages/app/src/components/a2a/inline-thread.test.tsx` (fold
behavior and three conditional DOM tests); the three DOM tests skip when the Solid DOM
runtime is unavailable in the unit runner. Non-DOM store and mapping tests still exercise
event replay, thread slicing, and data shaping.

### 4.6 Canceling a conversation (A2A-012)

**What it does.** Stops a running conversation on both sides: it sends `tasks/cancel` to the peer, interrupts the local session, settles the task `TASK_STATE_CANCELED`, and emits the cancel event. Late replies after a terminal state never reopen the task.

**How to use.**
- **Desktop:** the thread panel shows a **Cancel thread** button while a turn is running; the A2A hub also offers **Cancel** on non-terminal session rows and in the task detail.
- **TUI:** press `x` in the thread view.
- Interrupting the tool turn with the normal session stop control also cancels — the plugin turns it into `tasks/cancel` plus a `TASK_STATE_CANCELED` event.
- Cancel applies to remote and local every time; if the peer is unreachable, the local side still cancels cleanly. Canceling twice is harmless (idempotent).

**How to user-test.**
1. Start a loopback conversation and cancel while a reply is pending: hub → Sessions → open the running task → **Cancel** (or `x` in the TUI, or stop the tool turn in-session).
2. Expected: the task settles `TASK_STATE_CANCELED` in the list and detail, the thread ends without an error style, and no further turns appear on either side. Send a late message to the same task afterwards — it is rejected and never reopens.

**Automated tests.** `test/cancel.test.ts` (6 tests: cancels remote and emits one CANCELED event, idempotent, unreachable peer still canceled, local cancel trusted, defensive event, missing id ignored); `test/server.test.ts › tasks/cancel` (transition, `onCancel` callback, cancel event, terminal tasks not cancellable); `test/admin.test.ts` (cancel over the control API); UI surface: the thread's cancel control (enabled only on running tasks) and the TUI `x` action. Both wire directions are covered: the client cancel path against a real peer, and the server cancel path against a real client.

### 4.7 Identity and nicknames (A2A-013)

**What it does.** Peers appear as names, not socket addresses. The `name` option is your identity: it travels as the `x-a2a-peer` header on every request and is what your agent card reports. Received tasks record the peer's name, so threads and the session registry say `agent-b` instead of `192.168.1.23:4322`.

**How to use.** Set `a2a.name` (for example `"name": "agent-b"`). With a name set:
- `GET /.well-known/agent-card.json` returns `"name": "agent-b"`.
- Wherever a peer appears, the nickname comes first and the endpoint follows, dimmed: `agent-b · 192.168.1.23:4322`. Same-nickname collisions append the endpoint; peers that send no name show the endpoint alone.
- Tasks you receive carry `peerId: "agent-b"` — no IPs in the thread.

Without a name, the card falls back to `"opencode"` and the plugin logs a one-time notice at startup: peers will see your socket address instead.

**How to user-test.**
1. Set `name` and reload, then `curl http://localhost:4000/.well-known/agent-card.json` → `"name": "agent-b"`.
2. Have a peer start a task with you: the recorded peer identity is your nickname, not an address.
3. In Settings → A2A, press **Test** on a peer: it fetches the live card and shows the name the peer *claims*. Your local key is just your label — the claimed name is what is on the wire, and the two may differ.

**Automated tests.** `test/inbound.test.ts` (card carries the configured name, falls back to `opencode`, name reaches the task record, address fallback when no header), `test/plugin.test.ts` (one-time notice only when enabled without a name), `test/admin.test.ts` (peer Test returns the live card name), TUI `test/format.test.ts` (row identity and peer-merge rules). The display rules are asserted on the rendered data, not just on the wire.

### 4.8 Local control API (A2A-014)

**What it does.** When enabled, the plugin hosts a **loopback-only** admin server so the Desktop and TUI can drive A2A with no core changes: the session registry, direct start/continue/cancel, and peers management. It is never exposed on the A2A peer port.

**How to use.** The bound port is written to `<project>/.opencode/a2a/admin.port` (removed when the plugin is disposed). Clients resolve it in this order: `OPENCODE_A2A_ADMIN_URL` → the opencode server's own `/a2a/*` routes → the port file. All responses are JSON.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/a2a/self` | This instance's inbound socket (localhost + LAN addresses). |
| `GET` | `/a2a/sessions` | Session registry, most recent first. |
| `GET` | `/a2a/sessions/:taskId` | One registry record. |
| `POST` | `/a2a/conversations` | `{ peer, message, origin? }` → start a turn and await it. |
| `POST` | `/a2a/conversations/:taskId/messages` | `{ message }` → continue the same task. |
| `POST` | `/a2a/conversations/:taskId/cancel` | Cancel a task (remote + local cancel paths). |
| `GET` | `/a2a/peers` | Effective `allowedPeers` (name + URL). |
| `POST` | `/a2a/peers` | `{ name, url }` → validate, JSONC-write, live re-apply. |
| `DELETE` | `/a2a/peers/:name` | Remove a peer and live re-apply. |
| `POST` | `/a2a/peers/:name/test` | Fetch the peer's agent card; returns its name/description. |

`origin` is `tui` or `app` (default `app`). Bad input and bad URLs return `400`, unknown tasks/peers `404`, peer/network failures `502`. State lives under `<project>/.opencode/a2a/`: `sessions.json` keeps the last 50 tasks by `updatedAt` (atomic writes; a task left running by a dead process settles to `TASK_STATE_FAILED` with `host restarted` on load).

**How to user-test (curl).**

```sh
PORT=$(cat .opencode/a2a/admin.port)
curl -s localhost:$PORT/a2a/sessions
curl -s -X POST localhost:$PORT/a2a/conversations \
  -H 'content-type: application/json' \
  -d '{"peer":"agent-a","message":"ping"}'
curl -s -X POST localhost:$PORT/a2a/peers \
  -H 'content-type: application/json' \
  -d '{"name":"agent-b","url":"http://localhost:4001"}'
```

After a scripted exchange, the sessions listing shows the task with the right peer, direction, state, and turns. Adding a peer makes a JSONC-safe edit to the config file (the diff shows only the added line; comments stay intact) and `a2a_ask` accepts the new peer immediately — no restart. Removing it refuses further use. A bad URL returns `400` and writes nothing. Restart the instance: sessions still list, with no duplicates and no phantom running tasks.

**Automated tests.** `test/registry.test.ts` (registry records both directions with peer/origin/state/turns; persistence, dead-host settling, prune), `test/peers.test.ts` (7 JSONC write-back tests including live apply), `test/admin.test.ts` (8 HTTP tests: loopback-only bind and port file, sessions, conversations including the cap, cancel, peers CRUD, peer test, 4xx paths), app `src/a2a/control.test.ts` (9 tests including stale-port retry). The suites run the real HTTP server against the real config file — the same code path the UIs use.

### 4.9 Desktop hub (A2A-015)

**What it does.** The app surface for A2A: start conversations, browse current and past sessions, and manage peers — all over the local control API.

**How to use.**
- Open it from the command palette: **A2A: New conversation** or **A2A: Sessions**.
- **New:** pick a peer from `allowedPeers`, write a message, and press **Start conversation**. The dialog switches to the live thread as turns stream in; the follow-up box continues the same task until the cap. While a reply is pending the dialog shows **Waiting for peer…**.
- **Sessions:** current and past tasks with peer, direction (Inbound/Outbound), state, turn count, and age, newest first. Click a row for the detail: the full thread, the task id, **Open session** (jumps to the linked local session when the task has one), and **Cancel** on running tasks.
- **Peers, under Settings → A2A:** **Status** (whether the control API is reachable for this directory), the **Listening socket** with a **Copy** button (copies a ready-to-paste `allowedPeers` entry so a peer can add you), **Own identity** (your `name`), and the peers list: **Add peer** (name + URL), **Test** (fetches the agent card and shows the claimed name, which may differ from your local key), **Remove** (with confirm).
- If the plugin is not enabled for the directory, the hub says **A2A is not running** and links straight to the settings tab.
- Known behavior: the app conversation body renders messages in full and deliberately omits a separate verdict block (the verdict usually repeats the peer's final reply); a status note explains endings when needed. The TUI still renders the verdict artifact.

**How to user-test (loopback).**
1. Enable the plugin with one peer, then open the hub from the command palette.
2. Start a conversation, watch the turns arrive live, and send one follow-up on the same task.
3. Cancel a running task from the hub detail.
4. In Settings → A2A, add, test, and remove a peer; confirm the config edit and that the new peer works from `a2a_ask` without a restart.
5. Restart the opencode server; the hub still lists the sessions.

**Automated tests.** app `src/a2a/control.test.ts` (9), `src/a2a/live-threads.test.ts` (13), `src/a2a/thread-store.test.ts` (8), `src/components/a2a/inline-thread.test.tsx` (6; 3 DOM-render tests are conditionally skipped and documented in-file — their data layers are covered by the non-DOM tests), i18n `src/i18n/parity.test.ts` (5). Coverage runs from the control client through the event store to the rendered row data; the visual walkthrough above is the manual checklist.

### 4.10 TUI panel (A2A-016)

**What it does.** The terminal surface for A2A: browse current and past sessions, start and
continue conversations, and manage `allowedPeers` — all over the local control API (§4.8),
with live updates riding the `a2a.*` events from §4.4.

**How to use.** TUI plugins are declared in **`tui.json`** — *not* `opencode.json`, which only
feeds server plugins. Put either `<project>/tui.json` or `<project>/.opencode/tui.json` in the
directory you launch the TUI on:

```json
{ "plugin": ["file:///absolute/path/to/packages/plugin-a2a"] }
```

If that project directory is a scratch dir (no repo checkout), also give it a `tsconfig.json` so
the plugin's `.tsx` compiles:

```json
{ "compilerOptions": { "jsx": "preserve", "jsxImportSource": "@opentui/solid", "customConditions": ["browser"] } }
```

Once loaded, type `/` in the prompt — three commands appear:

- **`/a2a` — A2A: Sessions.** Current and past tasks (peer, direction, state, turns, age;
  running on top). Re-running it while the panel is open closes it. `enter` opens the thread:
  turns in order with speaker labels, the state chip, the verdict artifact when present, and the
  turn-cap message rendered as the bounded ending rather than an error. `INPUT_REQUIRED` reads
  as `your turn` on outbound tasks (the peer is waiting for *your* reply) and `awaiting input`
  inbound. Thread keys: `m`/`enter` reply (outbound + `INPUT_REQUIRED` only), `x` cancel a
  running task, `b`/`backspace` back to the list, arrows/`pageup`/`pagedown` scroll, `r`
  refresh, `esc` close.
- **`/a2a-new` — A2A: New conversation.** Peer picker (configured `allowedPeers` plus names
  seen in sessions), then a message prompt; follow-ups reuse the same `taskId`.
- **`/a2a-peers` — A2A: Peers.** The `allowedPeers` map plus your own identity and listener
  status. `enter` on a peer offers **Test** (fetches the agent card — the peer's *claimed* name,
  which may differ from your local key) and **Remove**; "Add peer" asks for a name and URL.

**How to user-test (no model or second machine needed).** The demo control stub serves the same
`/a2a/*` contract in front of a real loopback peer with a scripted echo runner:

```sh
cd packages/plugin-a2a
bun demo/control-stub.ts        # writes .opencode/a2a/admin.port in the cwd; serves the `loop` peer
```

Then launch the TUI on that directory and:

1. `/a2a-new` → pick `loop` → send a message. Expected: the thread shows your turn, then the
   stub's reply, state `your turn`.
2. `m`, type a follow-up, `enter`. Expected: another pair of turns on the same task.
3. `x` → confirm. Expected: the task settles `CANCELED`; `b` returns to the list.
4. Restart the stub with `A2A_STUB_TURNS=1` and run one exchange. Expected: `COMPLETED` with
   "max turns reached without verdict" plus a verdict artifact in the thread.
5. `/a2a-peers`: `loop` is listed, your own identity row shows `listening`; **Test** reports the
   card name (`stub-agent`).

Cross-check the panel against the wire: `curl localhost:$(cat .opencode/a2a/admin.port)/a2a/sessions`
shows the same task, direction `outbound`, and turn count.

**Automated tests.** `packages/plugin-a2a/test/tui-panel.test.tsx` (renders the panel headlessly
through the real `testRender` dialog stack against a live stubbed `/a2a/*` server: session list →
thread, a live `a2a.conversation.turn` event adds a turn without refetch, the `m` reply path
POSTs to `/a2a/conversations/:id/messages`, slash-name registration, and the open/close toggle);
`test/format.test.ts` (state labels and tones, running-first sort, direction/peer rendering, the
cap message as a bounded ending); `test/control.test.ts` (client routes, payload shapes,
`ControlError`, and the three-step endpoint discovery including stale port files). The headless
suite exercises the same code the interactive walkthrough drives — the manual run above is the
visual confirmation, not untested surface.

## 5. Demos

### 5.1 Two-machine debate — four turns with a verdict (A2A-010)

`demo/debate.ts` plays **Agent A** in a scripted four-turn debate (open → reply → challenge →
final) against your opencode peer (**Agent B**), then reads the verdict `Artifact` back over
`tasks/get`. It runs on plain Bun — no model needed on the A side.

**Setup (Agent B — the opencode machine).**

1. Configure the plugin in `opencode.json` (§3): `enabled: true`, `name: "agent-b"`, a fixed
   `listenPort` (e.g. `4000`), `allowedPeers: { "agent-a": "http://<agent-a-host>:4000" }`,
   `maxTurns: 4`. Agent B needs a working model credential — its session runner writes the
   replies (see §6 if a turn fails with an API-key error).
2. Start opencode in the configured directory; the log shows
   `a2a listen url=http://0.0.0.0:4000`. The listener binds on all interfaces, so open the port
   in the firewall (or tunnel it — see §6) when the machines aren't on one LAN.
3. Full per-machine walkthrough — credentials, `opencode.json` per side, firewall rules, the
   `curl /config` bootstrap that `serve` mode needs once per start — is in
   `packages/plugin-a2a/demo/TWO-MACHINE.md`.

**Run (Agent A).**

```sh
cd packages/plugin-a2a
bun run demo/debate.ts --peer http://<agent-b-host>:4000 --name agent-a
```

**Expected output.**

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

All four turns share one `taskId`; the script fails loudly if the task never completes or
`tasks/get` returns no verdict artifact. Same machine works too — point `--peer` at
`http://localhost:4000`.

**Automated tests.** This is a scripted manual walkthrough. Its mechanics are covered by
`test/peer-integration.test.ts` —
two-turn exchanges over `message/stream` and `message/send` against a real in-process peer —
and the cap/verdict ending by `test/ask.test.ts` and `test/inbound.test.ts`; the demo adds the
two-machine setup and the artifact read-back.

### 5.2 Non-OpenCode peer check (A2A-010)

`demo/peer-check.py` is a non-opencode A2A client written against **Python's standard library
only** — no `a2a-sdk`, no dependencies, plain JSON-RPC over HTTP. That is the point of the
check: it proves the bridge speaks standard A2A, so any spec-conforming peer can drive it — not
just another opencode instance.

**Run.** Needs an opencode peer up (Agent B setup in §5.1 — plugin enabled, `listenPort` fixed
and reachable):

```sh
cd packages/plugin-a2a
python3 demo/peer-check.py http://<agent-b-host>:4000
```

**Expected output.**

```
peer card: agent-b @ http://<host>:4000
task <id> created (TASK_STATE_SUBMITTED)
turn 1 reply: ...
turn 2 reply: ...
final state: TASK_STATE_INPUT_REQUIRED
peer check passed: same taskId carried both turns and both replies came back.
```

Two turns only, so the task lands in `INPUT_REQUIRED` awaiting a third; `maxTurns: 2` on the B
side makes it end `COMPLETED` instead — either is a pass. What matters: both replies arrive on
the **same `taskId`** over raw JSON-RPC (`message/send` → `tasks/get`).

**Automated tests.** The Python client is itself the test — it re-proves the inbound path from
outside opencode. The protocol surface it exercises is covered in-repo by
`test/inbound.test.ts` (replies on one `taskId`, `INPUT_REQUIRED` between turns) and
`test/peer-integration.test.ts` (the same exchange through the plugin's own client), so the
check verifies wire-level compatibility rather than implementation details.

### 5.3 Bidirectional smoke test (A2A-011)

The smoke script checks two two-turn exchanges and verifies the turn events, not just that
the server returns HTTP responses. It uses the real `a2a_ask` path for OpenCode → peer and
raw A2A against a live bridge for peer → OpenCode.

With the bridge and OpenCode serve endpoint running (the setup in
[`packages/plugin-a2a/demo/README.md`](./packages/plugin-a2a/demo/README.md)), run:

```sh
cd packages/plugin-a2a
bun run demo/smoke-bidirectional.ts \
  --peer http://<peer-host>:4000 --peer-id agent-a \
  --inbound http://localhost:4000 --serve http://localhost:4096 \
  --name agent-b
```

For loopback, point `--peer` at your own A2A listener and configure that URL as a peer in
`allowedPeers`. For a cross-machine run, set `--peer` to the other machine; keep `--inbound`
and `--serve` pointed at your own listener/server, and have the other person mirror the flags.
Both machines need reachable ports and a working model for inbound replies.

Expected final line:

```text
SMOKE PASS: both directions completed 2 turns (tasks <id-a>, <id-b>) with turn events
```

Direction A checks one task ID plus `local@0, remote@1, local@2, remote@3` and
`task.dispatched`. Direction B checks a separate task ID plus `remote@0, local@1, remote@2,
local@3` from the serve event stream. Automated coverage is in
`packages/plugin-a2a/test/peer-integration.test.ts` (`two turns in one task over
message/stream, then the caps close it` and `message/send drives the same bridge without
streaming`). The loopback and cross-machine run evidence is recorded in [PR #34](https://github.com/CMU-17313Q/opencode-f26-wild_pointer/pull/34).

## 6. Troubleshooting

| Symptom | What to check |
| --- | --- |
| The A2A tool or listener is unavailable | Confirm the plugin is registered in the `plugin` tuple and `a2a.enabled` is true (or `OPENCODE_A2A_ENABLED=1`). Restart/reload after changing plugin options. With the plugin disabled, no A2A tool or listener is created. |
| The peer cannot connect | Confirm `listenPort`, the URL in `allowedPeers`, and the peer's `/.well-known/agent-card.json` from the other machine. Open the TCP port on the receiving firewall; for machines behind NAT, use a reachable tunnel URL. `listenPort: 0` chooses a port dynamically, so use a fixed port for a manual cross-machine config. |
| A task fails or times out | Inspect the task's `status.message` with `tasks/get` and check the receiving OpenCode session for the failure reason. Check the receiver's provider key/model and `turnTimeoutMs`; timed-out inbound work is aborted and the task fails instead of remaining `WORKING`. |
| A turn is denied or waiting for approval | Inbound turns use the receiving session's normal permissions. Approve the permission request in the receiving session, or adjust that agent's permission policy; a denied action is not a peer-network failure. |
| The conversation ends at the turn limit | This is a normal completed outcome with `max turns reached without verdict`. Start a new task for a fresh exchange; `maxTurns: 0` disables the configured cap. |
| The thread or verdict is missing | Confirm the task emitted `a2a.conversation.turn` events and inspect its `tasks/get` result. The desktop body omits a duplicate verdict block by design; the TUI task detail renders the Artifact, and the raw `tasks/get` result is the source of truth. |
| `Connection refused` on the A2A port | The peer's opencode isn't running, or its project wasn't bootstrapped this session — `serve` mode needs one `curl "http://localhost:<serve-port>/config?directory=<path>"` after every server start before plugins load (the TUI does this automatically). Verify with `curl http://<peer>:<port>/.well-known/agent-card.json`. |
| Task fails with `Invalid API key` | Inbound replies run a real model. Pin `a2a.model` to a provider you have a key for (`auth login` or an env var) and restart — OpenCode Zen does not work on this fork. |
| `a2a_ask` refuses the peer / "Unknown A2A peer" | The name isn't in `allowedPeers`, or the URL doesn't match exactly — scheme, host, and port all count (`http://host:4000` ≠ `http://host:4322`). Check the effective map under Settings → A2A or `/a2a-peers`. |
| Message sent, then silent timeout | Firewall or NAT: `listenPort` isn't reachable inbound. Test `curl http://<peer-ip>:<port>/.well-known/agent-card.json` **from the other machine**; open the port (`New-NetFirewallRule` / `ufw allow`), or tunnel (`ngrok http <port>`) and put the tunnel URL in `allowedPeers`. |

## 7. Reference

- A2A methods in scope: `message/send`, `message/stream`, `tasks/get`, `tasks/list`, and
  `tasks/cancel`.
- Agent Card location: `/.well-known/agent-card.json`.
- Protocol shapes, task states, and JSON-RPC examples:
  [`packages/a2a/INTERFACES.md`](./packages/a2a/INTERFACES.md) and
  [`packages/a2a/src/types.ts`](./packages/a2a/src/types.ts).
- Plugin options and control API:
  [`packages/plugin-a2a/README.md`](./packages/plugin-a2a/README.md).

## 8. Appendix — Test coverage & CI (A2A-017)

Every acceptance criterion set during planning maps to a covering test or an explicit note
when a criterion is interactive by nature. The full A2A-001–016 criterion-to-test matrix is
in [`A2A-test-matrix.md`](./A2A-test-matrix.md). The relevant A2A-009/010 entries include
the thread store, live thread mapping, conditional UI rendering, the scripted four-turn
debate, and the Python standard-library peer check.

| Suite | Location | Size | CI |
| --- | --- | --- | --- |
| `a2a` (protocol) | `packages/a2a/test/` | 67 tests | `a2a#test` |
| `@opencode-ai/plugin-a2a` (bridge) | `packages/plugin-a2a/test/` | 130 tests | `@opencode-ai/plugin-a2a#test` |
| `@opencode-ai/tui` | `packages/tui/test/` | 193 + 1 skip | `@opencode-ai/tui#test` |
| app-side A2A + i18n | `packages/app/src/a2a`, `src/components/a2a`, `src/i18n` | 38 A2A-relevant tests | already in `@opencode-ai/app#test` |

Run them locally from the package directory:

```sh
cd packages/a2a && bun test
cd packages/plugin-a2a && bun test
cd packages/tui && bun test --timeout 30000
cd packages/app && bun run test:unit
```

Since A2A-017 these suites run in CI on every push (`turbo.json` gained `a2a#test`,
`@opencode-ai/plugin-a2a#test`, and `@opencode-ai/tui#test`; previously they were silently
skipped). Interactive criteria (the debate demo, cross-machine smoke test, loopback UI
runs) have reproducible steps in this guide. PR #34 records the A2A-011 loopback and
cross-machine smoke runs; a successful A2A-010 four-turn debate and non-OpenCode peer-check
transcript still needs to be recorded. On the current
`feat/a2a` guide merge, the [unit job](https://github.com/CMU-17313Q/opencode-f26-wild_pointer/actions/runs/38079206264/job/114292451625),
[e2e smoke job](https://github.com/CMU-17313Q/opencode-f26-wild_pointer/actions/runs/38079206264/job/114292451907),
and [typecheck run](https://github.com/CMU-17313Q/opencode-f26-wild_pointer/actions/runs/38079206157)
all passed.

## Review checklist

- [x] All draft prompts are completed or removed.
- [ ] Setup instructions and examples were tested against the current implementation.
- [ ] Permission, cancellation, failure, and turn-limit behavior matches the product.
- [ ] Each owner has reviewed their section.
- [ ] Screenshots or links are current and do not expose secrets or private peer details.
