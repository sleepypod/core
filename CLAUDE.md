# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Build & Test

```bash
pnpm install            # deps (pnpm workspace)
pnpm dev                # Next.js dev server
pnpm build              # production build (standalone output)
pnpm tsc                # type-check (quality gate)
pnpm lint               # eslint (quality gate)
pnpm test               # vitest unit suite (quality gate)
pnpm test:mutation      # Stryker mutation testing (slow; CI tracks score)

# Python modules (each modules/<name>/ is a uv project):
cd modules/<name> && uv run --with pytest pytest test_main.py
# Use the module's locked deps (uv run), NOT an ad-hoc venv — unpinned
# numpy/scipy versions change signal-processing results.
```

Quality gates (`pnpm tsc && pnpm lint && pnpm test`) also run in the pre-push
hook. CI runs the Python module matrix in
`.github/workflows/python-modules.yml`.

## Architecture Overview

Next.js (App Router) server that runs ON the pod and controls it:

- `src/hardware/` — DAC transport over Unix socket to frankenfirmware
  (`dacTransport.ts` prod server-mode, `socketClient.ts` dev client-mode),
  `dacMonitor` status polling, gesture detection, pump-stall guard, snooze.
- `src/server/` — tRPC routers (also exposed REST-style via trpc-to-openapi
  at `/api/*`). **No auth: LAN-only trust model** — see `openapi.ts`.
- `src/scheduler/` — node-schedule JobManager (temperature/power/alarm
  schedules from sleepypod.db plus prime/reboot/LED/run-once system jobs).
- `src/automation/` — Autopilot engine: signal-driven rules with tick /
  timeOfDay / signalChange triggers, evaluated in the device timezone.
- `src/streaming/` — WebSocket sensor stream on port 3001 (`piezoStream`),
  frame normalization, optional MQTT bridge (Home Assistant discovery).
- `src/homekit/` — HAP bridge (thermostat, power/snooze switches, sensors);
  hardware writes serialize through `sideController` + `sideLock`.
- `src/db/` — two SQLite DBs via drizzle: `sleepypod.db` (config/state,
  `migrations/`) and `biometrics.db` (time-series, `biometrics-migrations/`);
  `retention.ts` prunes time-series tables.
- `modules/` — Python daemons reading CBOR `*.RAW` sensor files and writing
  biometrics.db: piezo-processor (vitals), sleep-detector (presence/sessions),
  environment-monitor (temps), calibrator, cover-buttons; `modules/common/`
  is their shared library.
- `app/` — routes/UI; `src/components/` + `src/hooks/` — frontend. Device
  status prefers the WS stream with tRPC HTTP fallback (`useDeviceStatus`).

Cross-cutting invariants:
- Per-side hardware writes MUST go through `withSideLock` (globalThis-backed).
- Singletons live on `globalThis` (Turbopack can duplicate module instances).
- DAC protocol has no correlation ids — commands are strictly sequential;
  never read a response you didn't just send a command for.

## Conventions & Patterns

- One commit per fix/feature; conventional-commit subjects (semantic-release).
- Vitest tests live in `tests/` dirs beside the code (`src/**/tests/*.test.ts`);
  Python tests are `modules/<name>/test_main.py` with pod-only imports stubbed
  via `sys.modules` so they run on dev machines.
- Stryker mutation testing is active — behavioral fixes need a pinning test
  or they surface as surviving mutants.
- DB schema changes: edit `src/db/*schema.ts`, then `pnpm db:generate` /
  `pnpm db:biometrics:generate`. Never hand-edit migration journals — entry
  `when` values must stay strictly increasing (enforced by a test).

## Debugging a pod

Field debugging runbook — SSH access, data paths, "biometrics not writing" and
"stalled pump" symptom flows: **`docs/DEBUGGING.md`**. The desktop diagnostics
console (`/debug`) surfaces most of these signals live.

<!-- BEGIN YGG INTEGRATION v:1 hash:a463a568 -->
## Yggdrasil Agent Coordination

This project uses **Yggdrasil** (`ygg`) for cross-session memory, resource
coordination, and issue tracking. The SessionStart, UserPromptSubmit, Stop,
PreCompact, and PreToolUse hooks are active — they auto-prime context, inject
similar past nodes, digest transcripts, and track state in Postgres. You will
see their output at the top of each session (`<!-- ygg:prime -->`) and above
each user prompt (`[ygg memory | <agent> | <age> | sim=<n>%]`).

### Quick Reference

```bash
ygg task ready                              # Unblocked tasks in the current repo
ygg task list [--all] [--status <...>]      # All tasks in this repo (or everywhere)
ygg task create "title" --kind <k> --priority <0-4>   # See priority/kind values below
ygg task claim <ref>                        # Take a task (assign + in_progress)
ygg task show <ref>                         # Full detail for <prefix>-NNN or UUID
ygg task close <ref> [--reason "..."]       # Complete a task
ygg task dep <task> <blocker>               # Record dependency
ygg remember "..."                          # Durable note; similarity retriever can surface later
```

### Task field values (important — no guessing)

- `--priority <0..4>` — **0 = critical, 1 = high, 2 = medium, 3 = low, 4 = backlog**.
  Also accepts `P0`..`P4`. Do NOT pass strings like "high" / "medium" / "low".
- `--kind <task|bug|feature|chore|epic>` — one of these five. Default is `task`.
- `--status <open|in_progress|blocked|closed>` — for filtering / transitions.
- `--label <a,b,c>` — comma-separated labels. Repeatable.
- `<ref>` is either `<prefix>-<N>` (e.g. `yggdrasil-42`) or a UUID.

Example:
```bash
ygg task create "fix migration ordering" --kind bug --priority 1 --label migrations,sqlx

ygg status                                  # See all agents' state, locks, recent activity
ygg lock acquire <resource-key>             # Lease a shared resource before editing
ygg lock release <resource-key>             # Release when done
ygg lock list                               # See outstanding locks
ygg spawn --task "..."                      # Spawn a parallel agent in a new tmux window
ygg interrupt take-over --agent <name>      # Take over / steer another agent
ygg logs --follow                           # Live event stream
```

### Rules

- **Before editing a resource another agent might touch** (shared file, branch, migration, config), acquire a lock: `ygg lock acquire <path-or-key>`. Release when done. This is Yggdrasil's core contract — bypassing it defeats the coordination layer.
- **For parallel work** that warrants its own context window, prefer `ygg spawn` over the native Task/Agent tool. Spawned agents are tracked in the DB, get their own prime context, and participate in lock/memory coordination.
- **Read `[ygg memory | ...]` injections** at the top of each user turn. They are real context from prior conversations (same or other agents) surfaced by similarity. Treat as relevant unless the content clearly refutes that.
- **Before assuming you're alone**, check `ygg status`. Other agents may hold locks or be mid-task on related work.
- **Task tracking** — use `ygg task` for anything that outlives the current session: creating work, recording dependencies, claiming, closing. Intra-turn checklists can stay in a native TodoList; cross-session work lives in `ygg task`.
- **Durable notes** — `ygg remember "..."` writes a directive node the similarity retriever will surface in future sessions (scoped to the current repo when detectable). Prefer this over scratch `.md` files.
- **Do NOT** use `bd` / beads. This project uses `ygg task` / `ygg remember` instead.

## Session Completion

Work is NOT complete until `git push` succeeds.

1. Run quality gates if code changed (tests, linters, build/type-check).
2. Release any locks you still hold (`ygg lock list` → `ygg lock release <key>`).
3. Push:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
4. If push fails, resolve and retry until it succeeds.

**Never** stop before pushing; **never** say "ready to push when you are" — you push.

## Non-Interactive Shell Commands

Some systems alias `cp`/`mv`/`rm` to interactive mode which hangs agents. Use:

```bash
cp -f src dst     mv -f src dst     rm -f file     rm -rf dir     cp -rf src dst
# scp / ssh: -o BatchMode=yes         apt-get: -y         brew: HOMEBREW_NO_AUTO_UPDATE=1
```
<!-- END YGG INTEGRATION -->
