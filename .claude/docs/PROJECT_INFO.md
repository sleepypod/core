# SleepyPod Core - Project Information

## Overview

Modern, type-safe local control system for Eight Sleep Pods (3/4/5). Complete rewrite of free-sleep with focus on maintainability, type safety, and decoupled logic.

## Tech Stack

- **Frontend**: Next.js 16, React 19, TailwindCSS, tRPC
- **Backend**: Node.js, tRPC, Drizzle ORM
- **Database**: SQLite with WAL mode
- **Hardware**: Unix socket (dac.sock) communication
- **Scheduling**: node-schedule with timezone support
- **i18n**: Lingui
- **Testing**: Vitest
- **Deployment**: Systemd service on embedded Linux

## Architecture

```
Hardware Layer (src/hardware/)
    ↓
Database Layer (src/db/)
    ↓
API Layer (src/server/routers/)
    ↓
Business Logic (src/scheduler/)
    ↓
UI Layer (app/[lang]/)
```

## Key Decisions (ADRs)

See `docs/adr/` for all architectural decisions:

- **0010-drizzle-orm-sqlite.md**: Why Drizzle over Prisma
- **0005-trpc.md**: Type-safe API without codegen
- **0004-nextjs-unified.md**: Why Next.js 16
- **0009-linguijs.md**: i18n approach
- **0011-switch-to-pnpm.md**: Package manager

## Project Structure

```
sleepypod-core/
├── app/[lang]/           # Next.js pages (i18n routing)
├── src/
│   ├── components/      # React UI components
│   ├── db/              # Drizzle schema & migrations
│   ├── hardware/        # Pod hardware abstraction
│   ├── scheduler/       # Job scheduling system
│   └── server/routers/  # tRPC API endpoints
├── scripts/             # Deployment scripts
└── docs/adr/            # Architecture Decision Records
```

## Database Schema (11 tables)

- `device_settings` - Global configuration
- `side_settings` - Per-side configuration
- `tap_gestures` - Tap gesture actions
- `temperature_schedules` - Temperature automation
- `power_schedules` - Power automation
- `alarm_schedules` - Wake-up automation
- `device_state` - Runtime state
- `sleep_records` - Sleep session data
- `vitals` - Heart rate, HRV, breathing
- `movement` - Movement tracking
- `system_health` - Service monitoring

## Development Workflow

```bash
# Setup
pnpm install
pnpm db:push

# Development
pnpm dev              # Start Next.js dev server
pnpm lint:fix         # Fix linting issues
pnpm tsc              # Type check

# Database
pnpm db:generate      # Generate migration
pnpm db:push          # Apply schema changes
pnpm db:studio        # Open Drizzle Studio

# i18n
pnpm lingui:extract   # Extract translatable strings
```

## Deployment (On Pod)

```bash
curl -fsSL https://raw.githubusercontent.com/sleepypod/core/main/scripts/install.sh | sudo bash
```

## CLI Commands (On Pod)

- `sp-status` - View service status
- `sp-restart` - Restart service
- `sp-logs` - View live logs
- `sp-update` - Update to latest version

## Environment Variables

```env
DATABASE_URL=file:/persistent/sleepypod-data/sleepypod.db
DAC_SOCK_PATH=/run/dac.sock
NODE_ENV=production
```

## Feature Branches

All features developed in isolated branches:

- `feat/drizzle-database-setup` - Database layer
- `feat/hardware-abstraction-layer` - Hardware communication
- `feat/trpc-routers` - API layer
- `feat/job-scheduler` - Automation engine
- `feat/frontend-ui` - User interface
- `feat/installation-scripts` - Deployment tools

## Testing

See `TESTING_GUIDE.md` for comprehensive testing instructions.

Quick local test:
```bash
pnpm install
pnpm db:push
pnpm dev
# Open http://localhost:3000
```

## Code Style

- TypeScript strict mode
- ESLint with Next.js config
- Conventional Commits
- 2 space indentation
- No semicolons

## Git Workflow

1. Create feature branch from `dev`
2. Make changes with conventional commits
3. Create PR to `dev`
4. Squash merge after approval

## Supported Hardware

- ✅ Pod 3 (no SD card) - FCC ID: 2AYXT61100001
- ✅ Pod 4
- ✅ Pod 5
- ❌ Pod 1/2 - Not compatible

## Related Resources

- Original: [free-sleep](https://github.com/throwaway31265/free-sleep)
- Docs: See `README.md`, `IMPLEMENTATION_SUMMARY.md`, `TESTING_GUIDE.md`
- ADRs: `docs/adr/`

## Status

**Core system complete** - 6/8 tasks done. Ready for testing and deployment.

Remaining:
- Biometrics integration (future)
- i18n string extraction (5min task)
