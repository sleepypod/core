# Sleep-stage calibration dataset

Builds a per-minute dataset that pairs Apple Watch sleep stages with the pod's
vitals and movement, so the stage classifier in `src/lib/sleep-stages.ts` can be
measured and recalibrated. Background and findings: [PLAN.md](PLAN.md).

## 1. Pull the pod database

The pod has no `sqlite3` binary, so copy the database off the pod and query
locally. sshd listens on port 8822.

The pod's services write to the database all the time, so copying
`biometrics.db` and its `-wal` file one after the other is not an atomic
snapshot. A checkpoint between the two reads can leave the copy inconsistent.
Take the snapshot on the pod with SQLite's backup API through the pod's
`python3`, then copy that one file:

```sh
ssh -p 8822 root@<pod-ip> python3 - <<'EOF'
import sqlite3
src = sqlite3.connect('file:/persistent/sleepypod-data/biometrics.db?mode=ro', uri=True)
dst = sqlite3.connect('/persistent/sleepypod-data/biometrics.snapshot.db')
src.backup(dst)
dst.close()
EOF
mkdir -p poddb
scp -P 8822 root@<pod-ip>:/persistent/sleepypod-data/biometrics.snapshot.db poddb/biometrics.db
ssh -p 8822 root@<pod-ip> rm -f /persistent/sleepypod-data/biometrics.snapshot.db
```

The snapshot includes the rows still in the WAL. If you copy the live files
instead (`scp -P 8822 root@<pod-ip>:/persistent/sleepypod-data/biometrics.db{,-wal} .`),
do it while the writers are quiet, such as when no one is in bed, and copy
both files in one command. Without the `-wal` file the last few hours are
missing. The script opens the DB read-only. SQLite still reads a WAL if one is
present and may create a `-shm` file beside it.

## 2. Export Apple Health

On the iPhone: Health → profile picture → Export All Health Data. AirDrop the
zip to the Mac and unzip it. The script needs `apple_health_export/export.xml`
(or the directory). The file is parsed incrementally with constant memory, so
a 100+ MB export takes a few seconds.

Only samples whose source name matches `--source` (default `Watch`) are used:
`SleepAnalysis` stages (Core→light, Deep, REM, Awake; InBed and Unspecified are
ignored) and `HeartRate`.

## 2b. Import the Watch data into the pod

The export can also be pushed into the pod itself, so the Biometrics page
draws Watch heart rate as a dashed line over the pod's, and later dataset
builds can use `--from-db` without an export:

```sh
scripts/import-watch-health.py ~/Desktop/apple_health_export --pod <pod-ip> --side left
```

It posts `SleepAnalysis` segments to `POST /api/biometrics/reference-stages`,
`HeartRate` samples to `POST /api/biometrics/reference-vitals`, and
`RespiratoryRate` (`breathing_rate`, breaths/min) and
`HeartRateVariabilitySDNN` (`hrv_sdnn`, ms) samples to
`POST /api/biometrics/reference-samples`, in batches of 2000, for the last 30
days (`--days 0` for everything; `--dry-run` to count only). Records the
sleepypod iOS app wrote back into Health (source `sleepypod`, `sleepypod
design`) are the pod's own readings and are always skipped, whatever
`--source` says. Heart rate, breathing rate and HRV are first-write-wins on
side + time + source (+ metric), so re-running on a newer export only adds
what is new. Stages are stricter: the pod rejects
a batch whose segment overlaps a stored one with different boundaries (say a
night the iOS app already posted); the script skips that batch with a warning,
still imports the vitals, and exits 1. Watch heart rate is kept in its own
`reference_vitals` table, breathing rate and HRV in `reference_samples`, never
mixed into the pod's `vitals`,
which feed occupancy, sleep staging and the chart baselines.

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
- `--from-db` reads Watch stages from the `reference_stages` table and Watch
  heart rate from `reference_vitals` (both filled by the import script in
  section 2b, or by the iOS app), instead of an export:
  `scripts/sleep-stage-dataset.py --from-db poddb/biometrics.db --side left --out dataset.csv`.
  On a pod that has never had Watch heart rate imported, `watch_hr` is empty
  and the guard cannot run. Night labels use the machine's local time zone;
  set `TZ` if it differs from the pod's.

## 4. Summary

`--summary` prints, per night, the agreement with the Watch over Watch-labeled
vitals samples for the ported classifier as deployed (`calibrationQuality` 0,
movement-only), with the iOS rule set (`calibrationQuality` 1), and for an
always-light baseline. Samples arrive about once a minute, so agreement is
weighted by sample, and the per-stage distribution below the table counts
samples, not minutes. The classifier runs over the night window, so its
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

## 6. Personal models, container side

`personal-models.py` trains the two ojwalch/sleep_classifiers models (logistic
regression, random forest with 200 trees of depth 8) on the same features the
iPhone computes for its on-device personal models
(sleepypod-ios `docs/design/on-device-stage-training.md`), so the container
run and the phone fit can be cross-checked:

```sh
docs/research/sleep-stage-calibration/personal-models.py dataset.csv --contract A   # the challenger's four inputs
docs/research/sleep-stage-calibration/personal-models.py dataset.csv --contract B   # pod native: adds HRV, breathing, 15-min windows
```

Rows are 5-minute epochs from each night's first Watch-labeled sample, labeled
by the Watch stage at the epoch midpoint, rare classes oversampled instead of
class-weighted (Create ML has no class weights), scored leave-one-night-out
with Cohen's κ against the Watch, pooled and per night. On the ten left-side
nights to 2026-10-18 (724 labeled epochs):

| contract | logistic κ | forest κ |
|---|---|---|
| A | 0.08 | 0.05 |
| B | 0.11 | 0.20 |

The bundled challenger scores κ 0.12 on these nights and the pod's rules about
0.02, so contract B's forest is the first model to clear both.

A sweep on the same nights (leave-one-night-out, contract B) chose the forest's
depth: 200 trees at depth 3/4/6/8/unlimited gave κ 0.18/0.21/0.22/0.26/0.23,
and 100, 500 or 1000 trees changed nothing at any depth, so the forest is
pinned at 200 trees, depth 8. Logistic regression was flat (κ 0.10–0.11) across
C from 0.01 to 100. Histogram gradient boosting at depth 3 reached κ 0.27, the
best single number but within noise of the depth-8 forest on eleven nights;
it would need its own export format and is a candidate once more nights exist.

Two parity checks keep the container and the phone honest:

- Features: `--fixture night-fixture.json` writes a synthetic night's raw rows
  (deterministic, nobody's sleep) and the feature rows under both contracts.
  Copy it to `sleepypod-ios/SleepypodTests/Fixtures/stage-features-night.json`;
  the Swift `StageFeatureParityTests` suite recomputes every column from the raw
  rows and fails on any difference above 1e-6. `--fixture-real` uses the first
  real labeled night instead, for a local check only: it carries timestamps and
  per-minute biometrics and must never be committed.
- Conversion: `--export out/` fits each model on all nights and writes
  `personal-<kind>.mlmodel` with a card in the challenger's schema (test vectors
  are the model's own predictions on 12 training rows). The phone's
  `StageChallenger.load(modelURL:cardURL:)` refuses a model that fails its
  vectors, so a converter mismatch shows up at load. Needs `coremltools`
  (`uv run --with coremltools …`).

### One command on the Mac

`scripts/train-personal-models.py` chains the whole thing: snapshot the pod's
database over SSH, build the dataset, train both models on a contract with
leave-one-night-out scoring, export the pod form, and upload the model with
the higher pooled κ. About five seconds on Apple silicon; nothing runs on the
phone.

```sh
scripts/train-personal-models.py --pod <pod-ip> --side left            # contract B, best model, uploaded
scripts/train-personal-models.py --pod <pod-ip> --side left --no-upload --contract A
scripts/train-personal-models.py --pod <pod-ip> --snapshot poddb/biometrics.db   # reuse a snapshot
```

The pod needs the model endpoints below, and the Watch stages must already be
on it (section 2b). The run leaves the dataset and the exported models (about
half a megabyte) in the work directory and deletes the ~75 MB database
snapshot unless `--keep-snapshot`; the pod keeps one model row per side,
replaced on every upload.

### Running a model on the pod

`--export out/` also writes `personal-<kind>.json`, the pod's portable form
(forest trees as parallel arrays with four-class leaf votes, logistic as
scaler plus weights, the feature contract, hyperparameters and the test
vectors), checked against scikit-learn on every training row before it is
written. The pod evaluates it with `src/lib/personal-stage-model.ts`, which
computes the same feature contracts from a night's vitals and movement (the
same synthetic fixture is replayed by `src/lib/tests/personal-stage-model.test.ts`)
and refuses a model that fails its own test vectors.

```sh
# store the container's forest on the pod for the left side
curl -X PUT http://<pod-ip>:3000/api/sleep-stages/model   -H 'content-type: application/json'   -d "$(jq -c '{side:"left", model:.}' out/personal-forest.json)"
# score it beside the rules against the Watch on the last 14 nights
curl -X POST http://<pod-ip>:3000/api/sleep-stages/model/preview   -H 'content-type: application/json' -d '{"side":"left","nights":14}'
```

The stored model can also stage the side's nights: `PUT /api/sleep-stages/model/active`
with `{"side":"left","active":true}` (or the "Stage nights with this model"
switch on the Settings → Sleep stages page) makes `getSleepStages` and the
Watch comparison classify with the model, with the profile's rules as the
fallback for any night it cannot stage. Every stage read carries `stagedBy`
(`rules` or `model` plus the version), and the web Night view marks
model-staged nights. The profile system and its manifest are untouched: the
rules remain the configured classifier and the model is a per-side switch
beside it, which is why no manifest-hash migration was needed. On the ten left-side nights to 2026-10-19
the container's contract-B forest, evaluated by the pod's TypeScript,
reached in-sample κ 0.33 (leave-one-night-out 0.20 in training).

The Mac analysis container is not checked in here; add its Dockerfile location
when it is.

## Tests

```sh
python3 -m unittest scripts/tests/test_sleep_stage_dataset.py
```

The Python Modules CI workflow runs them on every PR that touches
`scripts/**/*.py`. The tests use small synthetic fixtures, not a real export. When
`src/lib/sleep-stages.ts` changes, update the port in the script and the
classifier cases in the test, which mirror `src/lib/tests/sleep-stages.test.ts`.


### Saved model library

Settings → Sleep stages now offers **Upload model JSON** even when no model is
stored. Upload `candidate.json` from a training run, choose an entry in **Saved
models**, then press **Use this model** to activate it for the current side.
Choosing a dropdown entry alone does not switch staging. Uploads save candidates
without changing the active model, and identical uploads reuse the same entry.
The model version and held-out κ are displayed as inline code; κ includes an
explanation. The existing toggle returns the selected model to rules-only staging.

The library is separate for each side. Existing models are copied into it during
migration without changing their active state. It is stored in the configuration
database and included with its normal backups.

| Method / path | Request | Behavior |
| --- | --- | --- |
| `GET /api/sleep-stages/models` | `?side=left` | List summaries, IDs, selected/active state, and recorded metrics |
| `POST /api/sleep-stages/models` | `{side, model}` | Validate and save a candidate; return its ID without activation |
| `PUT /api/sleep-stages/models/selected` | `{side, id, active}` | Select a saved model and explicitly set activation |

The original singular `/api/sleep-stages/model` routes remain compatible with
existing clients. Singular PUT still selects/replaces the per-side slot and
preserves its active state, but also archives the old and new model in the
library. Singular PUT with `model: null` clears the selection without deleting
saved candidates. Use the plural POST route when an upload must not affect
staging. Models are validated against known feature contracts and their test
vectors before upload or selection. These retrospective models do not establish
prospective or clinical validity.
