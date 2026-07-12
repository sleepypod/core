---
name: mutation-week
description: Work the weekly mutation-testing hit list (issue #591) — look up the top surviving file, pull the full survivor list from CI artifacts, write killing tests, verify with a scoped Stryker run, and report back. Use when asked to "address this week's mutation testing", "work the hit list", or kill surviving mutants.
---

# Weekly mutation-testing workflow

Issue **#591** is the auto-updated tracking issue (workflow:
`.github/workflows/mutation.yml`, weekly schedule). Its body holds the score,
per-shard table, and a truncated top-50 hit list. Work happens in comments;
never edit the body.

## 1. Look up this week's target

```bash
gh issue view 591 --repo sleepypod/core --json body -q .body | head -80
```

- Note the **run id** from the "HTML reports" link and the trigger commit.
- Pick the top surviving file that has no recent comment claiming it
  (`gh issue view 591 --comments` — prior weeks' work is recorded there).

## 2. Pull the FULL survivor list (the issue shows only top 50)

Each shard uploads `mutation-report-<shard>` containing `mutation.json`:

```bash
cd $(mktemp -d)
gh run download <RUN_ID> --repo sleepypod/core -n mutation-report-<shard>
python3 <repo>/.claude/skills/mutation-week/survivors.py mutation.json <fileBasename>
```

Shard names: `hardware-lib`, `homekit`, `hooks`, `server`,
`services-scheduler`, `streaming` (see the matrix in mutation.yml).

## 3. Branch and verify staleness

- Branch off **fresh `origin/dev`** (`test/<file>-mutants-591`).
- `git diff <trigger-commit> origin/dev --stat -- <file> <its test file>` —
  if the source changed since the run, line numbers are stale; re-run scoped
  Stryker first instead of trusting the artifact.

## 4. Write killing tests

A killing test must FAIL when the mutation is applied. Expected test file is
`<dir>/tests/<name>.test.ts`. Prefer **no source changes**; if internals are
unreachable, extending an existing `__test__` export with pure functions is
the accepted pattern (see `piezoStream.ts`).

Playbook by mutator:
- `StringLiteral` in thrown errors / WS error messages → assert exact message
  content, not just `/some regex/` that an empty string can't fail.
- `StringLiteral` in `console.log/warn` → `vi.spyOn(console, ...)` and assert
  `expect.stringContaining(...)` plus exact numeric args where deterministic.
- `EqualityOperator` (`<` vs `<=`) → test the exact boundary value.
- `ConditionalExpression true/false` → one test per branch, asserting the
  branch-specific observable (message text, count, absence of a frame).
- `BlockStatement {}` on guards → assert the guarded side effect happened
  (port refuses connections after shutdown, no duplicate frames, etc.).
- `ArithmeticOperator` on buffer offsets → multi-tick scenarios (partial
  append, then seek) with exactly-once + content assertions.

## 5. Known equivalent / unkillable categories (don't chase these)

- **Module-level initializer mutants** (const config at top of file,
  `new Decoder({...})` options): activate at import; the vitest runner's
  module cache makes them false survivors. Unkillable without per-mutant
  process restart.
- Timing/perf-only values (`setTimeout` delays, yield cadence like
  `recordsSinceYield >= 500`, read-chunk sizes that only change speed).
- Double-guarded checks (a second guard downstream makes the first
  unobservable), `Math.random()` entropy, `>= 0` on sizes iterated with
  `for..of` over an empty set.

## 6. Verify — tests locally, mutation in CI

Do **NOT** run Stryker locally — mutation runs happen in CI only.

```bash
pnpm exec vitest run src/<path>/tests/<file>.test.ts
```

Then let CI produce the mutation numbers:

- **Per-PR** (preferred): apply the `mutation-test` label to the PR —
  `mutation.yml` runs on it and comments a summary.
- **Manual**: Actions → "Mutation Testing" → Run workflow, with the `scope`
  input set to the target file glob (blank = all shard defaults).
- **Weekly**: the Saturday 06:00 UTC schedule refreshes issue #591's baseline.

Pull the run's `mutation-report-<shard>` artifact and re-run `survivors.py`
on its `mutation.json` for the post-change survivor list.

## 7. Report and ship

- PR to `dev`, title `test(<area>): kill <file> surviving mutants (#591 hit list)`,
  with a test plan section.
- Comment on #591 following the established format: before → after counts,
  file score, and a line-by-line justification for each remaining survivor
  (see the mqttBridge comment for the template).
