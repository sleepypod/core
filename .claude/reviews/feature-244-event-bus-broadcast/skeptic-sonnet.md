# Skeptic Challenge Report (Sonnet) — feature/244-event-bus-broadcast

## Challenges to Optimizer Findings

### RE: Finding 1 — Duplicate normalizeFrame logic — server and client diverge
- **Verdict**: ⚠️ Disagree
- **Confidence**: 95
- **Challenge**: The Optimizer's core premise is false. In the final state of this branch, `piezoStream.ts` contains **zero** normalize functions (`normalizeBedTemp`, `normalizeFrzTemp`, `normalizeFrzHealth`, `normalizeFrzTherm`, `normalizeCapSense2`, `normalizeFrame` are all gone). Confirmed by grep — only two mentions of "normalize" in the file are comments. The branch *removed* the duplicate normalization code from `piezoStream.ts` and extracted the canonical version to `normalizeFrame.ts`. This is the fix, not the problem. The diff the Optimizer read shows the old code being deleted (minus lines) but they appear to have read it backwards.

  Furthermore, `decodeSensorFrames()` in `piezoStream.ts` intentionally passes raw frames through for non-piezo types — the comment explicitly says "Pass through as-is — iOS expects the raw nested firmware format. Browser normalizes in useSensorStream handleMessage." There is no duplication; there are two deliberate clients (iOS gets raw, browser normalizes). This is correct architecture.
- **Alternative**: No fix needed. Finding 1 is based on a misread of the diff.
- **Risk if applied as-is**: Attempting to "have piezoStream.ts import from ./normalizeFrame" would break iOS clients that consume the raw nested format.

### RE: Finding 2 — frzTherm normalization produces different values on server vs client
- **Verdict**: ⚠️ Disagree
- **Confidence**: 90
- **Challenge**: This finding assumes `piezoStream.ts` still contains a server-side `normalizeFrzTherm` that diverges from the client-side `normalizeFrame.ts`. It does not — the branch removed it (see Finding 1 challenge). The actual state is: `piezoStream.ts` passes frzTherm frames through raw to all clients; `normalizeFrame.ts` (client-side) handles normalization for the browser.

  The described divergence (`left.power` vs `left.pumpDuty ?? left.duty`) was real in `origin/dev` but was the exact problem this PR fixed. The extraction in `normalizeFrame.ts` chose `left.power` (the thermal control signal — what `frzTherm` actually represents: TEC power output). The old `pumpDuty` path in piezoStream was semantically wrong. The new code is more correct.
- **Alternative**: No fix needed. The divergence was pre-existing and this branch resolved it by removing the dead server-side copy.
- **Risk if applied as-is**: N/A — divergence no longer exists.

### RE: Finding 3 — Server-side normalizeFrame in piezoStream.ts is untested
- **Verdict**: ⚠️ Disagree
- **Confidence**: 95
- **Challenge**: Same root cause as Findings 1 and 2. The server-side normalize functions no longer exist in `piezoStream.ts`. The `normalizeFrame.test.ts` tests cover the only remaining normalize implementation (`src/streaming/normalizeFrame.ts`). The test coverage gap was closed by this branch, not left open.
- **Alternative**: No fix needed.
- **Risk if applied as-is**: N/A.

### RE: Finding 6 — getAlarmState does synchronous SQLite read on broadcast hot path
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 75
- **Challenge**: The finding is technically correct — `getAlarmState()` in `deviceStateSync.ts` does a synchronous `db.select().from(deviceState).all()` on every `broadcastMutationStatus()` call. However, the severity rating of 🟡 Major is overstated.

  Context matters: this is a single-user embedded device with SQLite in WAL mode. `broadcastMutationStatus` fires at most once per user mutation, not on a tight loop. A two-row SELECT on WAL SQLite typically completes in under 1ms even on embedded aarch64 hardware. More importantly, `dacMonitor.instance.ts` line 231 already calls `getAlarmState()` on every 2-second poll — the authoritative DacMonitor path runs this same query far more frequently and is accepted as fine.

  The suggested in-memory cache introduces its own correctness risk: if the cache misses an update, the broadcast overlay will show stale alarm state. Given the device already passes `isAlarmVibrating: false` explicitly in clearAlarm/snoozeAlarm overlays, a stale cache read would be more dangerous than the 1ms SQLite read.
- **Alternative**: Downgrade to 🟢 Minor and accept as-is. If performance data from the actual Pod shows it matters, add a cache in `deviceStateSync.ts` updated by setAlarm/clearAlarm, not a general TTL cache.
- **Risk if applied as-is**: Cache invalidation complexity for marginal gain. Accept current approach.

### RE: Finding 7 — schedulePowerOn omits targetLevel from overlay
- **Verdict**: ✅ Agree
- **Confidence**: 88
- **Challenge**: None — this is real. `schedulePowerOn` broadcasts with `...(sched.onTemperature && { targetTemperature: sched.onTemperature })`, which omits `targetLevel`. The UI at `TempScreen.tsx:69`, `SideSelector.tsx:99`, and `PowerButton.tsx:37` all use `targetLevel !== 0` to determine powered-on state. `lastStatus.targetLevel` from DacMonitor could still show `0` (pre-power-on) at broadcast time, so the immediate WS push will show the pod as off even though it just powered on.
- **Alternative**: Add `targetLevel: fahrenheitToLevel(sched.onTemperature ?? 75)` to the overlay. Requires importing `fahrenheitToLevel` from `@/src/hardware/types`.
- **Risk if applied as-is**: 2s window where UI shows pod as off after scheduled power-on. Corrected by DacMonitor backstop but defeats the purpose of immediate broadcast.

### RE: Finding 9 — sideOverlay typed as Record<string, unknown> — no compile-time safety
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 70
- **Challenge**: Valid but the blast radius of a type error here is zero — a bad overlay key produces a slightly wrong WS broadcast for 2 seconds, then DacMonitor corrects it. The suggested `SideOverlay` type is reasonable but the lighter-weight fix is `Partial<Pick<DeviceStatusFrame['leftSide'], 'targetTemperature' | 'targetLevel' | 'isAlarmVibrating'>>` imported from `useSensorStream.ts`, which avoids defining a new type file.
- **Alternative**: Use the `Partial<Pick<...>>` inline type rather than a new `SideOverlay` export.
- **Risk if applied as-is**: No blocking risk. Minor type hygiene.

### RE: Finding 10 — Stale ClaimedMessage/ReleasedMessage types remain
- **Verdict**: ✅ Agree
- **Confidence**: 99
- **Challenge**: Verified directly at `useSensorStream.ts` lines 165-166 and 173-174. The types exist, are in the union, and the handler at line 381 (`if (msg.type === 'claimed' || msg.type === 'released') { return }`) is dead code. One nuance: the no-op handler provides silent backwards-compatibility if an old server instance sends these messages during a rolling restart. Its value is debatable but the type union members add nothing and should be removed.
- **Alternative**: Remove `ClaimedMessage`, `ReleasedMessage` interfaces, remove from `ServerControlMessage` union, remove the no-op handler block. All three in one commit.
- **Risk if applied as-is**: None. Pure cleanup.

### RE: Finding 11 — Import pattern inconsistencies
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 80
- **Challenge**: The `broadcastMutationStatus.ts` using `@/src/streaming/piezoStream` for a same-directory import is a genuine violation of import-patterns.md and should be `./piezoStream`.

  The `dacMonitor.instance.ts` use of `import('../streaming/piezoStream')` is in dynamic `import()` calls specifically to break circular dependencies (comment confirms this). Dynamic imports with `@/` alias have known resolution issues in some bundlers and test runners. The existing relative path may be the safer choice. Do not change without verifying CI passes with the `@/` alias in dynamic import context.
- **Alternative**: Fix `broadcastMutationStatus.ts` only. Leave dacMonitor's dynamic import path alone.
- **Risk if applied as-is**: Changing dacMonitor's dynamic import risks breaking runtime resolution if the bundler handles `@/` differently in dynamic imports.

### RE: Finding 12 — setPower broadcast omits targetTemperature when powering on without explicit temp
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 72
- **Challenge**: The finding is correct but incomplete. `device.ts` line 281-284 omits both `targetTemperature` (when no temp provided) AND `targetLevel` when powering on. The UI uses `targetLevel !== 0` for the power indicator, so missing `targetLevel` on a power-on broadcast is actually the more impactful omission — it causes the power button to briefly show "off" state.

  The Optimizer's suggested fix (`targetTemperature: input.temperature ?? 75`) fixes only half the problem.
- **Alternative**: Add both `targetTemperature: input.temperature ?? 75` AND `targetLevel: fahrenheitToLevel(input.temperature ?? 75)` to the power-on branch of the overlay.
- **Risk if applied as-is**: Optimizer's fix is incomplete — power indicator still flickers even after applying it.

---

## Missed Issues

### Missed Issue 1: Snooze re-fire never broadcasts isAlarmVibrating: true
- **File**: `src/hardware/snoozeManager.ts`:26-35
- **Severity**: 🟡 Major
- **Category**: Completeness
- **Problem**: When a snoozed alarm re-fires (`setTimeout` callback at line 26), `client.setAlarm(side, config)` is called but `broadcastMutationStatus` is never called after it. All connected clients won't see `isAlarmVibrating: true` until the next DacMonitor poll (up to 2s). This is the mirror of Finding 8 (startPriming) but more user-visible: the phone UI shows the alarm as inactive for up to 2s while the pod is actively vibrating.
- **Suggested fix**: After `await client.setAlarm(side, config)` succeeds in the snooze timeout callback, add `const { broadcastMutationStatus } = await import('@/src/streaming/broadcastMutationStatus'); broadcastMutationStatus(side, { isAlarmVibrating: true })`. Or import statically and call synchronously.

### Missed Issue 2: broadcastMutationStatus.ts imports piezoStream with @/ alias instead of ./
- **File**: `src/streaming/broadcastMutationStatus.ts`:13
- **Severity**: ⚪ Nit
- **Category**: Pattern
- **Problem**: Line 13 imports `broadcastFrame` from `@/src/streaming/piezoStream`. Both files are in `src/streaming/`. Per `import-patterns.md`, same-directory imports must use `./`. Finding 11 identified this violation in its general statement but the line reference pointed elsewhere; this file is the primary violator.
- **Suggested fix**: Change `import { broadcastFrame } from '@/src/streaming/piezoStream'` to `import { broadcastFrame } from './piezoStream'`.

### Missed Issue 3: setPower power-on broadcast missing targetLevel (user mutation path)
- **File**: `src/server/routers/device.ts`:281-284
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: When `setPower` is called with `powered: true`, the broadcast overlay is `...(input.temperature && { targetTemperature: input.temperature })`. This omits `targetLevel` entirely on the power-on path. UI components check `targetLevel !== 0` for the power indicator (`PowerButton.tsx:37`, `TempScreen.tsx:69`, `SideSelector.tsx:99`). `lastStatus` from DacMonitor may still have `targetLevel: 0`, so the broadcast announces the pod as off immediately after turning it on. Finding 12 touched on this but rated it as a Nit and only noted the temperature omission; the `targetLevel` omission is the more impactful half.
- **Suggested fix**: On the powered-on branch, add `targetLevel: fahrenheitToLevel(input.temperature ?? 75)` to the overlay. Import `fahrenheitToLevel` from `@/src/hardware/types`.

### Missed Issue 4: DataPipeline 'ws' node has redundant sub label
- **File**: `src/components/Sensors/DataPipeline.tsx`:88 (static STATIC_NODES constant)
- **Severity**: ⚪ Nit
- **Category**: UX
- **Problem**: The `ws` node has `label: 'WebSocket :3001'` and `sub: ':3001'` — the port appears twice. The sub-label is redundant. Pre-existing cosmetic issue made more visible by the static node refactor in this branch.
- **Suggested fix**: Change `sub: ':3001'` to `sub: 'read-only pub/sub'` to match the architecture description in the docs.

### Missed Issue 5: recomputeAndSendSubscription sends empty-array subscribe when all hooks unmount
- **File**: `src/hooks/useSensorStream.ts`:514-525
- **Severity**: 🟢 Minor
- **Category**: Edge Case
- **Problem**: When `singleton.activeSubscriptions.size === 0` (all hooks unmounted), `merged = []` and `{ type: 'subscribe', sensors: [] }` is sent. The server treats an empty array as "subscribe to all" (`piezoStream.ts` lines 444-448). So there's a brief window between the last hook unmounting and `disconnect()` running where the connection subscribes to all sensor types with no consumers. Harmless in practice because `disconnect()` fires on the same tick via the ref-count check, but semantically wrong.
- **Suggested fix**: In `recomputeAndSendSubscription`, guard the send: only send a subscribe message if `singleton.activeSubscriptions.size > 0`. When size is 0, skip the send (disconnect will close the connection).

---

## Statistics
- Optimizer findings challenged: 3 (Findings 1, 2, 3 — all false positives, same root cause: diff read backwards)
- Findings agreed with: 3 (Findings 7, 10, partial 11)
- Findings agreed with modifications: 5 (Findings 4/6 severity downgrade, 5 accepted, 9 lighter fix, 12 incomplete fix)
- New issues found: 5 (Missed Issues 1-5; Issue 1 is the most impactful)

## Key Finding Summary

The most significant challenge to the Optimizer report is that Findings 1, 2, and 3 are all false positives sharing one root cause: the Optimizer misread the diff direction. `piezoStream.ts` in the final branch state contains **zero** normalize functions — they were removed by this branch, not added. The "duplication" and "divergence" described do not exist in the delivered code.

The most significant missed issue is **Missed Issue 1**: when a snoozed alarm re-fires, `broadcastMutationStatus` is never called, leaving clients showing stale `isAlarmVibrating: false` for up to 2s while the pod is actively vibrating. This is the highest-visibility gap in the event bus coverage because it directly affects a sleep-disrupting user interaction.

The second most impactful missed issue is **Missed Issue 3**: the power-on path in `setPower` (user mutation) is missing `targetLevel` from the broadcast overlay, causing the power indicator to briefly show "off" immediately after the user manually powers the pod on. This affects every power-on interaction from the UI.
