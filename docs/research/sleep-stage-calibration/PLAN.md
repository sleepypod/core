# Sleep-stage calibration against Apple Watch — plan

Status: draft 2026-10-10. Owner: Jonathan. Each workstream below is scoped so one
agent can own it end to end. Workstreams A–D are independent; E depends on C.

## 1. Recorded findings

Source: Health export `/Users/ng/Desktop/apple_health_export/export.xml` joined per
minute with `vitals` + `movement` from the Pod 5 `biometrics.db`
(192.168.1.88:8822, `/persistent/sleepypod-data/biometrics.db`, timestamps in
seconds). `scripts/sleep-stage-dataset.py` does the join and reproduces the
first three table rows within 1 point with `--summary` (it labels by exact
Watch segment times, so 10-08 prints 52/32/68); `feat2.py` here runs the windowed
features and leave-one-night-out tree on its CSV. See `README.md`. The
720-combo grid search lived in the original `eval.py` (removed; in git history).

Usable nights: 2026-10-08/09 and 2026-10-09/10, left side, 587 Watch-labeled vitals samples (about one per minute).
(2026-10-01/02 has Watch only against the right side, HR MAD 12 bpm — excluded.)

| Variant | 10-08 | 10-09 |
|---|---|---|
| Server as deployed (movement-only, `calibrationQuality` defaults to 0) | 53% | 55% |
| iOS rule set (offline simulation, `calibrationQuality`=1) | 33% | 31% |
| Always "light" | 69% | 57% |
| Best of 720 threshold combos (pooled) | 55% | 57% |

Why the rules fail:
- Per-minute pod HR ratio for Watch-deep is 0.95–1.04, never < 0.92. The "deep = low HR" rule fires on noise.
- Pod HRV relative to night median: Watch-deep 0.56–0.78×, Watch-REM 1.1–1.4×. The rule "REM = low HRV" is inverted; it labels deep as REM.
- `movement.total_movement` is exactly 0 for 97% of epochs on 10-09 (39% nonzero on 10-08). Wake rules cannot fire.
- Both callers omit `calibrationQuality`, so the server never emits deep/REM: `src/server/routers/biometrics.ts:1217`, `src/components/Sleep/sleepData.ts:255`.
- 126 of 782 `sleep_records` have `sleep_duration_seconds` = 57600 (the `MAX_SESSION_S` 16 h cap) with 0 exits. Vitals stop when the bed empties (0 rows 11:05→18:04 on 10-10), so the cap pads the stage timeline, not the vitals averages.
- Pod HRV is an index of successive differences of 10 s-window IBIs (docs/wiki/topics/piezo-processing.md), not SDNN. Watch SDNN is 3 spot readings/night. No scalar correction is valid.

Stages are **not stored**. `classifySleepStages` runs at query time over `vitals` + `movement`. A classifier change therefore applies to every past night automatically.

## 2. Backfill policy (what can and cannot be repaired)

| Layer | Stored? | Backfill |
|---|---|---|
| Sleep stages | No (derived at read) | Automatic once classifier changes. Nothing to migrate. |
| `sleep_records` 16 h cap | Yes | One-off repair, `scripts/repair-capped-sessions.py` (PR #804), for records with `sleep_duration_seconds`=57600. Occupancy evidence is the side's `vitals` only; `movement` is written every minute while a session is open, so it runs to the cap. Vitals are split into runs at gaps > 5 min; occupancy ends at the end of the last run lasting ≥ 30 min. `left_bed_at` = that end + `ABSENCE_TIMEOUT_S` (120 s), never later than the original; duration recomputed, intervals clipped, exits recounted. Records with no qualifying run are left unchanged and listed. Dry run by default; `--apply` first writes `<db>.bak.<epoch>` with the SQLite backup API. |
| `movement` zeros | Yes | Not recoverable: raw `.RAW` is a rolling single file on tmpfs (Pod 5), nothing archived (`archive-push-staging` empty). `cap_sense_frames` holds ~2 days of per-window zone sums (69k rows, 10-08→10-10) — only those days could be re-derived, not worth it. Forward-only fix. |
| `vitals` HR/HRV/BR | Yes | Not recomputable (raw gone). Keep as is; treat HRV as an index. |
| HealthKit samples written by the iOS app ("sleepypod" source) | In HealthKit | iOS app must delete its own `HKCategoryTypeIdentifierSleepAnalysis` samples for affected nights and rewrite after the server returns new stages. HealthKit permits deleting samples your app wrote. Out of this repo; track in sleepypod-ios. |
| Watch labels | In HealthKit | iOS app can read Watch `SleepAnalysis` and POST to the pod (see D) so the dataset accrues without manual exports. |

## 3. Workstreams

### A. Sleep detector: stuck presence / 16 h cap  (modules/sleep-detector, python)
Why: 126/782 sessions hit `MAX_SESSION_S`; the stage timeline runs to 17:30 on an empty bed.
What: find why presence stays true after the bed empties on Pod 5 (adaptive baseline, exit fraction, or capSense2 sentinel handling); fix; add the repair script from §2 as `scripts/repair-capped-sessions.py` (dry-run default).
Acceptance:
- Replay test with recorded capSense2 frames ending in an empty bed closes the session within `ABSENCE_TIMEOUT_S`.
- Repair script on a copy of the pod DB rewrites every capped record that has a qualifying vitals run (52 of 126 on the 2026-10-10 copy) and lists the rest unchanged; new `left_bed_at` ≤ end of the last qualifying run + 120 s and ≤ the original; writes `.bak` first; a re-run finds nothing.
- `docs/sleep-detector.md` updated.

### B. Sleep detector: movement all-zero  (modules/sleep-detector, python)
Why: 97% zero epochs on 10-09 makes wake undetectable.
What: determine which stage of the PIM pipeline (pump gate, P5 baseline subtraction, median filter, scale factor) collapses the signal on Pod 5; fix so a quiet night yields the documented distribution (70–80% epochs 0–50, not 97% exactly 0).
Acceptance:
- Unit test with a synthetic still-then-roll sequence produces nonzero scores for the roll and a nonzero floor during stillness.
- One live night on Pod 5 shows ≥ 30% nonzero epochs and ≥ 1 epoch > 200 per bed exit.

### C. Dataset builder  (scripts/, typescript or python)
Why: calibration needs ≥ 20 labeled nights; today the join lives in three scratch scripts.
What: `scripts/sleep-stage-dataset.py <export.xml|export dir> <biometrics.db> --side left --out dataset.csv` emitting one row per pod vitals sample (about one per minute): `night, side, ts, watch_stage, hr, hrv, br, movement, hr_quality` plus `watch_hr` when within 60 s. Reuse `parse.py`/`eval.py` logic. Also `--summary` printing per-night agreement for the current classifier and the always-light baseline.
Acceptance:
- Reproduces the first three rows of the table in §1 for the two nights (±1 point).
- Rejects nights where pod-vs-Watch HR MAD > 8 bpm with a warning (side mismatch guard).
- README in this folder documents how to pull a consistent copy of the DB (SQLite backup API on the pod, or `scp -P 8822 root@<pod>:/persistent/sleepypod-data/biometrics.db{,-wal}` while the writers are quiet).
- Python tests run in CI (Python Modules workflow).

### D. Comparison-data ingestion from the app  (src/server, tRPC + iOS stub)
Why: manual Health exports do not scale to 20 nights.
What: tRPC mutation `biometrics.importReferenceStages({side, source:'apple_watch', segments:[{start,end,stage}]})` writing a new `reference_stages` table (migration in `src/db/biometrics-migrations`), idempotent on (side, source, start). The iOS app posts the Watch's `SleepAnalysis` samples each morning. Dataset builder (C) reads this table when no export is given.
Acceptance:
- Migration + Drizzle schema; mutation validates input at the boundary; duplicate posts are no-ops.
- `sleep-stage-dataset.py --from-db` yields the same rows as the export input (the default; there is no `--from-export` flag) for 10-09, once the iOS app has posted that night.

### E. Classifier v2  (src/lib/sleep-stages.ts) — blocked on C, needs ≥ 20 nights
Why: the current rule family cannot beat always-light.
What: replace `classifyEpoch` with windowed features: 15-min HR std, 15-min mean HRV / night median HRV, breathing-rate std, fraction of night elapsed, movement (once B lands). Start with a small, inspectable model (depth-3 tree or hand thresholds derived from it), same post-processing (smoothing, transition constraints). Pass real `calibrationQuality` from `calibration_profiles` at both call sites; fall back to light/wake-only when below 0.3.
Acceptance:
- Leave-one-night-out agreement ≥ always-light + 10 points on every held-out night, reported in `docs/research/sleep-stage-calibration/RESULTS.md`.
- Cohen's κ reported alongside accuracy.
- Existing `sleep-stages` tests updated; quality score unchanged in shape.
- UI copy: HRV card labels the pod value "HRV index", not ms-SDNN.

### F. iOS app follow-ups (sleepypod-ios, not this repo)
- Align the comparison window to the intersection of Watch coverage and pod session; show "compared" over that intersection only.
- Delete and rewrite the app's own HealthKit stage samples after E ships.
- Post Watch stages to D each morning.

## 4. Delegation notes
- A and B share `modules/sleep-detector`; acquire `ygg lock acquire modules/sleep-detector` and sequence B after A, or give both to one agent.
- C and D can run in parallel; D must not change C's CSV schema.
- Do not touch E until C reports ≥ 20 nights with HR MAD ≤ 8 bpm.
- Pod access: ssh port 8822, no `sqlite3` binary on the pod — copy the DB and query locally.
