# Optimizer Findings (Opus) — feature/244-event-bus-broadcast

## Summary

This branch implements issue #244: an event bus that broadcasts `deviceStatus` frames to all WebSocket clients immediately after tRPC mutations and scheduler jobs succeed, reducing cross-client update latency from ~30s to ~200ms. It also removes the dead `claim_processing` / `activeClient` / `processingState` protocol from the WebSocket server, client hook, and biometrics router, making the WebSocket a pure read-only pub/sub channel. As a secondary change, the frame normalization logic was extracted from `useSensorStream.ts` into a shared `normalizeFrame.ts` module with firmware wire-type interfaces and dedicated tests.

## Findings

### Finding 1: Duplicate normalizeFrame logic — server and client diverge
- **File**: `src/streaming/piezoStream.ts`:248-380 and `src/streaming/normalizeFrame.ts`:1-182
- **Severity**: 🟡 Major
- **Category**: Architecture
- **Problem**: `piezoStream.ts` retains its own full copy of the normalization functions (`normalizeBedTemp`, `normalizeFrzTemp`, `normalizeFrzHealth`, `normalizeFrzTherm`, `normalizeCapSense2`, `normalizeFrame`) along with the helper functions (`isSentinel`, `safeNum`, `cdToC`, `NO_SENSOR`). A new shared module `normalizeFrame.ts` was extracted for the browser client, but `piezoStream.ts` was never updated to import from it. The two implementations have diverged — see Finding 2.
- **Suggested fix**: Have `piezoStream.ts` import `normalizeFrame` from `./normalizeFrame` instead of maintaining its own copy. If the server needs the defensive fallback chains (to handle both old and new firmware formats), then `normalizeFrame.ts` should be updated to include those fallbacks too, and the duplicate in `piezoStream.ts` should be deleted.
- **Rationale**: Two copies of the same logic that are already divergent is a maintenance hazard. Bugs fixed in one copy won't be fixed in the other, and clients will see different normalized values for the same raw frames.

### Finding 2: frzTherm normalization produces different values on server vs client
- **File**: `src/streaming/normalizeFrame.ts`:157-165 vs `src/streaming/piezoStream.ts`:331-345
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: The client-side `normalizeFrame.ts` extracts `wire.left.power` for `frzTherm` frames (thermal control signal). The server-side `piezoStream.ts` extracts `left.pumpDuty ?? left.duty ?? rec.left` — a completely different field. For the real firmware fixture `{ left: { target: 23.76, power: -0.563, valid: true, enabled: true } }`, the client returns `-0.563` while the server returns `0` (since `pumpDuty` and `duty` are undefined, and `rec.left` is an object which `safeNum` nullifies, defaulting to 0).
- **Suggested fix**: Decide which field is semantically correct for `frzTherm` (`power` or `pumpDuty`), use it in both places, and consolidate into a single implementation (see Finding 1).
- **Rationale**: Server-side frames sent to iOS clients will have different frzTherm values than those displayed in the browser UI. The test only asserts `typeof result.left === 'number'` so it passes despite this.

### Finding 3: frzHealth normalization divergence — typed vs defensive fallback
- **File**: `src/streaming/normalizeFrame.ts`:138-155 vs `src/streaming/piezoStream.ts`:300-328
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The client `normalizeFrame.ts` casts to `WireFrzHealth` and directly accesses `wire.left.pump.rpm`. The server `piezoStream.ts` uses a fallback chain: `left.pumpRpm ?? leftPump.rpm ?? left.pump_rpm ?? left.rpm`. If firmware ever sends the already-flattened format (e.g., `{ left: { pumpRpm: 2400 } }`), the client version will crash with a TypeError (`Cannot read property 'rpm' of undefined` on `wire.left.pump.rpm`), while the server handles it gracefully.
- **Suggested fix**: Make `normalizeFrame.ts` handle both nested and pre-flattened formats, matching the server's defensive approach. Alternatively, add a guard before the typed cast.
- **Rationale**: Firmware format may vary by pod version. The typed version is fragile if it encounters unexpected shapes.

### Finding 4: frzTherm test does not assert actual values
- **File**: `src/streaming/tests/normalizeFrame.test.ts`:199-205
- **Severity**: 🟢 Minor
- **Category**: Testing
- **Problem**: The frzTherm test only asserts `typeof result.left === 'number'` and `typeof result.right === 'number'`. It does not check the actual values, so it would pass even if the normalizer returned `0` instead of the expected `-0.563` (the `power` field from the fixture).
- **Suggested fix**: Add `expect(result.left).toBeCloseTo(-0.563)` and `expect(result.right).toBe(0)` to verify the correct field is extracted.
- **Rationale**: A type-only assertion masks the divergence in Finding 2 — the test passes despite the two implementations producing different values.

### Finding 5: No test coverage for broadcastMutationStatus
- **File**: `src/streaming/broadcastMutationStatus.ts`
- **Severity**: 🟢 Minor
- **Category**: Testing
- **Problem**: `broadcastMutationStatus` is a critical new function called from all 5 device mutation endpoints and 4 scheduler job types. It has no unit tests. The fire-and-forget error swallowing (`catch {}`) means failures are completely silent.
- **Suggested fix**: Add tests that mock `getDacMonitorIfRunning`, `broadcastFrame`, `getAlarmState`, etc. to verify: (1) overlay is applied to the correct side, (2) broadcast is skipped when no lastStatus exists, (3) frame shape matches `DeviceStatusFrame` interface.
- **Rationale**: This is the core of the issue #244 implementation. A regression here means all multi-client sync breaks silently.

### Finding 6: broadcastMutationStatus silently swallows all errors
- **File**: `src/streaming/broadcastMutationStatus.ts`:52-54
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The catch block is completely empty: `catch { }`. While fire-and-forget is intentional, programming errors (e.g., calling a method on undefined due to an import issue) will be silently swallowed with zero diagnostics.
- **Suggested fix**: Add `console.warn('[broadcastMutationStatus] error:', e)` inside the catch block. This preserves fire-and-forget behavior while making failures visible in logs.
- **Rationale**: On an embedded device accessed via SSH, silent failures are especially hard to diagnose. A log line costs nothing.

### Finding 7: dacMonitor.instance.ts changed `@/` imports to `../` for cross-module paths
- **File**: `src/hardware/dacMonitor.instance.ts`:203, 228
- **Severity**: ⚪ Nit
- **Category**: Pattern
- **Problem**: Dynamic imports were changed from `import('@/src/streaming/piezoStream')` to `import('../streaming/piezoStream')`. Per `.claude/docs/import-patterns.md`, cross-module imports should use `@/` paths. The `../` pattern is reserved for tests only (one level up). `src/hardware/` to `src/streaming/` is a cross-module path.
- **Suggested fix**: Revert to `import('@/src/streaming/piezoStream')`.
- **Rationale**: Consistency with the project's documented import conventions. The new `broadcastMutationStatus.ts` in the same PR correctly uses `@/` for cross-module imports.

### Finding 8: broadcastMutationStatus.ts uses `@/` for same-directory import
- **File**: `src/streaming/broadcastMutationStatus.ts`:13
- **Severity**: ⚪ Nit
- **Category**: Pattern
- **Problem**: `import { broadcastFrame } from '@/src/streaming/piezoStream'` — both files are in `src/streaming/`, so per project conventions this should be `import { broadcastFrame } from './piezoStream'`.
- **Suggested fix**: Change to `import { broadcastFrame } from './piezoStream'`.
- **Rationale**: Import pattern doc says "Same directory? Use `./`".

### Finding 9: setPower broadcast omits targetTemperature when powering on without explicit temperature
- **File**: `src/server/routers/device.ts`:278-281
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: When `setPower(side, true)` is called without an explicit temperature, the hardware defaults to 75F internally. But the broadcast overlay is `{ ...(undefined && { targetTemperature: undefined }) }` which resolves to `{}`. Other clients will see the old `targetTemperature` from `lastStatus` until the next DacMonitor poll (up to 2s). This is technically the correct backstop behavior as documented, but differs from `setTemperature` which immediately broadcasts the new target.
- **Suggested fix**: Consider `targetTemperature: input.temperature ?? 75` in the overlay to match hardware behavior. Not critical since DacMonitor catches up within 2s.
- **Rationale**: Minor inconsistency in broadcast immediacy — temperature changes from `setTemperature` are instant, but power-on temperature is delayed by one poll cycle.

### Finding 10: DataPipeline WebSocket node lost dynamic connection status indicator
- **File**: `src/components/Sensors/DataPipeline.tsx`:99
- **Severity**: ⚪ Nit
- **Category**: Completeness
- **Problem**: The old `DataPipeline` showed the WebSocket node with a dynamic color based on connection status (green/yellow/red) and the `wsStatus` text. The new `StaticDag` memo'd component uses a static purple color and `:3001` as the subtitle. Users can no longer see at-a-glance whether the WebSocket is connected from the data pipeline visualization. (The `ConnectionStatusBar` component elsewhere on the page still shows this, so it's not a loss of functionality.)
- **Suggested fix**: Acceptable tradeoff if the `StaticDag` isolation was needed to fix the ReactFlow infinite render loop. No code change needed — just noting the regression for awareness.
- **Rationale**: The infinite loop fix is more important than the dynamic color indicator, but the intent should be documented.

### Finding 11: Server-side normalizeFrame in piezoStream.ts is never tested
- **File**: `src/streaming/piezoStream.ts`:365-380
- **Severity**: 🟡 Major
- **Category**: Testing
- **Problem**: The tests in `normalizeFrame.test.ts` only test the shared `normalizeFrame.ts` module. The server-side normalizeFrame in `piezoStream.ts` (the one that actually sends frames to all WebSocket clients including iOS) has zero test coverage. Since the two implementations diverge (Findings 2 and 3), the untested server version may have bugs that the tested client version does not.
- **Suggested fix**: Either consolidate into one implementation (Finding 1), or add a separate test file for the server-side normalizer. Consolidation is strongly preferred.
- **Rationale**: The server-side normalizer runs on the pod and feeds ALL clients. Bugs here affect iOS and M5 dial clients, not just the browser.

## Statistics
- Total findings: 11
- 🔴 Critical: 0
- 🟡 Major: 3
- 🟢 Minor: 4
- ⚪ Nit: 4
- 🟣 Pre-existing: 0
