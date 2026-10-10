# Sleep-stage calibration dataset

Builds a per-minute dataset that pairs Apple Watch sleep stages with the pod's
vitals and movement, so the stage classifier in `src/lib/sleep-stages.ts` can be
measured and recalibrated. Background and findings: [PLAN.md](PLAN.md).

## 1. Pull the pod database

The pod has no `sqlite3` binary, so copy the database and its write-ahead log
off the pod and query locally. sshd listens on port 8822.

```sh
mkdir -p poddb && cd poddb
scp -P 8822 root@<pod-ip>:/persistent/sleepypod-data/biometrics.db{,-wal} .
```

Copy both files in the same command. The `-wal` file holds the most recent
rows; without it the last few hours are missing. The script opens the DB
read-only. SQLite still reads the WAL and may create a `-shm` file beside it.

## 2. Export Apple Health

On the iPhone: Health → profile picture → Export All Health Data. AirDrop the
zip to the Mac and unzip it. The script needs `apple_health_export/export.xml`
(or the directory). The file is streamed line by line, so a 100+ MB export is
fine.

Only samples whose source name matches `--source` (default `Watch`) are used:
`SleepAnalysis` stages (Core→light, Deep, REM, Awake; InBed and Unspecified are
ignored) and `HeartRate`.

## 3. Build the dataset

```sh
scripts/sleep-stage-dataset.py ~/Desktop/apple_health_export poddb/biometrics.db \
  --side left --out dataset.csv --summary
```

The shebang runs under `uv`; plain `python3 scripts/sleep-stage-dataset.py …`
works too (stdlib only, Python ≥ 3.9).

One row per pod vitals sample (about one per minute) inside each night's
window. A window is the Watch's stage coverage padded by `--pad-min` (default
10) on each side. Windows never overlap: sleep that runs past the noon
rollover stays with the night it started in.

| column | meaning |
|---|---|
| `night` | local date the night started (sample time minus 12 h) |
| `side` | `left` or `right` |
| `ts` | pod vitals timestamp, unix seconds |
| `watch_stage` | `wake`/`light`/`deep`/`rem` of the Watch segment containing `ts`, empty in the padding |
| `hr`, `hrv`, `br` | raw pod vitals, not outlier-filtered. HRV is a pod index, not SDNN |
| `movement` | nearest `movement.total_movement` within 60 s |
| `hr_quality` | `vitals_quality.quality_score` for that vitals row |
| `watch_hr` | nearest Watch heart-rate sample within 60 s |

Options:

- `--nights 2026-10-08,2026-10-09` keeps only those nights.
- `--max-hr-mad 8` is the side-mismatch guard. A night where the mean absolute
  difference between pod HR and Watch HR exceeds it is skipped with a warning,
  because it means the Watch wearer slept on the other side. Nights with fewer
  than 10 HR matches are kept with a warning that the guard could not run.
- `--from-db` reads Watch stages from the `reference_stages` table that
  `biometrics.importReferenceStages` fills, instead of an export:
  `scripts/sleep-stage-dataset.py --from-db poddb/biometrics.db --side left --out dataset.csv`.
  That table has no Watch heart rate, so `watch_hr` is empty and the guard
  cannot run. Night labels use the machine's local time zone; set `TZ` if it
  differs from the pod's.

## 4. Summary

`--summary` prints, per night, the agreement with the Watch over labeled
minutes for the ported classifier as deployed (`calibrationQuality` 0,
movement-only), with the iOS rule set (`calibrationQuality` 1), and for an
always-light baseline. The classifier runs over the night window, so its
average HR differs slightly from the server's, which uses the whole sleep
record.

Output for the two usable nights on 2026-10-10. It is within 1 point of
PLAN.md section 1, which labeled whole minutes instead of exact segment times:

```
night       side   rows labeled  HR-MAD  deployed(cq=0)  iOS(cq=1)  always-light
2026-10-08  left    212     202    2.3             52%        32%           68%
2026-10-09  left    405     385    5.4             55%        31%           57%
```

The 2026-10-01 night is rejected by the guard on the right side
(HR MAD 11.8 bpm) and has no left-side vitals.

## 5. Exploration

`feat2.py` reads the CSV and prints windowed features per Watch stage and a
leave-one-night-out tree and forest:

```sh
docs/research/sleep-stage-calibration/feat2.py dataset.csv
```

It needs numpy and scikit-learn; its shebang pulls them through `uv`.

## Tests

```sh
python3 -m unittest scripts/tests/test_sleep_stage_dataset.py
```

The tests use small synthetic fixtures, not a real export. When
`src/lib/sleep-stages.ts` changes, update the port in the script and the
classifier cases in the test, which mirror `src/lib/tests/sleep-stages.test.ts`.
