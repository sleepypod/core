# Skeptic Challenge Report (Opus) — feature/244-event-bus-broadcast

## Methodology

Independent review of the full diff (`git diff origin/dev...origin/feature/244-event-bus-broadcast`), all changed source files read in full from the feature branch, import chains traced, and specific claims verified with grep/git tooling before evaluating the Optimizer's findings.

## Challenges to Optimizer Findings

### RE: Finding 1 — Duplicate normalizeFrame logic — server and client diverge
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 90
- **Challenge**: The finding overstates the risk by describing both copies as "normalization functions" that produce different output. In reality, the server-side `normalizeFrame()` in `piezoStream.ts` is **never called**. The `decodeSensorFrames()` function explicitly pushes `rec` (raw CBOR-decoded objects) for all non-piezo frames with the comment: *"Pass through as-is -- iOS expects the raw nested firmware format. Browser normalizes in useSensorStream handleMessage."* The server's normalizeFrame is dead code that happens to still exist in the file. The actual architecture is: server sends raw frames, client normalizes. There is no "divergence" producing wrong output in production -- the server copy is simply unreachable.
- **Alternative**: The correct fix is to delete the server-side normalizeFrame and all its helper functions (normalizeBedTemp, normalizeFrzTemp, normalizeFrzHealth, normalizeFrzTherm, normalizeCapSense2, isSentinel, safeNum, cdToC) from `piezoStream.ts`. They are ~120 lines of dead code. Do NOT have the server import from `normalizeFrame.ts` -- that would change the wire format for iOS clients which expect raw nested firmware structures.
- **Risk if applied as-is**: If someone follows the suggestion to "have piezoStream.ts import from ./normalizeFrame", that would silently change the server wire format. iOS clients that parse `left.pump.rpm` (nested firmware format) would break because the normalized output flattens to `left.pumpRpm`.

### RE: Finding 2 — frzTherm normalization produces different values on server vs client
- **Verdict**: :warning: Disagree
- **Confidence**: 95
- **Challenge**: This is a false positive. As established above, the server-side normalizeFrame is dead code -- `decodeSensorFrames()` never calls it. The server sends raw frzTherm frames to all clients. Only the browser runs client-side normalization via `normalizeFrame.ts`. There is no scenario where two different normalization paths produce conflicting output for the same client. The "divergence" exists only in unreachable code.
- **Alternative**: Delete the server-side dead code (same as Finding 1 fix). No normalization logic change needed.
- **Risk if applied as-is**: Attempting to "consolidate into single implementation" at the server level would change the wire format for iOS, as noted above.

### RE: Finding 3 — Server-side normalizeFrame in piezoStream.ts is untested
- **Verdict**: :warning: Disagree
- **Confidence**: 95
- **Challenge**: You don't test dead code -- you delete it. The server-side normalizeFrame is never invoked (see Finding 1 analysis). Testing it would validate code that has zero production impact and could mislead future developers into thinking it's active.
- **Alternative**: Delete it. The client-side `normalizeFrame.ts` (which IS tested, with 264 lines of tests) is the only live normalization path.
- **Risk if applied as-is**: Writing tests for dead code wastes effort and creates maintenance burden for code that should be removed.

### RE: Finding 4 — No test coverage for broadcastMutationStatus
- **Verdict**: :white_check_mark: Agree
- **Confidence**: 80
- **Challenge**: The finding is valid -- this is the core new function with 9 call sites. However, the severity is arguably correct at Minor, not Major. The function is fire-and-forget with a 2s poll backstop, so bugs cause at most a 2s delay in status propagation (not data loss or crashes). The `targetLevel: undefined` bug they reference was in the overlay, which tests would catch.
- **Alternative**: Agree with the suggested approach (mock getDacMonitorIfRunning, broadcastFrame, getAlarmState). Priority should be: (1) verify overlay is applied to correct side, (2) verify null lastStatus early-return, (3) verify frame shape matches DeviceStatusFrame interface.
- **Risk if applied as-is**: None -- this is a straightforward test addition.

### RE: Finding 5 — broadcastMutationStatus silently swallows all errors
- **Verdict**: :white_check_mark: Agree
- **Confidence**: 85
- **Challenge**: The finding is valid but correctly rated as Minor. The empty catch is intentional (fire-and-forget documented in ADR-0015 and the function's JSDoc). Adding `console.warn` is the right call -- it preserves the fire-and-forget contract while making failures observable in `sp-logs` for debugging.
- **Alternative**: Exactly as suggested: `console.warn('[broadcastMutationStatus]', e)`. Do not throw or return error status.
- **Risk if applied as-is**: None.

### RE: Finding 6 — getAlarmState does synchronous SQLite read on broadcast hot path
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 75
- **Challenge**: The severity is overstated at Major. Evidence: `getAlarmState()` is already called on the same hot path in `dacMonitor.instance.ts` line 231 -- every 2 seconds during the DacMonitor poll cycle. If synchronous SQLite were a latency problem, the existing 2s poll would already be impacted, and it has been running in production since `dacMonitor.instance.ts` was written. The function queries `device_state` (2 rows max), which with WAL mode and a 64MB cache will be served entirely from the page cache after the first read. On an aarch64 Pod with better-sqlite3, this is sub-millisecond.
- **Alternative**: Caching is a valid optimization but should be deferred. The actual overhead is negligible for a 2-row table that's always in cache. If caching is pursued, it should be done once for both the DacMonitor poll path AND broadcastMutationStatus, not just the new code.
- **Risk if applied as-is**: Introducing an in-memory cache adds complexity (cache invalidation when DB is written by DeviceStateSync, multiple writers). The premature optimization could introduce stale alarm state bugs worse than the "problem" it solves.

### RE: Finding 7 — schedulePowerOn omits targetLevel from overlay
- **Verdict**: :white_check_mark: Agree
- **Confidence**: 70
- **Challenge**: Valid finding, but the severity depends on whether any client actually uses `targetLevel !== 0` as a power-on indicator. Looking at the `DeviceStatusFrame` type in `useSensorStream.ts`, `targetLevel` is present on both sides. The `setPower` device router includes `...(!input.powered && { targetLevel: 0 })` but NOT `targetLevel: someValue` for the powered-on case either. So the inconsistency exists in both the scheduler AND the device router -- neither sets a positive targetLevel. The DacMonitor poll will fill in the actual targetLevel from hardware within 2s.
- **Alternative**: If fixing, fix both `schedulePowerOn` in jobManager.ts AND `setPower` (powered=true case) in device.ts. The hardware uses level 100 for "on" -- but this value isn't readily available to the overlay without reading it back from hardware.
- **Risk if applied as-is**: Low -- the 2s backstop corrects this. The real question is whether any client actually renders differently based on targetLevel during that 2s window.

### RE: Finding 8 — startPriming mutation doesn't broadcast
- **Verdict**: :white_check_mark: Agree
- **Confidence**: 65
- **Challenge**: Valid but correctly rated Minor. Priming is a rare operation (typically once daily, automated by scheduler). The 2s DacMonitor poll will pick up `isPriming: true` from hardware almost immediately. The user who triggered priming already knows it started (they got the success response). The gap only affects OTHER connected clients during a 0-2s window for a rare manual operation.
- **Alternative**: Adding `broadcastMutationStatus(undefined, undefined)` (no side overlay, just rebroadcast current status) would work, but note that priming might not yet be reflected in `getLastStatus()` -- the hardware may take a moment to report `isPriming: true`. The broadcast might send `isPriming: false` optimistically, which would be wrong.
- **Risk if applied as-is**: Broadcasting immediately after `startPriming()` might broadcast `isPriming: false` if `getLastStatus()` hasn't been refreshed yet. The broadcast would need an explicit `{ isPriming: true }` overlay, but that would require restructuring `broadcastMutationStatus` to accept non-side fields. Safer to leave it to the DacMonitor poll.

### RE: Finding 9 — sideOverlay typed as Record<string, unknown>
- **Verdict**: :white_check_mark: Agree
- **Confidence**: 70
- **Challenge**: Valid but properly rated as Minor. The `Record<string, unknown>` type is a pragmatic choice given that the overlay is spread onto the side status with `Object.assign`. A typed `SideOverlay` interface would catch typos like `{ targetTemperture: 75 }` at compile time. However, the suggested fix requires maintaining the type in sync with the hardware status shape, adding maintenance burden.
- **Alternative**: A `Partial<Pick<DeviceStatusFrame['leftSide'], 'targetTemperature' | 'targetLevel' | 'isAlarmVibrating'>>` type would be precise without duplicating definitions.
- **Risk if applied as-is**: None -- type narrowing is safe.

### RE: Finding 10 — Stale ClaimedMessage/ReleasedMessage types remain
- **Verdict**: :white_check_mark: Agree
- **Confidence**: 100
- **Challenge**: Verified. `ClaimedMessage` (line 165), `ReleasedMessage` (line 166), and their union entries (lines 173-174) still exist in `useSensorStream.ts`. The handler at line 381 still checks for `msg.type === 'claimed' || msg.type === 'released'` and returns early. These are dead code since the server no longer sends these message types. Correctly rated as Nit.
- **Alternative**: Remove the interfaces, remove from the union type, and remove the handler check. The early return is harmless but misleading.
- **Risk if applied as-is**: None.

### RE: Finding 11 — Import pattern inconsistencies
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 85
- **Challenge**: The finding correctly identifies two violations. However, the `dacMonitor.instance.ts` change from `@/src/streaming/piezoStream` to `../streaming/piezoStream` was explicitly introduced in this branch (visible in the diff) and likely done to fix a resolution issue with dynamic `import()` in the test/CI environment. The comment in the code says "Dynamic import to avoid circular dependency." Changing it back to `@/` may rebreak CI. The `broadcastMutationStatus.ts` violation (`@/src/streaming/piezoStream` for same-directory) is straightforward to fix.
- **Alternative**: Fix `broadcastMutationStatus.ts`: change `@/src/streaming/piezoStream` to `./piezoStream`. For `dacMonitor.instance.ts`, investigate whether the `../` path was needed for dynamic import resolution before changing it back. The Optimizer's note about "may need a different vitest fix" is apt.
- **Risk if applied as-is**: Reverting dacMonitor's import to `@/` without understanding why it was changed could break dynamic imports in the test environment.

### RE: Finding 12 — setPower broadcast omits targetTemperature when powering on without explicit temp
- **Verdict**: :white_check_mark: Agree
- **Confidence**: 60
- **Challenge**: Valid observation. When `setPower(side, true)` is called without a temperature, the hardware defaults to 75F (confirmed in `client.ts`: `const temp = temperature ?? 75`), but the broadcast overlay is `{}` (empty). Clients will see the old targetTemperature from `getLastStatus()` until the 2s poll updates. However, this is arguably correct behavior -- the overlay shouldn't assume the 75F default belongs in the broadcast layer. The hardware client owns that default, and the DacMonitor poll will report the actual value.
- **Alternative**: If fixing, use `targetTemperature: input.temperature ?? 75` in the overlay. But this duplicates the 75F magic number from client.ts, creating a maintenance risk if the default changes.
- **Risk if applied as-is**: The suggested fix hardcodes 75 in two places. If client.ts changes its default, the broadcast would send wrong data.

### RE: Finding 13 — frameIndex grows unbounded within a RAW file
- **Verdict**: :white_check_mark: Agree
- **Confidence**: 60
- **Challenge**: Correctly flagged as pre-existing. RAW files rotate, so `frameIndex` is reset on file switch (`frameIndex.length = 0` at line ~530 in piezoStream.ts). A single RAW file session would need to run for many hours at high frame rates to accumulate meaningful memory. At ~10 entries/second (typical sensor rate) for 24 hours, that's 864,000 entries at ~40 bytes each = ~34MB. On a 2GB device this is non-trivial but would take a full day. Low priority but valid.
- **Alternative**: A ring buffer or periodic trim (keep last N entries or last 1 hour) would cap memory. The seek feature only needs ~30s of lookback per `SEEK_MAX_DURATION_S`.
- **Risk if applied as-is**: N/A -- pre-existing, no fix suggested.

## Missed Issues

### Missed Issue 1: CI lint command fails silently on filenames with spaces
- **File**: `.github/workflows/test.yml`:19
- **Severity**: :green_circle: Minor
- **Category**: CI/CD
- **Problem**: The lint command uses `echo "$CHANGED" | xargs pnpm eslint`, which splits on whitespace. If any TypeScript file path contains a space (unlikely in this project but possible), xargs will split it into multiple invalid arguments and eslint will fail with confusing "file not found" errors. Additionally, `head -200` silently drops files beyond the 200th, meaning large PRs could have unlinted files with no warning.
- **Suggested fix**: Use `xargs -d '\n'` (or `tr '\n' '\0' | xargs -0`) to handle paths safely. Add a warning when file count exceeds 200: `COUNT=$(echo "$CHANGED" | wc -l); if [ "$COUNT" -ge 200 ]; then echo "::warning::Only linting first 200 of $COUNT changed files"; fi`.

### Missed Issue 2: Server-side normalizeFrame is dead code (~120 lines)
- **File**: `src/streaming/piezoStream.ts`:248-380
- **Severity**: :yellow_circle: Major
- **Category**: Dead Code
- **Problem**: The server-side `normalizeFrame()` and all its helper functions (`normalizeBedTemp`, `normalizeFrzTemp`, `normalizeFrzHealth`, `normalizeFrzTherm`, `normalizeCapSense2`, `isSentinel`, `safeNum`, `cdToC`) are never called. `decodeSensorFrames()` passes non-piezo frames through raw (line 416: "Browser normalizes in useSensorStream handleMessage"). This is ~120 lines of dead code that creates the false impression of a "dual normalization" problem (Findings 1-3). The Optimizer identified the duplication but missed that the server copy is entirely unreachable.
- **Suggested fix**: Delete lines 248-380 of `piezoStream.ts` (the entire "Frame normalization" section including all helper functions and the `normalizeFrame` function itself). This resolves Findings 1, 2, and 3 simultaneously.

### Missed Issue 3: broadcastMutationStatus uses stale base for concurrent mutations
- **File**: `src/streaming/broadcastMutationStatus.ts`:24-25
- **Severity**: :green_circle: Minor
- **Category**: Race Condition
- **Problem**: When two mutations fire in quick succession (e.g., user sets temperature while scheduler fires power-on), both calls to `broadcastMutationStatus` read the same `getLastStatus()` base. The second broadcast overlays its change onto the same stale base, potentially overwriting the first mutation's overlay in the eyes of WS clients. Example: (1) setTemp(left, 72) broadcasts `{leftSide: {...lastStatus.leftSide, targetTemp: 72}}`, (2) schedulePowerOn(right) broadcasts `{leftSide: {...lastStatus.leftSide}, rightSide: {...lastStatus.rightSide, ...overlay}}` -- the second broadcast shows left at the OLD targetTemp because `getLastStatus()` hasn't been updated yet. Clients see left temperature "revert" for up to 2s.
- **Suggested fix**: This is inherent to the overlay-on-last-poll design and acknowledged in the ADR ("may be up to 2s stale for fields not part of the mutation"). The DacMonitor backstop corrects it. No fix needed beyond awareness, but documenting the race in a code comment would help future maintainers.

### Missed Issue 4: broadcastMutationStatus uses static import for piezoStream while dacMonitor uses dynamic import for the same module
- **File**: `src/streaming/broadcastMutationStatus.ts`:13
- **Severity**: :green_circle: Minor
- **Category**: Architecture Consistency
- **Problem**: `dacMonitor.instance.ts` uses dynamic `import('../streaming/piezoStream')` specifically to "avoid circular dependency" and because "piezoStream is started separately." `broadcastMutationStatus.ts` uses a static `import { broadcastFrame } from '@/src/streaming/piezoStream'`. While there is no circular dependency (broadcastMutationStatus is not imported by piezoStream), the static import means `broadcastMutationStatus.ts` will cause `piezoStream.ts` module-level code to execute at import time. If the `broadcastFrame()` function is called before `startPiezoStreamServer()`, the `wss` variable is null and the function exits early -- which is correct behavior. But it means importing `broadcastMutationStatus` has the side effect of loading the entire piezoStream module (including `ws`, `fs`, `path`, `cbor-x` dependencies).
- **Suggested fix**: This is acceptable for now since both the device router and scheduler only run after server startup. Document the dependency order assumption.

### Missed Issue 5: DataPipeline StaticDag loses WebSocket status indicator
- **File**: `src/components/Sensors/DataPipeline.tsx`
- **Severity**: :white_circle: Nit
- **Category**: UX Regression
- **Problem**: The old DataPipeline code used `useSensorStreamStatus()` to dynamically color the WebSocket node based on connection state (green for connected, yellow for connecting, red for disconnected). The new `StaticDag` component uses hardcoded `#a78bfa` (purple) for the WebSocket node. The WS connection status indicator in the DAG visualization is lost.
- **Suggested fix**: If the live WS status color was intentional UX, re-add it by passing status as a prop to `StaticDag` (breaking the "zero-prop" pattern) or by using a separate small overlay indicator outside ReactFlow. If it was not important UX (the ConnectionStatusBar already shows status), the current approach is fine -- just note it was a conscious tradeoff.

## Summary Assessment

The branch is well-architected. The core `broadcastMutationStatus` pattern is clean: fire-and-forget overlay onto last-known status with a 2s poll backstop. The claim_processing removal is unambiguously correct (dead code, verified by checking that no client sends `claim_processing`). The `normalizeFrame.ts` extraction with typed wire interfaces and 264 lines of tests is a solid improvement.

The Optimizer's most impactful findings (1-3) are weakened by the fact that the server-side normalizeFrame is dead code, not an active divergence. Their suggested fix ("have piezoStream.ts import from ./normalizeFrame") would actually be harmful -- it would change the wire format for iOS clients. The correct action is deletion, not consolidation.

Findings 4-5 (tests + logging for broadcastMutationStatus) are the most actionable items. Finding 6 (SQLite performance) is overstated given that the same function is already called on the 2s poll path.

## Statistics
- Optimizer findings challenged: 4 (Findings 1, 2, 3, 6)
- Findings agreed with: 7 (Findings 4, 5, 7, 8, 9, 10, 12, 13)
- Findings agreed with modifications: 3 (Findings 1, 6, 11)
- New issues found: 5
