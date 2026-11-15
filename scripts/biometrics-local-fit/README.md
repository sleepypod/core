# Local biometric profile fitting

Fit biometric profile candidates on a laptop against a frozen calibration
dataset exported from the pod, then send only the best one or two back to the
pod for a real backtest. Waveform replay on Pod 5 runs about 30 times slower
than on a laptop, so parameter sweeps belong here. Activation decisions do not:
everything this tool writes is labelled `exploratory-local` and
`not_activation_evidence`.

## 1. Export the dataset

```sh
curl -fo dataset.tar http://POD:3000/api/biometric-tuning/datasets/DATASET_ID/export
```

The MCP tool `export_calibration_dataset` returns the same bundle index and this
download path. Waveform bytes never go through MCP. The tar holds:

- `bundle.json`: the index. It lists every other file with its exact size and SHA-256.
- `manifest.json` and `snapshot.json`: the frozen dataset. Together they hash
  to the dataset's `contentHash`.
- `raw/<sha256>.RAW.gz`: each retained archive the snapshot references, and nothing else.

A released dataset returns 404. If a retained archive fails its hash check on
the pod, the export returns 409 and streams nothing. Archives contain both
sides of the bed; keep the bundle on a machine you trust.

## 2. Set up the replay environment

```sh
(cd modules/piezo-processor && uv sync --frozen)
```

This installs the locked Python 3.10, NumPy and SciPy that the pod uses. The
runner calls the unchanged `common.biometrics.replay_worker.run()` through
`local_replay.py`. The only differences from the pod are that it skips the
pod's host-wide execution lock, CPU rlimit and nice level, so nights can replay
in parallel. `run.json` records the local Python build identity. Its
`identity.sources` hashes can be compared with the pod's
(`python -B -m common.biometrics.replay_worker --describe-build`). The
interpreter and wheel hashes differ by platform by design.

## 3. Fit or sweep

```sh
pnpm biometrics:local-fit verify dataset.tar
pnpm biometrics:local-fit fit dataset.tar candidates.json out/
pnpm biometrics:local-fit sweep dataset.tar default out/        # or a GRID.json
```

`candidates.json` is `[{ "id": "tol12", "overrides": [{ "path": "heart_rate.trackingToleranceBpm", "value": 12 }] }]`.
The shipped defaults are always added as `defaults`. A grid maps override paths
to value lists. A comma-joined key varies several paths together, for example
`"breathing_rate.intervalLowerRatio,breathing_rate.intervalUpperRatio": [[0.5, 1.5], [0.4, 1.7]]`.
The built-in `default` grid has 18 points, sized to finish in under 15 minutes
on a 10-core laptop for seven frozen nights.

The tool verifies every file hash, the dataset content hash and the exact set
of archives before any replay. It then replays each tuning and validation night
once per distinct configuration, longest nights first, across `--jobs` workers
(default: all cores). Holdout nights are skipped unless you pass
`--include-holdout`. Use it only to score a candidate you have already chosen,
once, on nights it was not fitted to. Each candidate and split is scored with the pod's own
`evaluateBacktest`, against defaults on common support.

Outputs:

- `out/<candidate>/<split>.json`: per-night HR, breathing and HRV error, plus
  the full evaluator report. A metric without paired reference data reads
  `no_paired_reference`, never zero error.
- `out/ranking.json` and `out/ranking.md`: ranked by tuning HR error on each
  candidate's own readings, among candidates that keep at least `--min-coverage`
  (default 75%) of the defaults' Watch coverage; validation and holdout are shown
  alongside. Each split also shows the common-support difference against
  defaults. That difference reads 0 for a change that only withholds readings
  (such as `heart_rate.minimumPeakScore`), which is why it is not the ranking key.
- `--save-readings` also writes every replay's derived readings to
  `out/readings/<night>-<config>.json` for error analysis.
- `out/run.json`: timing, worker count and the Python build identity.

## 4. Check parity, then confirm on the pod

```sh
curl -fo pod-validation.json http://POD:3000/api/biometric-tuning/backtests/JOB_ID/result
pnpm biometrics:local-fit parity out/ pod-validation.json [pod-tuning.json]
```

`parity` compares local per-night HR error for defaults with the pod's
results. It exits non-zero if any night differs by more than 0.1 bpm.

For the top one or two candidates, create a revision with
`propose_biometric_profile`, using the same overrides. Its `resolvedHash`
matches the local report. Then run `backtest_biometrics` on tuning and
validation. Run holdout once, for the final candidate only. Only the pod's
report can back activation, and applying a profile still needs the user's
explicit authorization.

## 5. Replay archived nights

```sh
pnpm biometrics:local-fit replay --archive DEST/POD_ID --nights 2026-11-01,2026-11-02 --side left --config defaults out/
pnpm biometrics:local-fit replay --archive DEST/POD_ID --nights all --side left --config profile.json --compare-stored out/
pnpm biometrics:local-fit replay --archive DEST/POD_ID --nights 2026-10-18 --side left --config defaults \
  --export 2026-10-18=session-1184.tar.gz out/
```

`replay` runs whole nights from an off-pod archive (`pnpm biometrics:archive pull`,
[layout](../biometrics-archive/README.md#layout)) through the same unchanged
`replay_worker.run()` as `fit`, with one engine and one profile for every night.
No dataset export is needed; the archive database supplies each night's context.

- **Nights.** A night is the local noon-to-noon night (`--timezone`, default the
  machine's zone; use the pod's) in which a `sleep_records` row for `--side` was
  entered, the same key as the training repo. A night's sessions are replayed as
  one window, `[first entered_bed_at, last left_bed_at)`, with the pod's 5-minute
  pre-roll. Occupancy context comes from the sessions' recorded present and
  not-present intervals, built by the pod's own `recordedWaveformContexts`.
  `all` replays every such night that has RAW and lists the rest under `skipped`;
  a named night that can't be replayed is an error.
- **RAW.** Files written during the window, plus the next two (a file's mtime is
  at or after its last frame), are inspected with the shipped
  `inspection_worker`, or taken from the pod's own `biometric_raw_sources` row for
  the same bytes. Files with frames in the window are replayed in event order;
  the others are listed under `rawExcluded` with the reason. Overlapping files or
  more than 64 files in one night are refused. Inspections are cached in
  `out/inspections/`.
- **`--export NIGHT=PATH`** replays a night the archive has no RAW for from a
  `GET /api/export/archive` tarball (`./raw/<NAME>.RAW.gz`). Only the RAW comes
  from the tarball; the night's window and context still come from the archive
  database. The tarball is read, never changed.
- **`--config`** is `defaults`, an overrides array, one candidate
  (`{ "id", "overrides" }`) or a candidates file with exactly one entry. The
  other side always replays with defaults, as in `fit`; with no recorded sleeper
  mode the two channels are processed independently.

Outputs:

- `out/readings/<night>-<configHash[0:12]>.json`: `{ cohortId: night, configHash, side, readings }`,
  the `--save-readings` format.
- `out/replay.json` (`biometrics-local-fit-replay-v1`, labelled `exploratory-local`):
  side, timezone, archive directory, pod id, database SHA-256 and pull cursor,
  engine `manifestHash`, the config source, overrides and `configHash`, the
  Python build identity, and per night the session ids, windows, the RAW files
  replayed (SHA-256, pod name, bytes, event bounds) and left out, the
  runtime-config generations in effect (`biometric_runtime_receipts`), the
  config hashes recorded with the stored rows (`biometric_processing_runs`),
  reading count, worker counts and limitations, and wall time.

`--compare-stored` adds per-night parity against the archive's stored `vitals`.
It compares only `comparedSpans`: stretches where replay had RAW (gaps of at
most 60 s) and had warmed up for the 5-minute pre-roll. Rows elsewhere are
counted in `outsideRawRows`. An export that covers only one of the night's
sessions is the usual cause. Each stored minute is matched to the nearest
replayed reading within 30 s. It reports:

- `share`: minutes where both have a heart rate within 0.1 bpm. A minute where
  only one side has a heart rate counts against it.
- `shareWithinOneBpm`: the same with 1 bpm.
- `meanDifference`: signed bias, replay minus stored.
- `medianAbsDifference`, `meanAbsDifference` and `maxAbsDifference`.
- `heartRateCoverage`: replayed heart-rate minutes per stored heart-rate minute.

A night is gated only when every stored row's processing run recorded the
replayed config hash (`storedConfigHashes`). Receipts can say a generation
applied while the processor ran defaults. Rows without provenance fall back to
one receipted generation. The run exits 2 when a gated night's `share` is
below 95%.

Per-minute agreement with live rows is not pod-identical replay. Live writes
every 60–63 s on the arrival clock, and replay writes every 60 s on event time,
so a matched minute averages a window shifted by up to 30 s. On a real night
whose rows all ran defaults, replayed with defaults:

| Replay and live window ends | Median \|Δ\| | Within 0.1 bpm | Within 1 bpm |
| --- | ---: | ---: | ---: |
| within 3 s of each other | 0.00 bpm | 54% | 97% |
| 15–30 s apart | 0.55 bpm | 5% | 71% |
| all minutes | 0.33 bpm | 13% | 75% |

Bias was −0.11 bpm. Exact parity is what `parity` checks: local replay against
the pod's own replay backtest. Use `meanDifference`, `shareWithinOneBpm` and
`heartRateCoverage` to judge whether a replay reproduces what the pod stored.
