# ADR: Switch to pnpm for Package Management

## Context

The project encountered significant issues with the SQLite adapter when using Yarn PnP. Specifically, the SQLite adapter required node module linking, which resulted in significantly slower performance. Additionally, we wanted a more performant and strict dependency manager to address these challenges.

## Decision

We will use pnpm as the primary package manager for this repository. All developers and CI pipelines will install/run dependencies via pnpm. The lockfile (`pnpm-lock.yaml`) will be checked in and considered the source of truth for reproducible installs.

## Consequences

- Faster installs: pnpm's content-addressable store and node modules layout reduces time to install dependencies compared to some other managers.
- Reduced disk usage: pnpm stores packages in a global content-addressable store, which lowers disk footprint across projects.
- Stricter dependency resolution: pnpm enforces declared dependencies (prevents accidental reliance on transitive/hoisted packages), which reduces "phantom dependency" bugs.
- Migration work: CI workflows and developer docs must be updated to call `pnpm` instead of other package managers; developers must ensure pnpm is available (via Corepack or direct install).
- Potential compatibility issues: Some tooling or packages that assume a flat `node_modules` layout may require adjustments or specific pnpm configuration (e.g., `public-hoist-pattern`)—these will be handled on a case-by-case basis.

## Implementation / Migration Notes

- Update CI workflow(s) to install or enable pnpm (via Corepack or `pnpm/action-setup`) and use `pnpm install` and `pnpm -w` workspace commands where appropriate.
- Ensure `pnpm-lock.yaml` is committed and that `packageManager` field in `package.json` (if present) references the chosen pnpm version (optional but recommended).

## Alternatives Considered

- Continue using Yarn v4: rejected due to performance issues with the SQLite adapter and the inefficiency of node module linking in our setup.
- Use npm: considered but not chosen because pnpm offered better performance and stricter dependency guarantees which align with our goals.

