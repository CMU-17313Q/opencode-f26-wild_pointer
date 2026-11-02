# ESLint (type-aware), local baseline

Date 2026-11-02, Ubuntu x86_64, Bun 1.3.14, branch `ci/eslint` cut from `main` @ a305b55.

## Tool and version

ESLint 9.39.1 with typescript-eslint 8.46.4 and @eslint/js 9.39.1, all pinned as
root devDependencies in `package.json` and `bun.lock`. The flat config in
`eslint.config.js` extends `js.configs.recommended`, `tseslint.configs.recommended`
and `tseslint.configs.recommendedTypeChecked` with `projectService: true`, so each
file is checked against its own package `tsconfig.json`.

Ignored paths are `**/dist`, `**/src/generated*`, `*.gen.ts`, `**/*.d.ts`, test and
e2e fixtures, and `packages/plugin-a2a/demo`.

## Exact commands

The workflow runs the same commands.

```
bunx eslint --version > ci-evidence/eslint/version.txt
bunx eslint -f json -o ci-evidence/eslint/report.json packages/a2a/src packages/plugin-a2a/src
bunx eslint packages/a2a/src packages/plugin-a2a/src > ci-evidence/eslint/eslint.log 2>&1
```

Absolute paths in the committed log and report were rewritten to repo-relative paths.

## Scope

The design doc scope is `packages/*/src`. Running the same config over all 27
`packages/*/src` directories ran out of memory after about 80 seconds at Node's
default 4 GB heap (`full-scope-oom.log`). That is before any backlog triage, so the
check is narrowed to `packages/a2a` and `packages/plugin-a2a`, the packages our
team owns. That run takes about 5 seconds.

## Results

21 files linted, 17 errors, 0 warnings, exit code 1.

| Rule                                                | Count |
| --------------------------------------------------- | ----- |
| `@typescript-eslint/require-await`                  | 6     |
| `@typescript-eslint/no-unsafe-assignment`           | 3     |
| `@typescript-eslint/prefer-promise-reject-errors`   | 3     |
| `@typescript-eslint/no-redundant-type-constituents` | 1     |
| `@typescript-eslint/no-floating-promises`           | 1     |
| `prefer-const`                                      | 1     |
| `@typescript-eslint/no-misused-promises`            | 1     |
| `@typescript-eslint/no-unused-vars`                 | 1     |

The two rules this check exists for both fire. `no-floating-promises` flags an
un-awaited call in `plugin-a2a/src/admin.ts:62`, and `no-misused-promises` flags an
async callback passed where a void return is expected in `plugin-a2a/src/inbound.ts:207`.

## Rollout

The job is report-only. Exit code 1 (lint errors) is logged as a warning and the job
has `continue-on-error: true`. Exit code 2 (bad config or crash) or a report with
zero files still fails the job. Once the 17 errors above are fixed or suppressed,
remove the exit-code check so `error` findings block PRs.
