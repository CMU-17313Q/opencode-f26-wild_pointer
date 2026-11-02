# Semgrep CE — local baseline (evidence)

Date: 2026-11-02 · Host: Fedora 44 (x86_64) · Repo state: `main` @ 38acd04

## Tool and version

- **Semgrep Community Edition 1.183.0** — the same release the workflow pins as
  `semgrep/semgrep:1.183.0`.
- Run locally through `uvx` on Python 3.12: `docker` on this host requires sudo
  (user not in the `docker` group), and running the image under sudo would leave
  root-owned files in the working tree. Same release, same rulesets.
- Rulesets: `p/typescript`, `p/nodejs`, `p/owasp-top-ten`. Metrics off.

## Exact commands

CI runs the container with the same arguments (`.github/workflows/semgrep.yml`);
locally the only difference is `uvx` instead of `docker run`.

Whole monorepo — this is the gate scope:

```
semgrep scan --config p/typescript --config p/nodejs --config p/owasp-top-ten \
  --metrics=off --json packages \
  > ci-evidence/semgrep/baseline.json 2> ci-evidence/semgrep/baseline.log
```

Packages we own, for reference:

```
semgrep scan --config p/typescript --config p/nodejs --config p/owasp-top-ten \
  --metrics=off packages/a2a packages/plugin-a2a
```

Exclusions live in `.semgrepignore` (generated code, build output, fixtures), not
in command-line flags, so local and CI scans see the same file set.

## Results

| Run | Files | Rules run | Findings | Exit |
|---|---|---|---|---|
| `packages/a2a packages/plugin-a2a` | 37 | 231 | **0** | 0 |
| `packages` (gate scope) | 5903 | 236 | **5** (3 ERROR, 2 WARNING) | 0 |

### Findings — all pre-existing, none in A2A code

| Sev | Rule | Location |
|---|---|---|
| ERROR | `dockerfile.security.missing-user-entrypoint` | `packages/opencode/Dockerfile:18` |
| ERROR | `dockerfile.security.missing-user` | `packages/stats/server/Dockerfile:32` |
| ERROR | `typescript.react.security.react-insecure-request` | `packages/opencode/test/mcp/oauth-callback.test.ts:74` |
| WARNING | `bypass-tls-verification` | `packages/console/core/drizzle.config.ts:16` |
| WARNING | `bypass-tls-verification` | `packages/stats/core/drizzle.config.ts:17` |

Two Dockerfiles run as root — real, upstream, not ours. The third ERROR is a false
positive: a test fixture making an insecure HTTP request on purpose. Neither class
is suppressed; `--baseline-commit` excludes all five on PRs, so the gate only fires
on findings a PR introduces.

## Exit-code semantics (verified)

| Command | Exit |
|---|---|
| gate scope, default (report-only) | 0 — findings reported, run green |
| gate scope + `--severity ERROR --error` | 1 — blocking works |
| A2A scope + `--severity ERROR --error` | 0 |

The workflow deliberately omits `--error` during rollout: findings are reported
while a genuine scanner failure (exit 2/3, bad config, crash) still fails the job.
Job-level `continue-on-error` was rejected for that reason — it would also mask
broken scans.

## Known limitation — 4 files partially unparsed

Semgrep 1.183.0's TypeScript parser emitted `PartialParsing` warnings for:

- `packages/core/src/util/effect-flock.ts:78`
- `packages/opencode/src/lsp/server.ts:1`
- `packages/opencode/src/server/routes/instance/httpapi/public.ts:6`
- `packages/plugin/src/tui.ts:514`

They are still scanned, but rules that need full AST coverage may miss findings
there. This is a partial false pass and must not be described as full coverage.

## Notes that affect the workflow

- **Semgrep scans git-tracked files only.** Untracked WIP and these evidence files
  are invisible to it.
- **Scope is the whole `packages/` tree, not just A2A.** The A2A-only scan finds
  nothing and would never catch anything; the monorepo takes 35 s, so narrowing
  buys nothing.
- **The workflow guards against a false pass**: if `paths.scanned` is empty the
  summarizing step fails, so a misconfigured scan cannot look clean.
- **Do not add the two root-user Dockerfile findings to `.semgrepignore`.** The
  baseline already excludes them; suppressing them would hide a future regression
  in the same files.
