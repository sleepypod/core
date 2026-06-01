# Architecture and Stack

Core technology decisions for sleepypod-core — a full-stack TypeScript application targeting embedded Linux hardware.

## Why a Separate Repository

sleepypod-core lives in its own repository rather than as a fork or branch of free-sleep. The upstream project favors small, incremental, narrowly-scoped changes reviewed by a single maintainer with limited time. sleepypod's changes are designed, tested, and validated together as a cohesive system — reviewing them piecemeal would be higher risk than reviewing them as a complete working system.

A separate repository makes the boundary explicit, sets accurate expectations, and allows an independent roadmap and release cadence.

## Core Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript (strict) | Single type system from [[hardware-protocol]] client through to browser |
| UI | React 19 (App Router) | Component model maps to pod UI surfaces |
| Framework | Next.js | Unified frontend + backend, SSR/SSG, built-in API routing |
| API | tRPC | End-to-end type safety, no manual client generation. See [[api-architecture]] |
| Database | Drizzle ORM + SQLite | 30KB runtime, no code generation, SQL-transparent. See below |
| i18n | Lingui | Macro-based extraction, works with App Router, smaller than react-intl |

## Drizzle ORM + SQLite

SQLite is ideal for the Pod's single-node embedded environment — file-based, no separate server, minimal operational complexity. Drizzle was chosen over Prisma (10MB+ binary, too heavy for embedded), raw better-sqlite3 (no type safety), TypeORM (decorator-based, heavier), and Kysely (close second, but Drizzle has better schema management).

Key configuration:
- **WAL mode** for concurrent reads during writes
- **`synchronous = NORMAL`** for performance
- **64MB cache** via `cache_size = -64000`
- **Memory-mapped I/O** via `mmap_size`

Schema is defined in TypeScript (`src/db/schema.ts`) with types inferred directly — no code generation step. Migrations are SQL-based in `src/db/migrations/`, auto-run on server startup.

The [[biometrics-system]] uses a separate `biometrics.db` file with different access patterns (append-heavy vs. read-heavy).

## Developer Tooling

| Tool | Purpose |
|------|---------|
| **ESLint** | `typescript-eslint` strict mode + `@stylistic` for formatting (no Prettier) |
| **Vitest** | Test runner — shares Vite config with Next.js build, native ESM support |
| **pnpm** | Package manager — content-addressable store for Pod's limited storage |
| **Conventional Commits** | `feat:`, `fix:`, `chore:` — drives automated versioning via semantic-release |

Flat ESLint config (`eslint.config.js`). Tests via `pnpm test`, linting via `pnpm lint`. Merges to `main` trigger automated release if conventional commits are present.

## Sources

- `docs/adr/0001-new-repository.md`
- `docs/adr/0003-core-stack.md`
- `docs/adr/0003-typescript-react.md`
- `docs/adr/0004-nextjs-unified.md`
- `docs/adr/0005-trpc.md`
- `docs/adr/0006-developer-tooling.md`
- `docs/adr/0006-eslint.md`
- `docs/adr/0010-drizzle-orm-sqlite.md`
