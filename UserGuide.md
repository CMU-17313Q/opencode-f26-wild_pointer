# A2A Agent Conversations — User Guide

> **Collaborative draft:** Each owner should complete their named section and replace its
> `[Fill in: ...]` prompts with verified product behavior. Do not document planned behavior
> as available until it is implemented and tested.
>
> **Structure (A2A-018):** 1. What A2A adds · 2. Quickstart · 3. Configuration reference ·
> 4. Features (one section per shipped ticket) · 5. Demos · 6. Troubleshooting · 7. Reference ·
> 8. Appendix (test coverage & CI). Every feature section covers: what it does · how to use it ·
> how to user-test it · where its automated tests live and why they're sufficient.

## 1. What A2A adds to opencode

OpenCode agents can exchange messages with another agent in a multi-turn task. A conversation
keeps the same task ID across turns, can be initiated by either side, and is shown as an ordered
thread in the session view. The feature is opt-in and is off by default.

Use this guide to configure A2A, start or respond to a conversation, review its turns, and stop
it when needed.

### In scope

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

**Peer.** Any A2A-speaking agent you exchange tasks with. Outbound calls name a peer from `allowedPeers` (see §3); inbound callers are recorded under the name they send in the `x-a2a-peer` header, falling back to their socket address when they send none — so threads say `agent-b`, not an IP.

**Task.** One conversation = one task ID. The first `message/send` creates the task (`TASK_STATE_SUBMITTED`); every follow-up carries the same `taskId`, and either side can read the whole thing back with `tasks/get`, which returns the status plus the full message history.

**Turn.** One message in either direction. Turns are numbered from 0 and each carries a speaker: `local` (this machine sent it) or `remote` (the peer sent it). The thread view (§4.5) renders turns in order with speaker, peer identity, and turn number.

**Task states.** `TASK_STATE_SUBMITTED` (created, no reply yet) → `TASK_STATE_WORKING` (a reply is being produced) → `TASK_STATE_INPUT_REQUIRED` (a reply landed and the task waits for the next message). Terminal states: `TASK_STATE_COMPLETED` (finished — including hitting the turn cap, which is a normal bounded outcome, not an error), `TASK_STATE_FAILED` (a real error: network, permission, or timeout), `TASK_STATE_CANCELED` (stopped via `tasks/cancel`, §4.6).

**Turn cap.** `maxTurns` (default `4`, `0` means unbounded) counts every message from both speakers. Reaching it completes the task with the status message `max turns reached without verdict`. To keep talking, start a new task.

**Idempotency.** A retried message keeps its `messageId`, and a duplicate `messageId` never appends a second turn — resends are safe.

**Timeouts.** A turn that runs longer than `turnTimeoutMs` (default `120_000` ms) is aborted and the task fails cleanly instead of sitting in `WORKING` forever.

**Discovery.** Before talking, a client fetches the peer's Agent Card at `/.well-known/agent-card.json` — name, capabilities (e.g. streaming), and skills. If the card is unreachable, the peer isn't (see §6).

**Automated tests.** `packages/a2a/test/types.test.ts` (Task/Part/Message/AgentCard accept + reject suites) and `conversation.test.ts` (Speaker/Turn accept + reject) pin the wire shapes; `tracker.test.ts › policy > 6-turn attempt stops at 4 with completed and the cap message`, `note > duplicate messageId returns the existing turn without appending`, and `policy > timed-out task is failed` pin the cap, idempotency, and timeout rules; `client.test.ts › fetchAgentCard` pins discovery. Full protocol suite: `cd packages/a2a && bun test` (67 tests).

## 2. Quickstart

*[Fill in — owner: Tram: the verified first-run walkthrough — enable the plugin → configure one
loopback peer → hold a first conversation (desktop hub, TUI panel, or `a2a_ask`). Reuse the
loopback recipe from `packages/plugin-a2a/demo/README.md`; the loopback config in §4.1 is a
verified snippet you can lift.]*

Before you begin:

- OpenCode version: [Fill in: supported version or build]
- Network requirements: [Fill in: reachability, firewall, and address requirements]
- Peer requirements: [Fill in: supported A2A peer and any setup needed]
- Access needed: [Fill in: permissions, credentials, or other prerequisites]

A2A is disabled unless enabled explicitly: set `a2a.enabled: true` in the plugin options of
`opencode.json` (see §3) or set `OPENCODE_A2A_ENABLED=1`.

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

*[Fill in — owner: Tram: where the thread appears (session-view panel and hub detail), what each
row shows, and how the final verdict is found per surface — the desktop conversation body omits
a separate verdict block (see §4.9) while the TUI renders the artifact. Verify against the
merged UI. Sources: PRs #25/#35.]*

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

**Automated tests.** This is a scripted walkthrough by design (it *is* the acceptance evidence
for cross-machine A2A-010). Its mechanics are covered by `test/peer-integration.test.ts` —
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

**What it does.** Proves both directions in one run with one `taskId` per direction and turn events present throughout. Direction A (opencode → peer) goes through the real `a2a_ask` tool with a recording emitter; direction B (peer → opencode) speaks raw A2A to a live inbound bridge while turn events are captured off the serve SSE stream (`/global/event`) — the same fan-out the thread view reads. Any missing reply, broken `taskId` reuse, or absent turn event fails loudly with a non-zero exit.

**How to use.** Needs your own serve + A2A listener up (Agent B setup in §5.1), since direction B targets your live inbound and reads your serve event stream:

```sh
cd packages/plugin-a2a
bun run demo/smoke-bidirectional.ts \
  --peer http://<peer-host>:4000 --peer-id agent-a \
  --inbound http://localhost:4000 --serve http://localhost:4096 \
  --name agent-b
```

Loopback (one machine, real model): point `--peer` at your own A2A port, as above. Cross-machine: `--peer` is the friend's URL while `--inbound`/`--serve` stay yours; the friend mirrors with the flags flipped.

**How to user-test.** Run either variant and read the tail:

```
SMOKE PASS: both directions completed 2 turns (tasks <id-a>, <id-b>) with turn events
```

Direction A asserts both replies arrive under one `taskId` through `a2a_ask`, plus `local@0, remote@1, local@2, remote@3` turn events and `task.dispatched`. Direction B asserts the same over the wire, plus `remote@0, local@1, remote@2, local@3` turn events observed on the serve stream. Confirm direction A on the peer's side too: the same `taskId` must resolve via `tasks/get` on the peer's listener (and return "not found" on yours — proving where it lives).

**Automated tests.** The no-model equivalent runs in CI: `packages/plugin-a2a/test/peer-integration.test.ts › two turns in one task over message/stream, then the caps close it` and `message/send drives the same bridge without streaming`. The scripted live runs (loopback + cross-machine, both directions) are recorded as run evidence in PR #34.

## 6. Troubleshooting

| Symptom | What to check |
| --- | --- |
| The A2A tool or listener is unavailable | [Fill in: enablement, configuration, and restart checks] |
| The peer cannot connect | [Fill in: address, network, and allowed-peer checks] |
| A task fails or times out | [Fill in: where to find the error and recommended next step] |
| A turn is denied or waiting for approval | [Fill in: permission settings and approval steps] |
| The conversation ends at the turn limit | This is a normal completed outcome. [Fill in: how to start a new task if needed.] |
| The thread or verdict is missing | [Fill in: event, task state, and Artifact checks] |
| `Connection refused` on the A2A port | The peer's opencode isn't running, or its project wasn't bootstrapped this session — `serve` mode needs one `curl "http://localhost:<serve-port>/config?directory=<path>"` after every server start before plugins load (the TUI does this automatically). Verify with `curl http://<peer>:<port>/.well-known/agent-card.json`. |
| Task fails with `Invalid API key` | Inbound replies run a real model. Pin `a2a.model` to a provider you have a key for (`auth login` or an env var) and restart — OpenCode Zen does not work on this fork. |
| `a2a_ask` refuses the peer / "Unknown A2A peer" | The name isn't in `allowedPeers`, or the URL doesn't match exactly — scheme, host, and port all count (`http://host:4000` ≠ `http://host:4322`). Check the effective map under Settings → A2A or `/a2a-peers`. |
| Message sent, then silent timeout | Firewall or NAT: `listenPort` isn't reachable inbound. Test `curl http://<peer-ip>:<port>/.well-known/agent-card.json` **from the other machine**; open the port (`New-NetFirewallRule` / `ufw allow`), or tunnel (`ngrok http <port>`) and put the tunnel URL in `allowedPeers`. |

## 7. Reference

- A2A methods in scope: `message/send`, `message/stream`, `tasks/get`, `tasks/list`, and
  `tasks/cancel`.
- Agent Card location: `/.well-known/agent-card.json`.
- Task and turn terminology: [Fill in: link to the project's interface or API reference]

## 8. Appendix — Test coverage & CI (A2A-017)

> **Draft note (remove before merging):** this appendix mirrors `A2A-test-matrix.md` (repo root, A2A-017 / issue #31). When A2A-017 merges, paste the final matrix content here (or attach it alongside) and close out its two CI run-link placeholders.

Every acceptance criterion set during planning maps to a covering test — or an explicit note when a criterion is interactive by nature. The full per-ticket table lives in `A2A-test-matrix.md`; in short:

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

Since A2A-017 these suites run in CI on every push (`turbo.json` gained `a2a#test`, `@opencode-ai/plugin-a2a#test`, and `@opencode-ai/tui#test`; previously they were silently skipped). Interactive criteria (the debate demo, cross-machine smoke test, loopback UI runs) have scripted steps — see each section above and §5 (Demos) — with run evidence linked from the matrix.

## Review checklist

- [ ] All `[Fill in: ...]` prompts are completed or removed.
- [ ] Setup instructions and examples were tested against the current implementation.
- [ ] Permission, cancellation, failure, and turn-limit behavior matches the product.
- [ ] Each owner has reviewed their section.
- [ ] Screenshots or links are current and do not expose secrets or private peer details.
