# Traceability: George Chkhaidze (gchkhaid)

Feature: A2A communication (`packages/plugin-a2a`)
Tests: `packages/plugin-a2a/test/a2a-gchkhaid.property.test.ts`

## Requirements

| ID | Evidence | Requirement | Acceptance criteria | Changed in P4B? | Property (kind) | Test |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| R1 | S-4, C-2, C-3 | A new peer's address must be an `http(s)://host:port` URL, or else it will be rejected and nothing will be saved. | `localhost:4096` or `http://192.168.1.999:4096` -> `Invalid URL` and not saved. `http://192.168.1.50:4096` -> saved. | Yes | Malformed address -> reject, file  not changed (invariant) | `R1: a malformed peer address is rejected and nothing is saved` |
| R2 | C-5, O-4 | A pending request shows the peer's name and a pending state, when it ends, it doesn't show pending. | A -> B (20 s): row shows `B working`, then `your turn` or `failed`. Cancel dueing poll -> stays `canceled`. | Yes | Row state correct after every event, finish doesn't reopen (invariant) | `R2: a finished request never shows as pending again` |
| R3 | C-9, C-10 | A peer can require a shared token and requests without it will be rejected before agent runs. | C without token -> rejected. A with token -> reply. | Yes | not implemented | N/A |
| R4 | C-9, C-10, S-2, O-1 | File reads by a peer need the receiving user's Allow/Deny, deny or no answer before the timeout -> sender gets `permission denied`. | A asks B for `notes.txt`; B denies or doesn't answer -> A's task fails. | Yes | UI prompt | N/A |
| R5 | O-6 | Each inbound conversation gets its own session titled `A2A <peer> · …`; all its messages land there. | Two messages from A in one conversation -> one `A2A A · …` session. C -> separate session. | Yes | Matches one-session-per-conversation model (model / oracle) | `R5: one labelled session per conversation` |
| R6 | S-3, O-2 | Adding then removing a peer restores the peer list and the removed peer can't be messaged. | Add/remove `bob` -> list unchanged, messaging `bob` -> `Unknown A2A peer`. | New | add -> remove = original list (round-trip) | `R6: add then remove restores the peer list` |

## Requirement changes

| ID | Original (P4A) | Revised (P4B) | Why |
| :-- | :-- | :-- | :-- |
| R1 | Badly formatted peer addresses are rejected when adding a peer. | Address must be `http(s)://host:port` | Checkability: "badly formatted" was undefined. |
| R2 | While pending, the sender sees the peer's name and a status. | Name states, and never goes back to pending after it ended. | Checkability: "status indicator" was vague. |
| R3 | Peers reject requests from unauthorized senders. | Shared token required. | Feasibility: sender identity is a self-reported header, so it can't be trusted. A token matches C-10 ("password"). |
| R4 | The receiving user can approve or deny file reads. | Approval bounded by the turn timeout. | Conflict: an unanswered prompt would stall, against S-2/O-1 ("shouldn't stall"). |
| R5 | Each peer's messages go into their own labeled session. | One labeled session per conversation. | Feasibility: one peer can have several conversations and merging them mixes contexts. Labeling (O-6) kept. |
| R6 | — | New. | Round-trip interview answers (S-3, O-2) had no requirement. |

## Step 3: run, triage, fix

`cd packages/plugin-a2a && bun test`: 135 pass and 0 fail.

| Test | Counterexample | Outcome | Fix |
| :-- | :-- | :-- | :-- |
| R1 | `ftp://a.aa` accepted | Code bug: any parseable URL was accepted (even `localhost:4096`). | `config.ts`: only `http:`/`https:`. |
| R6 | IPv6 `[::0:0:0:0:0.0.0.0]` rejected | Wrong test: generator made addresses no peer can use. | Dropped IPv6 from the generator. |
| R6 | `" a "`: remove fails | Code bug: add trimmed names, remove didn't. | `peers.ts`: trim on remove. |
| R6 | `toString`: messaging crashed | Code bug: lookups saw `Object.prototype` keys. | `Object.hasOwn` in `peers.ts`, `conversation.ts`, `admin.ts`. |
| R6 | `constructor`: config fails to load | Code bug: zod rejects that key. | `peers.ts`: reject built-in key names. |
| R2 | `[COMPLETED, SUBMITTED]` reopened | Code bug: late events (a poll after cancel) overwrote the final state. | `registry.ts`: ignore changes after a final state. |
| R5 | — | Passed. | — |
| TUI test (existing) | "Manage peers" cut off locally | Wrong test: render size came from my terminal (22 rows). | Pinned the test's screen size. |
