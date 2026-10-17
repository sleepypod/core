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
