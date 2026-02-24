# ADR: Developer Tooling

**Status**: Accepted
**Date**: 2026-02-23

## Context

Consistent tooling for linting, testing, and commit conventions reduces friction for contributors and enables automated releases. The choices here are routine but recorded to avoid revisiting them.

## Decisions

### ESLint

ESLint with `typescript-eslint` strict mode is the linter. Stylistic rules (`@stylistic/eslint-plugin`) enforce consistent formatting without requiring a separate formatter like Prettier.

The flat config format (`eslint.config.js`) is used, as it is the current ESLint standard and avoids legacy `.eslintrc` complexity.

### Vitest

[Vitest](https://vitest.dev/) is the test runner. It shares the same Vite config as the Next.js build, meaning TypeScript paths, aliases, and transforms work in tests without additional setup. `@testing-library/react` handles component tests; `jsdom` provides the DOM environment.

Jest was not chosen — Vitest's native ESM support and Vite integration remove the module transformation boilerplate that Jest requires for a Next.js/TypeScript project.

### Conventional Commits + Semantic Release

Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) specification (`feat:`, `fix:`, `chore:`, etc.). This is enforced lightly — not via a pre-commit hook — but drives automated versioning via `semantic-release`.

`semantic-release` reads commit messages on merge to `main` and determines the next semver version, generates the changelog, and creates the release. No manual version bumping.

### pnpm

[pnpm](https://pnpm.io/) is the package manager. It was chosen over npm and Yarn because:

- Content-addressable store reduces disk usage on the Pod's limited storage
- Strict dependency resolution prevents phantom dependency bugs
- Native support for `packageManager` field in `package.json` (Corepack)

The `pnpm-lock.yaml` lockfile is committed and is the source of truth for reproducible installs.

## Consequences

- `pnpm` must be available in CI and on contributor machines (via Corepack: `corepack enable`)
- All tests run via `pnpm test`; linting via `pnpm lint` / `pnpm lint:fix`
- Merges to `main` trigger an automated release if conventional commit messages are present

## References

- [Vitest documentation](https://vitest.dev/)
- [Conventional Commits specification](https://www.conventionalcommits.org/)
- [semantic-release](https://semantic-release.gitbook.io/)
- [pnpm](https://pnpm.io/)

---

**Authors**: @ng
**Last Updated**: 2026-02-23
