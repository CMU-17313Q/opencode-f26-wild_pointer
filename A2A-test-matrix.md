# A2A test coverage matrix — A2A-001 → A2A-016

- **Ticket:** A2A-017 ([issue #31](https://github.com/CMU-17313Q/opencode-f26-wild_pointer/issues/31)) — full coverage audit + CI loop.
- **Snapshot:** `feat/a2a` @ `add7f90`, 2026-10-10. Lands via the `feat/a2a-testing` PR.
- **Purpose:** P2C evidence that every acceptance criterion set during planning has automated coverage — or an explicit, reasoned note when a criterion is manual by nature. This file doubles as the **test appendix for A2A-018's `UserGuide.md`**.
- **P2C bar served:** "Automated test cases for your implemented functionality, following the acceptance criteria set during planning" + "link/description of where your added automated tests can be found, along with a description of what is being tested and why".

## Where the suites live, and how they run in CI

| Suite | Location | Size | CI before A2A-017 | CI after A2A-017 |
| --- | --- | --- | --- | --- |
| `a2a` | `packages/a2a/test/` (6 files) | 67 pass / 0 fail | **skipped** | `a2a#test` |
| `@opencode-ai/plugin-a2a` | `packages/plugin-a2a/test/` (14 files) | 130 pass / 0 fail | **skipped** | `@opencode-ai/plugin-a2a#test` |
| `@opencode-ai/tui` | `packages/tui/test/` (45 files) | 193 pass / 1 skip / 0 fail | **skipped** | `@opencode-ai/tui#test` |
| app-side A2A + i18n | `packages/app/src/a2a`, `src/components/a2a`, `src/i18n/parity.test.ts` | 38 pass / 3 skips (A2A-relevant subset; full app suite: 748 pass / 3 skips) | already wired via `@opencode-ai/app#test` | unchanged |

Before this ticket, `bun turbo test` ran 10 tasks and none of them executed the 67 + 130 (+194 tui) tests above — they existed and passed locally but no push gated them. After wiring, they run on every push.

**Run them locally (from the package directory):**

```sh
cd packages/a2a && bun test                 # 67
cd packages/plugin-a2a && bun test          # 130
cd packages/tui && bun test --timeout 30000 # 193 + 1 skip
cd packages/app && bun run test:unit        # full app suite incl. a2a + i18n parity
```

**Wiring notes (`turbo.json`):**

- `a2a#test` and `@opencode-ai/tui#test` use the standard `dependsOn: ["^build"]` shape from the file's comment. The builds they reference (`a2a#build`, `@opencode-ai/plugin#build`, `@opencode-ai/sdk#build`, `@opencode-ai/ui#build`) were already in the unit-job graph via `@opencode-ai/app#test` / `opencode#test`, so they add no new build work.
- `@opencode-ai/plugin-a2a#test` deliberately uses `dependsOn: []`: its tests run entirely from source (bun resolves the workspace exports — `a2a`, `opencode`, `@opencode-ai/plugin` — to `src/*.ts`), and `^build` would drag `opencode#build` (the full web-UI + binary build) into every push. Verified with `turbo test --dry=json`: the wiring adds exactly the three test tasks and zero new build tasks.
- All three suites were verified green under the CI toolchain (**bun 1.3.14**, downloaded separately for a parity run) before pushing — local dev bun was 1.4.0.

## PR narrative audit ("why this testing is sufficient")

| PR | Ticket(s) | Verification narrative | Note |
| --- | --- | --- | --- |
| #13 | A2A-001 | ✓ brief | build/test/typecheck numbers |
| #14 | A2A-002 | ✓ brief | test counts |
| #15 | A2A-006 | ✓ brief | test counts |
| #16, #19 | A2A-004 | ✓ thorough | explains the real in-process fake peer |
| #17 | A2A-009 | ✗ empty | superseded by #20 |
| #18 | A2A-003 | ✓ brief | incl. client↔server e2e over fetch |
| #20 | A2A-009 | ~ prose only | review statement, no numbers |
| #21 | A2A-005 | ✓ thorough | names the 2+2 flow and the injected runner |
| #22 | A2A-007 | ✓ thorough | test list + counts |
| #23 | A2A-007 | ✗ empty | same change as #22, targeted `main` |
| #24 | A2A-008 | ✓ thorough | enumerates event-path coverage |
| #25 | A2A-009/010 | ✗ none | demo evidence lives in the issue |
| #26 | A2A-012 | ✗ none | tests enumerated in this matrix |
| #33 | A2A-013/014 | ✓ thorough | offline-suite rationale + counts |
| #34 | A2A-011 | ✓ thorough | live loopback + cross-machine smoke output |
| #35 | A2A-015 | ✓ thorough | app suite counts + live loopback checklist |
| #36 | A2A-016 | ✗ raw template | **fixed during A2A-017**: scripted manual run posted as a PR comment |

Historical gaps (#17/#23/#25/#26) are superseded by later PRs or covered by this matrix; #36 was the only one still worth a direct fix and got one.

---

## Per-ticket coverage

Legend: **file › test name** (suite paths are relative to the package's `test/` dir unless a path is given). "Manual" = verified by a scripted demo/manual run (steps live in the referenced docs); these criteria are interactive by nature and are intentionally not unit-tested.

### A2A-001 — Scaffold `packages/a2a` and freeze types (PR #13)

| Acceptance criterion | Covered by |
| --- | --- |
| `bun run build` passes | `bun run build` runs as `a2a#build` inside the CI unit job (already in the graph); verified locally in A2A-017 as well |
| Valid Task and Turn JSON pass schema validation | `types.test.ts › Task > accepts a valid task`, `Part > accepts a text part`, `Message > accepts a text message`, `AgentCard > accepts a valid card`; `conversation.test.ts › Turn > accepts a minimal turn`, `Turn > accepts a turn linked to wire objects`; negative cases in the same files (`rejects ...` ×6) |
| `INTERFACES.md` published and reviewed | `packages/a2a/INTERFACES.md` (committed; reviewed via PR #13) |

### A2A-002 — A2A client (PR #14)

| Acceptance criterion | Covered by |
| --- | --- |
| Fetches the agent card from `/.well-known/agent-card.json` | `client.test.ts › fetchAgentCard > GETs the well-known URL and validates the card` |
| Starts a task → `TASK_STATE_SUBMITTED` | `client.test.ts › sendMessage > starts a task with message/send` (+ `returns a direct message reply`) |
| Two replies with the same `taskId` append to the same history | `server.test.ts › message/send > appends a reply with the same taskId to history`; end-to-end over both transports: `peer-integration.test.ts › two turns in one task over message/stream, then the caps close it`, `message/send drives the same bridge without streaming`; cap-level: `ask.test.ts › keeps one task across turns and stops at the cap` |
| `tasks/get` returns the updated task | `client.test.ts › getTask > returns the updated task with full history`; `server.test.ts › tasks/get > returns the stored task with both messages` |
| All payloads pass schema validation | `client.test.ts › errors > invalid payload becomes A2AValidationError`; `types.test.ts` / `conversation.test.ts` schema suites |
| `cancelTask` sends `tasks/cancel` | `client.test.ts › cancelTask > transitions to canceled`; server side: `server.test.ts › tasks/cancel > transitions to canceled and invokes onCancel` |
| Typed JSON-RPC exceptions | `client.test.ts › errors > JSON-RPC error becomes A2AError with code and method`, `errors > HTTP failure becomes A2AError` |

### A2A-003 — Minimal server handlers (PR #18)

| Acceptance criterion | Covered by |
| --- | --- |
| Peer can fetch the agent card | `server.test.ts › agent card > GET /.well-known/agent-card.json returns the card` (+ `supports a lazy card getter`) |
| Start a task and send a reply with the same `taskId` | `server.test.ts › message/send > creates a submitted task with the message in history`, `appends a reply with the same taskId to history`, `rejects a reply for an unknown taskId`; streaming: `message/stream > creates a task, then streams reply events for it`, `records the streamed message on an existing task` |
| `tasks/get` returns the stored task with both messages | `server.test.ts › tasks/get > returns the stored task with both messages` (+ `honors historyLength`, `unknown task is a typed error`) |
| `tasks/list` returns stored tasks | `server.test.ts › tasks/list > returns stored tasks` (+ `filters by contextId and status`, `paginates with pageToken`) |
| `tasks/cancel` → `TASK_STATE_CANCELED` + stops the local session (`onCancel`) + emits the cancel event | `server.test.ts › tasks/cancel > transitions to canceled and invokes onCancel`, `emits the cancel event to open streams`, `a terminal task is not cancellable`, `a throwing onCancel still cancels the task`; plugin side: `inbound.test.ts › cancel aborts the session and discards the late reply` |
| JSON-RPC envelope errors | `server.test.ts › json-rpc envelope > malformed JSON is a parse error`, `unknown method is method-not-found`, `invalid params are rejected` |

### A2A-004 — `a2a_ask` tool (PRs #16/#19)

| Acceptance criterion | Covered by |
| --- | --- |
| Flag off → no tools, no ports | `plugin.test.ts › plugin module > adds no tools and opens no ports when disabled`; opt-in paths: `opt-in > enables through OPENCODE_A2A_ENABLED`, `enables through plugin options`, `config hook can enable the tool`; `config.test.ts › resolveConfig` suites |
| Model can call `a2a_ask` up to `maxTurns` with one `taskId`, peer responds each turn | `ask.test.ts › keeps one task across turns and stops at the cap`, `counts prior turns when resuming a task in a fresh plugin`, `streams when the agent card advertises streaming`; `peer-integration.test.ts` (both transports) |
| Guard rails | `ask.test.ts › rejects peers outside the allowlist without contacting them`, `refuses to reuse a task with a different peer`, `rejects an empty message`, `times out when the peer never replies and cancels the remote task`, `surfaces a terminal failure`, `surfaces a terminal failure on the streaming path`, `errors when the stream ends without a reply`, `aborting the turn cancels the remote task and rejects promptly`, `abort rejects a buffered stream and cancels a resumable task`, `a follow-up on a finished task is answered locally without touching the peer` |

### A2A-005 — Inbound message to session with reply (PR #21)

| Acceptance criterion | Covered by |
| --- | --- |
| "What is 2+2?" → "4"; "Why?" → reason; both replies on the same `taskId` | `peer-integration.test.ts › two turns in one task over message/stream, then the caps close it` (drives exactly this flow over a real loopback `A2AServer` with a scripted runner — see PR #21); `inbound.test.ts › first turn replies with the session output and asks for input`, `second turn reuses the session and completes at the cap`, `a third message is rejected once the cap completes the task` |
| One opencode session per `taskId`; created on first reply | `session.test.ts › creates one session per task and reuses it`; `inbound.test.ts` first/second-turn tests |
| Works for a standard A2A peer that only sends standard fields | Automated: the bridge tests speak raw A2A over HTTP; non-opencode proof: `demo/peer-check.py` (Python stdlib peer, manual — see A2A-010) |
| Robustness | `inbound.test.ts › a duplicate messageId skips the run and leaves the settled turn`, `a failing session run fails the task with a short reason`, `an empty message fails without running the session`, `messages arriving mid-run queue behind the current run`, `a run past the turn timeout fails the task and aborts the session`, `stopping the listener closes the port` |

### A2A-006 — Conversation tracker + turn cap (PR #15)

| Acceptance criterion | Covered by |
| --- | --- |
| 6-turn attempt stops at 4 → `TASK_STATE_COMPLETED` with `max turns reached without verdict` | `tracker.test.ts › policy > 6-turn attempt stops at 4 with completed and the cap message` (+ `generic policy carries its own message`, `outcome is working while turns remain`; later addition: uncapped `maxTurns: 0` in `config.test.ts` / `events.test.ts`) |
| Duplicate `messageId` does not append a second turn | `tracker.test.ts › note > duplicate messageId returns the existing turn without appending`, `note > sync appends every unseen message without refusing` |
| Task stuck past the timeout → `TASK_STATE_FAILED` | `tracker.test.ts › policy > timed-out task is failed`; end-to-end: `inbound.test.ts › a run past the turn timeout fails the task and aborts the session` |
| Cap is a bounded outcome, not a crash | `tracker.test.ts › integration > client task feeds tracker to capped outcome`; `peer-integration.test.ts` cap endings; TUI rendering of the cap message: `format.test.ts › turns and verdicts > isCapMessage matches the shared cap constant` |

### A2A-007 — Permission parity for inbound tasks (PR #22)

| Acceptance criterion | Covered by |
| --- | --- |
| Denied action → rejected with a clear `failed` status | `session.test.ts › a rule-denied tool call fails the run with the permission error` |
| Action needing approval shows the same prompt as a local action | `session.test.ts › a rejected permission prompt fails the run even without reply text` — inbound runs go through the same `SessionRunner`/SDK client as local sessions, so `allow / ask / deny` (and the `permission.asked` event) is the shared code path, not a parallel one; outcome level asserted, parity by construction |
| Applies to turn 1 and every reply | Every turn replays through the runner: `inbound.test.ts` full-exchange tests; `session.test.ts › ordinary tool errors do not fail the run` |
| Peer identity saved in the session record | `inbound.test.ts › a self-identified peer name reaches the task record and the runner`, `the remote address identifies peers that send no header`; `server.test.ts › records the x-a2a-peer header on the task`, `falls back to the caller-supplied peer identity`, `the peer header wins over the fallback identity`, `backfills peer identity on a later message` |

### A2A-008 — Conversation turn events (PR #24)

| Acceptance criterion | Covered by |
| --- | --- |
| Five event types defined (`a2a.task.dispatched/updated/completed/failed`, `a2a.conversation.turn`) | `a2a/test/events.test.ts › A2A local event contract > recognizes the five event types the UI renders` (+ properties test) |
| Every message sent/received emits one `a2a.conversation.turn` | `events.test.ts › inbound a2a events > dispatched, turns, and status events fire for a full exchange`, `turn numbering continues and the cap emits task.completed`; outbound: `outbound a2a events > a2a_ask emits dispatched, both turn sides, and terminal status` |
| Canceled and failed emissions incl. `TASK_STATE_CANCELED` | `events.test.ts › cancel emits a2a.task.updated with TASK_STATE_CANCELED`, `a failed run emits a2a.task.failed with the reason`; `server.test.ts › tasks/cancel > emits the cancel event to open streams` |
| UI can render the full thread from events alone | app: `thread-store.test.ts › applyA2AEvent ...` (7 tests replay event sequences), `live-threads.test.ts › sliceLiveThread filters live turns to the segment's range`; real bus delivery: `events.test.ts › createEventEmitter > publishes a2a.* events onto the opencode global bus` |

### A2A-009 — Threaded conversation view (PRs #17/#20, extended by #25/#35)

| Acceptance criterion | Covered by |
| --- | --- |
| 4-turn conversation reads as a thread in order, peer identity always visible | app: `components/a2a/inline-thread.test.tsx` (fold logic + `threadDataFromRecord` mapping incl. peer identity per row), `live-threads.test.ts`; TUI: `format.test.ts › session rows > directionMark and sessionPeer render the row identity` |
| State moves `SUBMITTED` → `INPUT_REQUIRED` → `COMPLETED` with the verdict shown | `thread-store.test.ts › applyA2AEvent > dispatched starts a task with its first state and status`, `only appends a state when it differs from the last`, `attaches a verdict artifact and status message`; TUI verdict rendering: `format.test.ts › turns and verdicts > artifactText joins part text` + TUI panel thread (`tui.tsx`) |
| — known limitation | 3 DOM-render tests in `inline-thread.test.tsx` are conditionally skipped (the bun unit runner compiles `.tsx` with the classic React transform; a Solid JSX transform setup isn't available for `src/` tests). Documented in-file; data layers are covered by the non-DOM tests above. |

### A2A-010 — Cross-computer debate demo (PRs #25/#34)

| Acceptance criterion | Covered by |
| --- | --- |
| 4-turn debate → `COMPLETED` with verdict `Artifact` readable via `tasks/get` | Manual (interactive demo): `demo/debate.ts`; instructions in `demo/README.md` + `demo/TWO-MACHINE.md`; run evidence in PR #25 / issue #10 |
| Peer → opencode multi-turn with a non-opencode peer | Manual: `demo/peer-check.py` (Python 3 stdlib only, no `a2a-sdk`) |
| Scripts + short README committed | `demo/debate.ts`, `demo/peer-check.py`, `demo/README.md`, `demo/TWO-MACHINE.md` (all tracked) |

### A2A-011 — Bidirectional smoke test (PR #34)

| Acceptance criterion | Covered by |
| --- | --- |
| Both directions complete 2 turns with turn events, one `taskId` per direction | Automated (no model): `peer-integration.test.ts › two turns in one task over message/stream, then the caps close it`, `message/send drives the same bridge without streaming`; live scripted: `demo/smoke-bidirectional.ts` (direction A through the real `a2a_ask` with a recording emitter; direction B raw A2A against a live bridge with events off `/global/event`) — run evidence in PR #34 (loopback + cross-machine, both directions) |

### A2A-012 — Cancel button + hardening (PR #26)

| Acceptance criterion | Covered by |
| --- | --- |
| Cancel stops a running thread → `TASK_STATE_CANCELED` + event | `cancel.test.ts` (6 tests: cancels remote + emits one CANCELED event, idempotent, unreachable peer still canceled, local cancel trusted, defensive event, missing id ignored); `server.test.ts › tasks/cancel ...`; `admin.test.ts › POST cancel settles the task CANCELED`; API mapping: plugin `control.test.ts › start, reply, and cancel hit the documented routes`, app `control.test.ts › maps every peer and cancel endpoint`; UI surface: `A2AThread` cancel button (`a2a-thread.tsx`, gated by `cancelable()`), TUI `x` action (README §TUI panel) |
| Late replies after `COMPLETED` do not reopen the task | `server.test.ts › message/stream > rejects a streamed message for a terminal task`; `inbound.test.ts › messages after a canceled task are rejected and never reopen it`, `cancel aborts the session and discards the late reply` |
| Empty text handled; error states render without breaking the thread | `inbound.test.ts › an empty message fails without running the session`; `ask.test.ts › rejects an empty message`; error rendering: `format.test.ts › state classification > labels and tones cover every state`, `terminal states are settled and not cancelable` |

### A2A-013 — Human-readable peer identity (PR #33)

| Acceptance criterion | Covered by |
| --- | --- |
| Card returns the configured `name`; `"opencode"` fallback | `inbound.test.ts › the agent card carries the configured name`, `the agent card falls back to opencode with no name configured`, `the agent card carries the bound port` |
| One-time notice when enabled without a name | `plugin.test.ts › opt-in > logs a one-time notice when enabled without a name`, `does not log the missing-name notice when a name is configured` |
| Received tasks carry `peerId: "agent-b"` (no IP in the thread) | `inbound.test.ts › a self-identified peer name reaches the task record and the runner`, `the remote address identifies peers that send no header`; `server.test.ts` peer-header suite (see A2A-007) |
| Display rules (nickname first, endpoint dimmed; collisions; unnamed → endpoint) | `format.test.ts › session rows > directionMark and sessionPeer render the row identity`, `peer merge > configured peers first, discovered session peers appended`; dashboard Test shows the claimed card name: `admin.test.ts › POST /a2a/peers/:name/test returns the live agent-card name`; TUI: `tui-panel.test.tsx › a2a.peers lists allowedPeers and own identity` |
| Debate / peer-check prints the nickname | Manual: `demo/debate.ts` / `demo/peer-check.py` runs (A2A-010 demos) |

### A2A-014 — UI control plane (PR #33)

| Acceptance criterion | Covered by |
| --- | --- |
| Registry records both directions at dispatch (taskId, direction, peerId, origin, state, turns, timestamps, sessionId) | `registry.test.ts › session registry > an outbound exchange records peer, direction, origin, state, turns, and session`, `an inbound exchange records peer, direction, origin, state, and the runner session`, `records the conversation history and state chain` |
| Persistence + dead-host settling (no phantom running tasks) | `registry.test.ts › persists records and reloads them`, `settles a stored WORKING task as failed on load`, `prunes to the last 50 by updatedAt`, `history and states survive a reload` |
| Live peer management reuses `allowedPeers`; JSONC-safe write-back; live re-apply; hand-added peers appear; bad URLs rejected | `peers.test.ts` (7 tests: nested entry keeps comments, flat entry, remove without disturbing others, invalid URL rejected with no write, bare-spec upgrade, clear error with no registration, live-apply accept/refuse); `config.test.ts › reads nested plugin options`, `reads flat plugin options` |
| Direct start refactor (`startConversation` / `continueConversation` / `cancelConversation`; `a2a_ask` a thin caller) | `control.test.ts › start, reply, and cancel hit the documented routes`; `admin.test.ts › POST /a2a/conversations drives a full exchange including the cap`; the unchanged tool path is covered by the full `ask.test.ts` suite |
| Control API (sessions, conversations, cancel, peers CRUD, peer test) | `admin.test.ts` (8 tests: loopback-only bind + port file, `/a2a/self` socket, sessions reflect a scripted exchange, conversations incl. cap, cancel → CANCELED, peers CRUD, peer test returns live card name, 4xx paths); client side: app `control.test.ts` (9 tests, incl. stale port re-read + one retry) |
| `curl` acceptance walkthrough (scripted) | Automated equivalents above; the literal curl demo lives in `packages/plugin-a2a/README.md` (control API section) — reproducible manual run, see also PR #33 |

### A2A-015 — Desktop hub (PR #35)

| Acceptance criterion | Covered by |
| --- | --- |
| Start / browse / manage peers against a loopback peer | app `control.test.ts` (9), `live-threads.test.ts` (13), `thread-store.test.ts` (8), `inline-thread.test.tsx` (6; 3 run + 3 documented skips); plugin-a2a shared suites above; live loopback checklist in PR #35 |
| Thread shows speaker, turn, peer identity, task id, state, verdict, preview | `thread-store.test.ts` + `live-threads.test.ts` mapping suites; **conscious re-scope:** the app conversation body deliberately omits the verdict block (it duplicates the peer's final reply — commit `0be05d2`, `a2a-thread.tsx` comment) and renders messages in full; the TUI renders the verdict artifact when present |
| i18n — every string via `language.t`, parity green | `src/i18n/parity.test.ts` (5 tests: key parity, placeholders, plurals) — runs in CI |
| `bun typecheck` + app tests green; manual steps in PR | CI runs green on the PR head; narrative in PR #35 |

### A2A-016 — TUI panel (PR #36)

| Acceptance criterion | Covered by |
| --- | --- |
| Start / browse / manage peers via panel | `tui-panel.test.tsx` (3 tests: sessions list + thread open, peers + own identity, slash-command registration), headless `testRender` harness; support: `format.test.ts` (13), `control.test.ts` (10), `admin.test.ts` / `peers.test.ts` |
| Thread order, state chip, verdict, cap as bounded ending | `format.test.ts › state classification` suites, `turns and verdicts > isCapMessage matches the shared cap constant`, `artifactText joins part text`; TUI thread rendering in `src/tui.tsx` (README §TUI panel documents behavior) |
| Peer add works from `a2a_ask` immediately; remove refused; invalid URL rejected before saving | `peers.test.ts › peer manager live apply > a new peer is usable immediately and removal refuses it`; `admin.test.ts › peers CRUD over HTTP` |
| Sessions list updates live; survives restart; cancel → CANCELED | `registry.test.ts` persistence suites; `tui-panel` sessions test; `cancel.test.ts` + `admin.test.ts` cancel |
| PR includes a scripted manual run (steps + expected output) | **Was missing (PR #36 merged with the raw template).** Fixed during A2A-017: a scripted control-stub + TUI run was executed and posted as a comment on PR #36 |

---

## Conscious re-scopes & known limitations

1. **App verdict block suppressed** (A2A-009/015): the artifact usually repeats the peer's final reply; rendering it was dropped as deliberate de-duplication (commit `0be05d2`; approved in review). The status note still explains endings that need it; the TUI still renders the verdict.
2. **3 conditional DOM skips** in `inline-thread.test.tsx` (A2A-009/015): bun's unit runner can't provide the Solid JSX transform for `src/` `.tsx` tests (fails with `React is not defined` under `--conditions=browser` without more harness work). Documented in-file; the data layers each DOM test would exercise are covered by the non-DOM tests in the same file plus `thread-store` / `live-threads`.
3. **Demo-tier criteria** (A2A-010 debate, A2A-011 cross-machine, A2A-013 nickname prints, A2A-014 curl walkthrough, A2A-015/016 loopback runs) are interactive by nature; they have automated equivalents at the protocol/bridge layer and reproducible scripted steps in `demo/README.md`, `demo/TWO-MACHINE.md`, and the plugin README (and will be repeated in `UserGuide.md`).

## CI proofs (A2A-017 acceptance)

- **Before:** feat/a2a unit run [38054532729](https://github.com/CMU-17313Q/opencode-f26-wild_pointer/actions/runs/38054532729) — 10 tasks, no a2a/plugin-a2a/tui test tasks.
- **After:** _links appended when the `feat/a2a-testing` run completes._
- **Sabotage:** _red run + revert run links appended (same section)._
- **`main` latest `test` + `typecheck`:** green as of 2026-09-22 (`b901727`).
- **Parity:** all three suites verified green under bun 1.3.14 (the CI version) on 2026-10-10 before pushing.
