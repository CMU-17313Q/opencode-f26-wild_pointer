# Two-machine A2A setup (person ↔ person)

Each person runs an opencode instance with the `plugin-a2a` plugin. The plugin
(a) serves an inbound A2A server so the other person's agent can send tasks,
and (b) adds an `a2a_ask` tool so your agent can message out.
One machine = one opencode instance = one agent.

## 1. Install prerequisites (both of you)

**Git** and **Bun**:

```powershell
# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

```sh
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

## 2. Clone the repo and check out the A2A branch

```sh
git clone https://github.com/CMU-17313Q/opencode-f26-wild_pointer.git
cd opencode-f26-wild_pointer
git checkout feat/a2a-demo   # has everything incl. the demo scripts
bun install
```

> **Windows:** if `bun install` fails building `tree-sitter-powershell`
> (`node-gyp` / "Visual Studio 2017 or newer"), run
> `bun install --ignore-scripts` instead. The failing script only builds a
> native binding nobody uses — the code loads the prebuilt `.wasm` files that
> already ship inside the packages.

If the A2A PRs have merged by the time you do this, `feat/a2a` is enough.
`feat/a2a-demo` is ahead of it and safe either way.

## 3. Add a model credential (both of you)

The agent needs a real LLM to write replies — OpenCode Zen does **not** work on
this fork. Use a direct provider key:

```sh
bun run --conditions=browser ./packages/opencode/src/index.ts auth login
# pick Anthropic / OpenAI / OpenRouter and paste the key
```

or set an env var (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …) before
launching.

## 4. Create a project directory with the plugin config

Each of you makes an empty folder anywhere (your "workspace") containing an
`opencode.json` — plugin paths are absolute, ports differ per machine:

**Person A (`~/a2a-b/opencode.json`):**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["<absolute-path-to>/opencode-f26-wild_pointer/packages/plugin-a2a", {
      "a2a": {
        "enabled": true,
        "listenPort": 4322,
        "name": "agent-a",
        "model": "openrouter/anthropic/claude-sonnet-4.5",
        "allowedPeers": { "agent-b": "http://<PEER_B_IP>:4322" },
        "maxTurns": 4
      }
    }]
  ]
}
```

**Person B** — mirror image: `name: "agent-b"`, and `allowedPeers` points at
A's IP.

Swap in real LAN/public IPs (`ipconfig` / `ip addr`). Different ports are fine
as long as `allowedPeers` uses the right ones.

## 5. Open the firewall

`listenPort` must be reachable inbound:

```powershell
# Windows (admin PowerShell)
New-NetFirewallRule -DisplayName "opencode-a2a" -Direction Inbound -LocalPort 4322 -Protocol TCP -Action Allow
```

```sh
# Linux
sudo ufw allow 4322/tcp
```

On different networks, the `0.0.0.0` bind still can't cross NAT — use a tunnel
(`ngrok http 4322`) and put the tunnel URL in `allowedPeers`, or run on the
same LAN.

## 6. Start opencode in that directory

```sh
cd ~/a2a-b
bun run --conditions=browser <path-to>/packages/opencode/src/index.ts serve --port 4096
```

Then **bootstrap the project** (plugins load lazily in serve mode — required
once per server start):

```sh
curl "http://localhost:4096/config?directory=<URL-encoded-abs-path-to-your-project>"
curl http://localhost:4322/.well-known/agent-card.json   # should return JSON
```

Alternative: run without `serve` for the interactive TUI — it bootstraps
automatically, no curl needed.

## 7. Send the first message

In the TUI, prompt something like:

> Use the `a2a_ask` tool to send "Resolved: spaces beat tabs" to peer `agent-b`.

The model calls `a2a_ask({ peer: "agent-b", message: "..." })` → task created
on the peer → its reply comes back in the same call. Follow-ups reuse the
`taskId` from the result.

Or bypass the TUI with the demo scripts (works from either side):

```sh
cd <repo>/packages/plugin-a2a
bun run demo/debate.ts --peer http://<PEER_IP>:4322 --name agent-a   # full 4-turn debate
py -3 demo/peer-check.py http://<PEER_IP>:4322                      # Python sanity check
```

## 8. Verify

```sh
# the task, with both speakers' messages
curl -X POST http://localhost:4322/ -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tasks/get","params":{"id":"<taskId>"}}'
```

A four-turn debate ends `TASK_STATE_COMPLETED` with a `verdict` artifact
containing the final reply. `tasks/cancel` aborts the running session for that
task on the peer's side.

## Troubleshooting

- **`Connection refused` on the A2A port** — the server isn't running, or the
  project wasn't bootstrapped this session (step 6's `curl /config` is
  required after every serve restart). With the TUI this step is automatic.
- **Task goes `TASK_STATE_FAILED` with `APIError: Invalid API key`** — the
  session resolved the wrong credential. Pin `"model"` to a provider you have
  a key for (step 4) and restart the server.
- **`a2a_ask` refuses the peer** — the peer id isn't in `allowedPeers`, or the
  URL doesn't match exactly (including port and scheme).
- **Silent timeout** — firewall/NAT; verify with
  `curl http://<peer-ip>:4322/.well-known/agent-card.json` from the *other*
  machine.
