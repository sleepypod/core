# Skeptic Challenge Report — fix/movement-scoring-217

## Challenges to Optimizer Findings

### RE: Finding 1 — `_prev_values` not reset on session close

- **Verdict**: ✅ Agree
- **Challenge**: The bug is real and confirmed. After `_close_session` runs, `_prev_values` retains the last sample from the closed session. When the next session begins hours later, `compute_movement_delta` receives a live `_prev_values` (not `None`) and computes a meaningful delta against stale data. The `not previous` guard in `compute_movement_delta` only fires when `_prev_values is None`, which no longer holds after the first session.
- **Alternative**: None needed — the fix (add `self._prev_values = None` to the reset block) is correct and safe. First-sample delta returns 0.0 via the existing guard.
- **Risk if applied as-is**: No risk. This is the correct fix.

---

### RE: Finding 2 — Dead import `numpy`

- **Verdict**: ✅ Agree
- **Challenge**: Confirmed. No `np.` reference exists anywhere in the file after the refactor. The import is dead.
- **Alternative**: None.
- **Risk if applied as-is**: No risk.

---

### RE: Finding 3 — Dead constant `CHANNELS`

- **Verdict**: ✅ Agree
- **Challenge**: Confirmed. `CHANNELS = ("out", "cen", "in")` at line 169 is never referenced in the current code. `_extract_channel_values` uses the string literals directly.
- **Alternative**: None.
- **Risk if applied as-is**: No risk.

---

### RE: Finding 4 — Movement rows written unconditionally

- **Verdict**: 🔄 Agree with modifications — severity understated
- **Challenge**: The Optimizer classifies this as Minor and frames it primarily as a storage waste issue. That undersells the actual blast radius. The OLD algorithm stored out-of-session scores of roughly 10,000–75,000 (uncapped z-score sums). With PIM the same rows now store scores of approximately 0. Any iOS consumer that was filtering movement rows by a score threshold or relying on the high out-of-session values to distinguish "no session" from "deep sleep" will now silently see zeros instead. This is a behavioral breaking change, not just storage waste. The `movement` table has no `session_id` column (confirmed in `biometrics.ts` schema), so there is no canonical way for the iOS app to determine whether a given row belongs to a session.
- **Alternative**: Severity should be upgraded to Major. The guard fix the Optimizer proposes (`if self._session_start is not None`) is still the right fix, but the motivation is correctness for consumers, not just storage.
- **Risk if applied as-is**: The Optimizer's guard fix is correct and introduces no new bugs, but the framing as a Minor issue may cause reviewers to defer it. Deferring it means the iOS app will receive 0-score movement rows during waking hours starting the moment this branch ships.

---

### RE: Finding 5 — `baselines` parameter unused in capSense path

- **Verdict**: ✅ Agree
- **Challenge**: Correct observation. The capSense (Pod 3) path ignores `baselines` entirely. This is structurally justified (Pod 3 has no reference channel), but the silence is confusing. Option (a) — a docstring note — is the appropriate fix.
- **Alternative**: None.
- **Risk if applied as-is**: No risk.

---

### RE: Finding 6 — No unit tests

- **Verdict**: ✅ Agree
- **Challenge**: Pre-existing gap, correctly categorized as 🟣 Pre-existing. The two new pure functions (`_extract_channel_values`, `compute_movement_delta`) are straightforward to test and would have caught both the cross-session bug (Finding 1) and the scale-factor mismatch (see Missed Issue 1 below).
- **Alternative**: None.
- **Risk if applied as-is**: No risk.

---

### RE: Finding 7 — Score range table may not match all hardware

- **Verdict**: 🔄 Agree with modifications — math error in Optimizer's analysis, and severity is understated
- **Challenge**: The Optimizer states: "a still person with per-sample delta of ~0.05–0.15 produces a raw epoch sum of 6–18, which at ×10 yields stored scores of 60–180." This calculation is wrong. The Optimizer omitted the factor-of-3 multiplication for the three sensing channels. At 2 Hz for 60 s = 120 samples, three channels, with per-sample per-channel delta of 0.05–0.15:

  ```
  raw_sum = 0.05 * 3 * 120  to  0.15 * 3 * 120
           = 18              to  54
  score    = 180             to  539
  ```

  The correct still-person score range for those assumed deltas is **180–539**, not 60–180. A score of 180–539 does not overlap the "minor fidgeting" band — it blows well past it into the "limb repositioning" band. This makes the documentation inconsistency far more serious than the Optimizer describes.

  The docs comparison table at line 47–49 of `docs/sleep-detector.md` shows empirical still scores of 35–77, which back-calculates to a per-sample per-channel delta of ~0.010–0.021. If those empirical values are correct, the `0–50 = still` band is plausible for most still epochs. However, the upper end of the empirical range (77) already exceeds 50, meaning even the empirical data shows a still person crossing into the "minor fidgeting" band. The Optimizer is right that the table is miscalibrated, but the severity should be raised from Nit to Minor because it actively misleads iOS developers who will threshold on these values for sleep stage classification.

- **Alternative**: The score interpretation table (in both the module docstring and `docs/sleep-detector.md`) should be updated to match the empirically measured ranges from the comparison table, or the empirical ranges should be cited explicitly.
- **Risk if applied as-is**: If the Optimizer's note (add a hardware caveat) is the only change, the fundamental miscalibration of the band boundaries remains. Downstream consumers using 50 as a "still" threshold will misclassify a meaningful fraction of genuinely still epochs.

---

## Missed Issues

### Missed Issue 1: Scale factor ×10 produces permanently-saturated scores on Pod 3

- **File**: `modules/sleep-detector/main.py:392`
- **Severity**: 🔴 Critical
- **Problem**: The `×10` scale factor was empirically tuned for Pod 5 `capSense2` channels, which are averaged float pairs in approximately the 0.5–5.0 range. Pod 3 `capSense` channels (`out`, `cen`, `in`) are raw integer ADC counts cast via `int(data.get(...))`, typically in the range 100–2000. For a still person on Pod 3, per-sample per-channel deltas of 1–5 ADC counts are typical. Running the same math:

  ```
  raw_sum = 3 * 120 * 3   (delta=3, 3 channels, 120 samples)
          = 1080
  score   = min(1000, int(1080 * 10)) = 1000
  ```

  A still person on Pod 3 would saturate the 1000 cap on every single epoch. Any movement at all produces score 1000. The entire 0–999 dynamic range is collapsed to a single value, making the movement column useless for Pod 3 users. The old z-score approach normalized across pod types by design; PIM with a single shared scale factor does not.

- **Suggested fix**: Derive the scale factor per record type. For `capSense` (Pod 3), use a much smaller factor (e.g., `0.01` or compute it as `100 / (expected_max_still_epoch_sum)`). Alternatively, normalize the capSense integer channels to the same float range as capSense2 before computing deltas. The cleanest approach is to add a `SCALE_FACTOR` lookup keyed on `rtype` in `_flush_movement` or pass `rtype` through the buffer.

---

### Missed Issue 2: `_movement_buf` not cleared on session close — cross-session epoch contamination

- **File**: `modules/sleep-detector/main.py:376–383` (`_close_session` reset block)
- **Severity**: 🟡 Major
- **Problem**: The `_close_session` reset block (lines 376–383) clears seven state fields but neither flushes nor clears `_movement_buf` or resets `_last_movement_write`. After a session closes mid-epoch, the buffer contains accumulated deltas from the tail of the closed session. These deltas persist into the next epoch window. When the 60-second timer fires on the next event (either out-of-bed noise or the start of a new session), `_flush_movement` sums the old session's leftover deltas together with new deltas and writes them as a single movement row. The timestamp on that row reflects the flush time, which may be minutes into the next session. This is a data integrity problem: session 1's final movement is quietly merged into session 2's first epoch, or into an out-of-session row, without any indication in the database.

  This is pre-existing behavior (the old `np.mean` also left the buffer un-cleared), but PIM's `sum()` amplifies the contamination because high-movement events at session close (the person getting out of bed) can produce large delta values that stay in the buffer and inflate the first epoch of session 2.

- **Suggested fix**: In `_close_session`, either flush the remaining buffer with a final write before closing (preferred — preserves the data), or explicitly clear `_movement_buf = []` and reset `_last_movement_write = 0.0` (discards the partial epoch, less data loss than leaving it to contaminate the next session). Flushing is better. Note that `_last_movement_write` should also be reset to the close timestamp so the new session's first epoch is a full 60 seconds.

---

### Missed Issue 3: tRPC API documentation contradicts the movement scoring table

- **File**: `.claude/docs/trpc-api-architecture.md:192`
- **Severity**: ⚪ Nit
- **Problem**: The tRPC architecture doc was updated by this PR to describe the new scoring. However, line 192 reads: `Movement: Integer 0-1000 (0=still, 50-200=restless, 200+=major movement)`. This collapses the four-band model from `docs/sleep-detector.md` (0–50/50–200/200–500/500+) into a three-band model that omits the 200–500 "limb repositioning" band entirely and relabels "500+ major" as "200+ major". A developer reading only the tRPC docs will think any score above 200 is a major movement, potentially triggering incorrect wake-state logic.
- **Suggested fix**: Update line 192 to match `docs/sleep-detector.md`: `Movement: Integer 0-1000 (0-50=still, 50-200=fidgeting, 200-500=repositioning, 500+=major movement)`.

---

### Missed Issue 4: "5-minute lag" claim is stale after PR changes vitals to 60-second sampling

- **File**: `.claude/docs/trpc-api-architecture.md:197`
- **Severity**: ⚪ Nit
- **Problem**: Line 197 states: "Historical data only (5-minute lag)". This PR updated vitals sampling from "every ~5 minutes" to "every ~60 seconds" and movement is written every 60 seconds. The 5-minute lag description is no longer accurate for either data type. iOS clients implementing polling intervals or caching TTLs based on this claim will be unnecessarily conservative.
- **Suggested fix**: Update to "Historical data only (~60-second lag)" or "Historical data only (movement: 60s lag, vitals: ~60s lag)".

---

## Statistics

| Category | Count |
|---|---|
| Optimizer findings confirmed (✅ Agree) | 5 |
| Optimizer findings challenged with modification (🔄) | 2 |
| Optimizer findings disputed (⚠️ Disagree) | 0 |
| Missed issues found | 4 |
| **Total Optimizer findings** | **7** |
| **Total Missed issues** | **4** |

**Most significant challenge**: Finding 7 contains a math error (missing ×3 channel factor) that causes the Optimizer to understate the severity of the score range miscalibration.

**Most significant missed issue**: Missed Issue 1 (scale factor saturation on Pod 3) is Critical — Pod 3 users will receive all-1000 movement scores with every epoch, making the movement column completely uninformative for that hardware generation. This is a regression introduced by this PR.

**Net assessment**: Finding 1 (`_prev_values` reset) and Missed Issue 1 (Pod 3 scale saturation) are both blocking. The branch should not merge without addressing the Pod 3 scale factor; the PIM approach as implemented only works correctly for Pod 5.
