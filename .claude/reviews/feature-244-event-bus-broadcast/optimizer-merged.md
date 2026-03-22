# Optimizer Findings (Merged) — feature/244-event-bus-broadcast

## Summary

This branch implements issue #244: `broadcastMutationStatus()` pushes `deviceStatus` frames to all WS clients immediately after tRPC mutations and scheduler jobs succeed, reducing cross-client latency from ~30s to ~200ms. It removes the dead `claim_processing`/`processingState`/`activeClient` protocol, making the WebSocket a pure read-only pub/sub channel. As a secondary change, frame normalization was extracted into a shared `normalizeFrame.ts` module.

## Findings

### Finding 1: Duplicate normalizeFrame logic — server and client diverge
- **File**: `src/streaming/piezoStream.ts`:248-380 and `src/streaming/normalizeFrame.ts`:1-182
- **Severity**: 🟡 Major
- **Category**: Architecture
- **Flagged by**: Both (Opus explicit, Sonnet as pre-existing)
- **Problem**: `piezoStream.ts` retains its own full copy of normalization functions while a new shared `normalizeFrame.ts` was extracted for the browser client. The two have already diverged.
- **Suggested fix**: Have `piezoStream.ts` import from `./normalizeFrame` and delete the duplicate.

### Finding 2: frzTherm normalization produces different values on server vs client
- **File**: `src/streaming/normalizeFrame.ts`:157-165 vs `src/streaming/piezoStream.ts`:331-345
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Flagged by**: Opus only
- **Problem**: Client extracts `wire.left.power` for frzTherm; server extracts `left.pumpDuty ?? left.duty ?? rec.left`. For firmware `{ left: { power: -0.563 } }`, client returns `-0.563`, server returns `0`.
- **Suggested fix**: Decide canonical field, consolidate into single implementation.

### Finding 3: Server-side normalizeFrame in piezoStream.ts is untested
- **File**: `src/streaming/piezoStream.ts`:365-380
- **Severity**: 🟡 Major
- **Category**: Testing
- **Flagged by**: Opus only
- **Problem**: Tests only cover the client-side `normalizeFrame.ts`. The server-side copy (which feeds iOS and M5 clients) has zero test coverage.
- **Suggested fix**: Consolidate into one implementation (Finding 1), or add separate server tests.

### Finding 4: No test coverage for broadcastMutationStatus
- **File**: `src/streaming/broadcastMutationStatus.ts`
- **Severity**: 🟢 Minor
- **Category**: Testing
- **Flagged by**: Both
- **Problem**: Core new function called from 5 mutation endpoints + 4 scheduler jobs. No unit tests. The `targetLevel: undefined` bug (fixed in d5cee55) would have been caught.
- **Suggested fix**: Add tests mocking `getDacMonitorIfRunning`, `broadcastFrame`, `getAlarmState` to verify overlay, skip-when-null, and frame shape.

### Finding 5: broadcastMutationStatus silently swallows all errors
- **File**: `src/streaming/broadcastMutationStatus.ts`:52-54
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Flagged by**: Opus (Sonnet mentioned indirectly)
- **Problem**: Empty `catch {}`. Programming errors are invisible.
- **Suggested fix**: Add `console.warn('[broadcastMutationStatus]', e)` — preserves fire-and-forget while making failures visible in logs.

### Finding 6: getAlarmState does synchronous SQLite read on broadcast hot path
- **File**: `src/streaming/broadcastMutationStatus.ts`:28
- **Severity**: 🟡 Major
- **Category**: Performance
- **Flagged by**: Sonnet only
- **Problem**: `getAlarmState()` reads from SQLite synchronously on every broadcast call — a latency concern on embedded hardware.
- **Suggested fix**: Cache alarm state in memory (updated by DeviceStateSync events) instead of reading DB on every broadcast.

### Finding 7: schedulePowerOn omits targetLevel from overlay
- **File**: `src/scheduler/jobManager.ts` (schedulePowerOn callback)
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Flagged by**: Sonnet only
- **Problem**: Clients using `targetLevel !== 0` to determine powered-on state will see stale data for up to 2s after a scheduled power-on.
- **Suggested fix**: Include `targetLevel` in the overlay, mirroring how `setPower` in the device router handles it.

### Finding 8: startPriming mutation doesn't broadcast
- **File**: `src/server/routers/device.ts` (startPriming)
- **Severity**: 🟢 Minor
- **Category**: Completeness
- **Flagged by**: Sonnet only
- **Problem**: `startPriming()` doesn't call `broadcastMutationStatus()`. Clients won't see priming state until the next DacMonitor poll (up to 2s).
- **Suggested fix**: Add `broadcastMutationStatus()` after `startPriming()` succeeds.

### Finding 9: sideOverlay typed as Record<string, unknown> — no compile-time safety
- **File**: `src/streaming/broadcastMutationStatus.ts`:21
- **Severity**: 🟢 Minor
- **Category**: Type Safety
- **Flagged by**: Sonnet only
- **Problem**: Any field name can be passed, no type enforcement.
- **Suggested fix**: Define a `SideOverlay` type with optional fields matching `SideStatus`.

### Finding 10: Stale ClaimedMessage/ReleasedMessage types remain
- **File**: `src/hooks/useSensorStream.ts`
- **Severity**: ⚪ Nit
- **Category**: Pattern
- **Flagged by**: Sonnet only
- **Problem**: Dead types from removed claim_processing protocol still in the union type.
- **Suggested fix**: Remove them.

### Finding 11: Import pattern inconsistencies
- **File**: `src/hardware/dacMonitor.instance.ts`:203,228 and `src/streaming/broadcastMutationStatus.ts`:13
- **Severity**: ⚪ Nit
- **Category**: Pattern
- **Flagged by**: Opus only
- **Problem**: dacMonitor uses `../streaming/piezoStream` (relative cross-module, against convention). broadcastMutationStatus uses `@/src/streaming/piezoStream` for same-directory import (should be `./piezoStream`).
- **Suggested fix**: Fix both per import-patterns.md. Note: `../` was used to fix CI test resolution — may need a different vitest fix.

### Finding 12: setPower broadcast omits targetTemperature when powering on without explicit temp
- **File**: `src/server/routers/device.ts`:278-281
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Flagged by**: Opus only
- **Problem**: Hardware defaults to 75F but broadcast overlay doesn't include it. 2s poll corrects.
- **Suggested fix**: `targetTemperature: input.temperature ?? 75` in overlay.

### Finding 13: frameIndex grows unbounded within a RAW file
- **File**: `src/streaming/piezoStream.ts`
- **Severity**: 🟣 Pre-existing
- **Category**: Performance
- **Flagged by**: Sonnet only
- **Problem**: No cap on `frameIndex` array size. Long-running sessions could accumulate millions of entries.

## Statistics
- Total findings: 13
- 🔴 Critical: 0
- 🟡 Major: 5 (Findings 1-3, 6-7)
- 🟢 Minor: 4 (Findings 4-5, 8-9)
- ⚪ Nit: 3 (Findings 10-12)
- 🟣 Pre-existing: 1 (Finding 13)

## Model Agreement
- **Both models flagged**: Findings 1, 4 (high confidence)
- **Opus only**: Findings 2, 3, 5, 11, 12
- **Sonnet only**: Findings 6, 7, 8, 9, 10, 13
