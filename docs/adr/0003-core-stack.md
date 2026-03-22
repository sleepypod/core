# ADR: Core Application Stack

**Status**: Accepted
**Date**: 2026-02-23

## Context

sleepypod is a Next.js application targeting embedded Linux hardware. The core stack choices needed to satisfy:

- Strong type safety across the full stack (hardware ↔ server ↔ UI)
- A single language (TypeScript) from hardware client through to the browser
- Minimal runtime overhead on constrained ARM hardware
- i18n support from day one without significant refactoring later

## Decisions

### TypeScript

TypeScript is the sole language for all application code. The hardware client, scheduler, tRPC routers, database schema, and React components share a single type system with no runtime boundaries where types are lost.

Strict mode is enabled. This aligns with free-sleep's codebase style and catches errors that would otherwise surface only on-device.

### React

React is the UI library. It is the natural pairing for Next.js and the dominant choice in the TypeScript ecosystem. The component model maps cleanly to the pod's UI surfaces (side selector, temperature control, schedule editor).

No alternative was seriously evaluated — the Next.js choice (see ADR 0004) implies React.

### Lingui for i18n

[Lingui](https://lingui.js.org/) is used for internationalisation rather than `next-i18next` or `react-intl`.

**Why Lingui:**
- Macro-based extraction (`<Trans>`, `t()`) keeps translation keys co-located with source code
- Works with the Next.js App Router without additional configuration
- Smaller runtime than react-intl; no separate key file to keep in sync with usage
- Supports pluralisation and number/date formatting via ICU message format

i18n is set up from the start because retrofitting it into an existing app requires touching every user-facing string. The cost of including it early is low; the cost of adding it later is high.

## Consequences

- All application code is TypeScript — no JavaScript files except config where required by tooling
- Lingui extraction (`pnpm lingui:extract`) must be run when new user-facing strings are added
- React 19 and the Next.js App Router are the baseline; older patterns (pages router, class components) are not used

## References

- [Lingui documentation](https://lingui.js.org/introduction.html)
- [TypeScript strict mode](https://www.typescriptlang.org/tsconfig/#strict)

---

**Authors**: @ng
**Last Updated**: 2026-02-23
