# CI Checks - Run Locally Before Pushing

This document describes the continuous integration (CI) checks that run on every pull request, and how to run them locally to catch issues before pushing.

## Overview

Our GitHub Actions CI workflow runs three checks on every PR. You should run all of these locally before pushing to ensure your changes will pass CI.

## The Three Checks

### 1. Lint
Checks code style and catches common errors using ESLint.

```bash
pnpm lint
```

**What it checks:**
- Code style violations
- Unused variables
- Import/export issues
- JSX formatting
- TypeScript ESLint rules

**Auto-fix many issues:**
```bash
pnpm lint --fix
```

### 2. TypeScript Type Check
Verifies all TypeScript types are correct.

```bash
pnpm tsc
```

**What it checks:**
- Type errors
- Missing types
- Incorrect type usage
- JSX type issues
- Module resolution

**Note:** This runs `tsc --noEmit`, so it only checks types without generating output files.

### 3. Unit Tests
Runs all unit tests with coverage reporting.

```bash
pnpm test run --coverage --passWithNoTests
```

**What it checks:**
- All test files pass
- Code coverage meets thresholds
- No test failures or errors

**For development (watch mode):**
```bash
pnpm test
```

## Run All Checks at Once

To run all three checks sequentially (mimicking CI):

```bash
pnpm lint && pnpm tsc && pnpm test run --coverage --passWithNoTests
```

Or create a convenient npm script in `package.json`:

```json
{
  "scripts": {
    "ci": "pnpm lint && pnpm tsc && pnpm test run --coverage --passWithNoTests"
  }
}
```

Then run:
```bash
pnpm ci
```

## Pre-Push Checklist

Before pushing commits or creating a PR, verify:

- [ ] `pnpm lint` passes (or run with `--fix` to auto-fix)
- [ ] `pnpm tsc` passes with no type errors
- [ ] `pnpm test run --coverage --passWithNoTests` passes
- [ ] All files are properly formatted
- [ ] No uncommitted changes (unless intentional)

## Common Issues and Fixes

### Lint Failures

**Problem:** ESLint errors block CI
```
error: 'foo' is assigned a value but never used (@typescript-eslint/no-unused-vars)
```

**Fix:** Either use the variable or remove it. Run `pnpm lint --fix` for auto-fixable issues.

### TypeScript Errors

**Problem:** Type check fails
```
error TS2503: Cannot find namespace 'JSX'.
```

**Fix:**
- Ensure proper imports (e.g., React for JSX)
- Remove explicit type annotations if TypeScript can infer
- Add missing type definitions

### Test Failures

**Problem:** Tests fail locally but you're not sure why

**Fix:**
```bash
# Run tests in watch mode to debug
pnpm test

# Run specific test file
pnpm test path/to/test.spec.ts

# Run with verbose output
pnpm test run --reporter=verbose
```

## CI Configuration

The actual CI configuration is in `.github/workflows/test.yml`:

```yaml
matrix:
  task:
    - { name: "Lint", cmd: "pnpm lint" }
    - { name: "Typecheck", cmd: "pnpm tsc" }
    - { name: "Unit Tests", cmd: "pnpm test run --coverage --passWithNoTests" }
```

**Important:** Always keep your local checks in sync with the CI configuration. If the CI commands change, update this document and your local workflow.

## Git Hooks (Optional)

Consider setting up git hooks to automatically run checks:

### Pre-commit Hook
Run lint and type check before allowing commits:

```bash
# .git/hooks/pre-commit
#!/bin/sh
pnpm lint && pnpm tsc
```

### Pre-push Hook
Run all checks before pushing:

```bash
# .git/hooks/pre-push
#!/bin/sh
pnpm lint && pnpm tsc && pnpm test run --coverage --passWithNoTests
```

Make hooks executable:
```bash
chmod +x .git/hooks/pre-commit
chmod +x .git/hooks/pre-push
```

## Troubleshooting

### "Command not found: pnpm"

Install pnpm globally:
```bash
npm install -g pnpm
```

Or use corepack (Node 16.9+):
```bash
corepack enable
```

### Cache Issues

If experiencing strange errors, clear caches:

```bash
# Clear pnpm cache
pnpm store prune

# Clear Next.js cache
rm -rf .next

# Clear test cache
rm -rf .vitest

# Reinstall dependencies
rm -rf node_modules
pnpm install
```

### CI Passes but Local Fails (or vice versa)

Ensure you're on the same Node version as CI:

```bash
# Check your Node version
node --version

# CI uses "lts/*" - update if needed
nvm use --lts
```

## Best Practices

1. **Run checks frequently** - Don't wait until you're ready to push
2. **Fix issues immediately** - Don't let them accumulate
3. **Use watch mode during development** - Catch issues in real-time
4. **Keep dependencies updated** - Outdated deps can cause check failures
5. **Review CI logs** - When CI fails, read the full error message

## Related Documentation

- [Contributing Guidelines](../../CONTRIBUTING.md)
- [PR Review Process](.claude/docs/PR_REVIEW_PROCESS.md)
- [Git Workflow](.claude/docs/GIT_WORKFLOW.md)

## Summary

**Before every push:**
```bash
pnpm lint && pnpm tsc && pnpm test run --coverage --passWithNoTests
```

**Keep these commands in sync with `.github/workflows/test.yml`**

This ensures your PR will pass CI checks and saves time in the review process! ✅
