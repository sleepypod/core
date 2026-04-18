# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_

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
