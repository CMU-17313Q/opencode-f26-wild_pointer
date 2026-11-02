# Stryker mutation testing: local baseline (evidence)

Date: 2026-11-02 · Host: Ubuntu 22.04 on WSL2 (12 threads) · Repo state: `main` @ 38acd04

## Tool and version

- `@stryker-mutator/core` 10.1.1, pinned as a root devDependency
- Bun 1.3.14 (the repo's `packageManager`), Node 22.23.2 locally; CI uses Node 24

## Exact commands

Run from each package directory, because the root `bunfig.toml` blocks `bun test`:

```
cd packages/a2a        && ../../node_modules/.bin/stryker run
cd packages/plugin-a2a && ../../node_modules/.bin/stryker run
```

## Results

| Package               | Mutants | Killed | Timeout | Survived | Score  | `break` | Time    |
| --------------------- | ------- | ------ | ------- | -------- | ------ | ------- | ------- |
| `packages/a2a`        | 525     | 359    | 33      | 133      | 74.67% | 70      | 50 s    |
| `packages/plugin-a2a` | 2200    | 1371   | 92      | 737      | 66.50% | 60      | 16m 16s |

Files here:

- `<package>/score.txt`: Stryker's clear-text score table
- `<package>/mutation.json`: Stryker's JSON report

The committed JSON omits each mutant's `statusReason` (captured `bun test` output, about
95% of the raw size) and `projectRoot` (a local path). Statuses, locations and sources are
unchanged. Every Actions run uploads the untrimmed report and the HTML report as the
`mutation-report-<attempt>` artifact.

## Measured behaviour worth knowing

**Excluded test.** `plugin-a2a/test/tui-panel.test.tsx` imports `../../tui/...`, which does
not resolve from Stryker's sandbox (`.stryker-tmp/sandbox-X/test/`), so it is listed in
`ignorePatterns`. It covers `src/tui.tsx`, which is not mutated. Removing it also takes the
suite from about 5 s to about 1.7 s per mutant. To measure the cost, the 101 survivors in
the three mutated files it touches (`control.ts`, `format.ts`, `config.ts`) were re-run with
the test included: 9 flip to killed. The true score is about 66.91%, so the reported 66.50%
is slightly pessimistic.

**Incremental mode cannot see test changes.** The command runner reports one opaque
"All tests" result. With `a2a/test/events.test.ts` deleted, an incremental run reused
525 of 525 results and reported `events.ts` at 100%; a forced run reported 0% (package score
74.10%, not 74.67%). The workflow therefore keys each cache on the package's test files and
Stryker config, and plugin-a2a's key also includes `packages/a2a/src`. A source-only change
works as intended: adding one line reused 525 of 526 results.

Remaining gap: incremental mode only re-tests mutants in changed code, so a mutant in an
unchanged file can keep a stale result when a different source file in that package changes.
The nightly `--force` run corrects this.

**Stability.** Re-running `packages/a2a` at concurrency 3 (like CI) instead of 11 kept the
score at 74.67%. Seven mutants moved from Timeout to Killed, both of which count as detected;
none moved between detected and survived.

**Gate.** With `break` temporarily set to 99, `stryker run | tee` under `bash -eo pipefail`
exited 1. With the committed `break` it exited 0.
