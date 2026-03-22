# Optimizer Findings — fix/movement-scoring-217

## Summary

This branch replaces the broken movement scoring algorithm in `modules/sleep-detector/main.py`. The old approach computed z-score deviations from an empty-bed calibration baseline, which measured static body presence rather than movement — producing scores of 28,000–75,000 for a person lying perfectly still and making actual position changes indistinguishable from noise. The fix replaces this with Proportional Integration Mode (PIM): summing absolute sample-to-sample deltas across the 3 capacitance channel pairs per 60-second epoch, the standard approach used in wrist actigraphy. The branch also adds sentinel filtering, reference channel common-mode rejection, and a new `docs/sleep-detector.md` documenting the algorithm with literature references.

---

## Completeness Check vs Issue #217

All four requirements from the issue are addressed:

| Requirement | Status |
|---|---|
| Replace z-score-from-baseline with sample-to-sample deltas | Done |
| Filter `-1.0` sentinel values via zero-order hold | Done |
| Use reference channel pair for common-mode rejection | Done |
| Change `_flush_movement` from `np.mean` to `sum` | Done |

---

## Findings

### Finding 1: `_prev_values` not reset on session close — spurious delta on re-entry

- **File**: `modules/sleep-detector/main.py:376` (`_close_session` reset block)
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: `_close_session` resets all session state (`_session_start`, `_exit_count`, intervals, etc.) but does not reset `_prev_values`. When a second session begins later that night, the first sample computes its delta against the last sample from when the person left bed — potentially hours earlier. The channel values will differ (e.g., warm/settled values vs. just-got-in values), producing a spurious delta of 10–20 raw units, yielding a stored score of 100–200 on the very first sample of the new session. This is one bad sample out of 120 per epoch, so the contamination is limited to the first minute of the second session, but it is wrong data.
- **Suggested fix**: Add `self._prev_values = None` to the reset block at the end of `_close_session` (lines 376–383).
- **Rationale**: The zero-order hold behavior (carrying `_prev_values` across sentinel gaps) is intentional within a session. Between sessions, the temporal gap makes any cross-session delta meaningless. Setting `_prev_values = None` causes the first sample of a new session to emit delta `0.0` (guarded by the `not previous` check in `compute_movement_delta`), which is the correct behavior.

---

### Finding 2: Dead import — `numpy` no longer used

- **File**: `modules/sleep-detector/main.py:57`
- **Severity**: ⚪ Nit
- **Category**: Correctness / Cleanliness
- **Problem**: `import numpy as np` remains after the refactor removed the only call site (`np.mean` in `_flush_movement`, replaced with `sum()`). There are no other `np.` references in the file.
- **Suggested fix**: Remove line 57: `import numpy as np`.
- **Rationale**: Dead imports increase startup time, create a false dependency on numpy in the deployment environment, and mislead reviewers into thinking numpy is still needed for this module.

---

### Finding 3: Dead constant — `CHANNELS` no longer used

- **File**: `modules/sleep-detector/main.py:169`
- **Severity**: ⚪ Nit
- **Category**: Correctness / Cleanliness
- **Problem**: `CHANNELS = ("out", "cen", "in")` was used in the old `movement_score_calibrated` to iterate over capSense channels. The replacement `_extract_channel_values` accesses `"out"`, `"cen"`, `"in"` inline. The constant is now defined but never referenced.
- **Suggested fix**: Remove line 169: `CHANNELS = ("out", "cen", "in")`.
- **Rationale**: Unused constants add noise and can mislead future contributors into thinking the constant is meaningful. Since `_extract_channel_values` uses hardcoded keys anyway, either the constant should be used there or it should be removed.

---

### Finding 4: Movement rows written unconditionally — no session gate

- **File**: `modules/sleep-detector/main.py:312–314` (`_update`)
- **Severity**: 🟢 Minor
- **Category**: Correctness / Performance
- **Problem**: `_movement_buf.append(movement)` and `_flush_movement(ts)` execute on every sample regardless of whether a session is active. When no one is in bed, the empty side accumulates near-zero deltas (~0.0 per sample with PIM) and writes movement rows to the `movement` table every 60 seconds. This is 1,440 rows/day/side of essentially-zero data, totalling ~2.9k rows/day of storage waste. More importantly, the `movement` table has no `session_id` column, so consumers (iOS app) must range-join on timestamps to filter out out-of-session rows — a non-obvious requirement that could produce confusing "movement while asleep = 0" spans.
- **Suggested fix**: In `_update`, guard the buffer append and flush behind session-active check: `if self._session_start is not None: self._movement_buf.append(movement); self._flush_movement(ts)`. Alternatively, flush remaining buffer when the session closes.
- **Rationale**: With the old algorithm this was masked by the large DC offset scores. With PIM, the empty-side scores will be near-zero but still populate the table. The new `docs/sleep-detector.md` correctly identifies cross-side vibration coupling as a known limitation; the unconditional write is a related concern that isn't mentioned.

---

### Finding 5: `baselines` parameter is dead code in the capSense (Pod 3) path

- **File**: `modules/sleep-detector/main.py:175–220` (`_extract_channel_values`)
- **Severity**: ⚪ Nit
- **Category**: Architecture / Correctness
- **Problem**: The function signature accepts `baselines: Optional[dict] = None` and uses it for reference compensation in the `capSense2` path. In the `capSense` (Pod 3) path, `baselines` is received but completely unused — the function just reads `"out"`, `"cen"`, `"in"` from `data` and returns. The caller always passes `baselines` for both record types.
- **Suggested fix**: Either (a) document in the docstring that `baselines` is ignored for capSense records, or (b) split into two functions to make the contract explicit. Option (a) is lower-cost.
- **Rationale**: Currently misleads readers into thinking capSense also uses calibration data for extraction. Since capSense uses integer channels without a reference pair, this is structurally correct — but the lack of documentation creates confusion.

---

### Finding 6: No unit tests for the new scoring functions

- **File**: (no test file exists for sleep-detector)
- **Severity**: 🟣 Pre-existing
- **Category**: Testing
- **Problem**: There are no Python unit tests for `modules/sleep-detector/`. The refactor introduces two pure, deterministic functions — `_extract_channel_values` and `compute_movement_delta` — that are straightforward to unit-test in isolation. The previous `movement_score_calibrated` also had no tests; this is a pre-existing gap that the refactor has not addressed.
- **Suggested fix**: Add a `tests/test_sleep_detector.py` (or `modules/sleep-detector/test_main.py` following the pattern in `modules/piezo-processor/test_main.py`) covering: sentinel detection, reference compensation math, zero-order hold behavior on sentinel streams, first-sample (prev=None) guard, epoch scaling and cap, and capSense vs capSense2 extraction.
- **Rationale**: The core bug in issue #217 was that nobody caught the z-score approach measuring presence rather than movement. Tests of the scoring functions with known inputs would have caught regressions — including the `_prev_values` reset issue in Finding 1 — before production.

---

### Finding 7: `docs/sleep-detector.md` score range table may not match all hardware

- **File**: `docs/sleep-detector.md:34–39` (Score interpretation table)
- **Severity**: ⚪ Nit
- **Category**: Correctness / Documentation
- **Problem**: The score interpretation table (`0–50 = still, 50–200 = minor fidgeting`) is described as expected ranges but was empirically tuned on one Pod 5 (acknowledged in Known Limitation 4). At 2 Hz for 60 seconds = 120 samples, a still person with per-sample delta of ~0.05–0.15 produces a raw epoch sum of 6–18, which at `×10` yields stored scores of 60–180 — already overlapping the "minor fidgeting" band. The upper bound of the "still" range (50) is likely too optimistic.
- **Suggested fix**: Add a note directly next to the table: `*Ranges are empirically calibrated for Pod 5 at ~2 Hz sampling. Pod 3 integer-channel values may produce different absolute ranges.*`
- **Rationale**: Consumers of the API (iOS app, sleep stage algorithms) will use these ranges as thresholds. Misleading documentation here could cause incorrect wake/sleep classification at the boundary.

---

## Statistics

| Severity | Count |
|---|---|
| 🔴 Critical | 0 |
| 🟡 Major | 1 |
| 🟢 Minor | 1 |
| ⚪ Nit | 4 |
| 🟣 Pre-existing | 1 |
| **Total** | **7** |

**Issue #217 completeness**: All four stated requirements are implemented. The algorithm change is correct and well-motivated. The two dead-code items (numpy import, CHANNELS constant) are direct artifacts of the refactor and should be cleaned up before merge. Finding 1 (_prev_values reset) is the only behavioral bug introduced and should be fixed.
