# ci checks

Run before every push:

```bash
pnpm lint && pnpm tsc && pnpm test run --coverage --passWithNoTests
```

## individual checks

```bash
pnpm lint          # ESLint - auto-fix with --fix
pnpm tsc           # TypeScript type check
pnpm test          # Vitest tests (watch mode for dev)
```

## what to verify

- No lint errors
- No type errors
- All tests passing
- No uncommitted changes (unless intentional)
