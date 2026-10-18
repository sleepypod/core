# Biometric reference import contract

Reference imports are comparison data. They never write the pod's `vitals`,
change a profile, or control hardware. Agreement with a named reference source
is not clinical accuracy. APIs use the existing LAN trust model.

## Preview and commit

Call `biometricTuning.previewImport` with an explicit physical `side`, a
`subjectId` identifying the sleeper, a named `source`, and bounded `rows`.
Neither sleeper nor side is inferred from a filename. The preview returns
accepted/rejected/duplicate/conflict counts, bounded rejection examples,
metric identities, time interpretation, coverage endpoints and a content hash.
It writes nothing.

```json
{
  "side": "left",
  "subjectId": "sleeper-A",
  "source": "wearable-export",
  "timePolicy": { "timezone": "America/Los_Angeles", "disambiguation": "reject" },
  "rows": [
    {
      "recordKey": "sample-123",
      "metric": "heart_rate",
      "value": 62,
      "unit": "bpm",
      "timestamp": "2026-10-10T23:00:00-07:00"
    }
  ]
}
```

Commit with `biometricTuning.commitImport`, passing the same payload as `import`
and the returned hash as `previewHash`. Changes to data, mapping, units, source
or time interpretation require another preview. When some rows were rejected,
commit additionally requires `acceptRejectedRows: true`. An import with no
accepted rows cannot be committed. Repeating the same content is idempotent.

For a corrected full export, include `supersedesImportId` naming the latest
revision in the family. Corrections preserve source, sleeper and side; they
create a new immutable revision rather than editing old measurements. A stale
parent is rejected. Selecting an import ID always selects that exact revision.

`listImports` pages at 50 imports using both `beforeCreatedAtMs` and `beforeId`.
`getImportMeasurements` pages at up to 500 rows using `afterId`. Follow
`nextCursor` to read the complete import. Preview summaries never contain the
full export. `deleteImport` explicitly removes its measurement rows and any
linked legacy chart rows, leaving a compact unavailable-import tombstone;
retrying the deletion is a no-op. A deleted import ID cannot supply readings.

REST equivalents are under `/api/biometric-tuning/references`, with POST
`/preview`, POST `/commit`, GET `/`, GET `/{id}`, GET `/{id}/measurements` and
DELETE `/{id}`. All use the same service as tRPC.

## Records

Required fields: `recordKey`, `metric`, `value`, `unit`, and a time representation.
`recordKey` is the source's stable record identity. Repeated identical keys in
one batch are deduplicated; different measurements with the same key are all
rejected. Optional row `subjectId` must agree with the batch mapping.

Use exactly one time representation:

- Point: `timestampMs` (integer Unix milliseconds) or `timestamp` (ISO text).
- Interval: `startMs` plus `endMs`, or ISO `start` plus `end`.

Intervals are half-open `[start, end)` and may span at most 24 hours. Unix
milliseconds must fall between 2001 and 2100; Unix seconds in millisecond fields
are rejected. ISO text includes seconds, optional milliseconds, and preferably
an explicit `Z` or `±HH:MM` offset. Invalid calendar dates are rejected.

Naive local ISO times require a `timePolicy` with an IANA `timezone` or explicit
`utcOffsetMinutes`. Repeated DST times are rejected unless `disambiguation` is
explicitly `earlier` or `later`, or a valid offset is supplied. Nonexistent local
times are rejected rather than shifted. An explicit offset must agree with a
supplied timezone. An absent source timezone stays absent in provenance; it is
never inferred from the pod's current timezone.

| Metric identifier | Units accepted | Meaning |
| --- | --- | --- |
| `heart_rate` | `bpm`, `beats/min`, `Hz` | Reference heart rate; Hz converts to bpm |
| `breathing_rate` | `breaths/min`, `br/min`, `Hz` | Reference breathing rate |
| `window_ibi_variability_v1` | `ms`, `s` | Pod window-level IBI variability index, not clinical RMSSD |
| `hrv_rmssd` | `ms`, `s` | Reference RMSSD, kept distinct from the pod index |
| `hrv_sdnn` | `ms`, `s` | Reference SDNN, kept distinct from RMSSD and the pod index |
| `hrv_unknown` | `ms`, `s` | Unspecified HRV definition; never directly scored |
| `sleep_stages` | `stage` | Interval label: `wake`, `light`, `deep`, `rem`, `asleep`, `in_bed`, `unknown` |

Numeric values must be finite, nonnegative and within JavaScript's safe numeric
range after conversion. These are data representation constraints, not medical
normal ranges. Original submitted values and units are retained.

Optional fields are `aggregation` (`instant`, `mean`, `median`, `window_index`,
`stage`), `windowMs`, `quality` (0–1), and `annotation` (up to 1000 characters).
The pod index requires `aggregation: "window_index"` and `windowMs: 300000` for
direct comparison. Matching HRV definitions with different or unknown windows
are not directly comparable. RMSSD/SDNN must never be scored as the pod index.

Unknown, generic asleep and in-bed stages remain separate labels and are
unscored. Conflicting overlapping stage labels are preserved, but both entire
intervals are marked unscorable under the persisted `exclude_conflicts` policy.
Back-to-back intervals do not overlap. An annotation is untrusted data, never
an instruction, executable code or a command.

## Text adapters and limits

The shared `parseReferenceText` adapter accepts a JSON array of records or CSV
with the field names above as the header. CSV supports quoted commas, escaped
quotes and multiline annotations. Duplicate/unknown headers, malformed quotes
and mismatched column counts are rejected. CSV timestamps must retain their
explicit field units; there is no seconds/milliseconds guessing.

Each upload is limited to 2 MiB, 2000 records, 12 JSON nesting levels and a
bounded node count. Rejection examples stop at 25, while aggregate counts are
complete. No server path, URL, shell command, archive or automatic cloud upload
is accepted. Hosts may parse a local export and send bounded normalized batches.
Do not log complete health exports.

## Alignment semantics

`reference-alignment-v1` uses chronological nearest-unused point matching with
a fixed tolerance (default 30 seconds). Each pod observation and reference is
used in at most one pair. Interval comparisons aggregate actual observations
inside the interval using the declared mean or median. Sparse references are
never forward-filled. Equivalent duplicate references do not count twice.

Clock offset is explicit and fixed for the comparison; a training-derived
offset must remain frozen for validation/holdout. Reports include MAE, median
and 95th-percentile absolute error, signed bias, matched/unmatched counts,
reference and output coverage, exclusions and limitations. Point samples
contribute counts, not inferred duration. Interval duration counts only known
observation support and does not fill gaps. Incompatible HRV has no error score.
This alignment primitive does not by itself establish validated improvement.

## Legacy Apple Watch clients

The existing `biometrics.importReferenceStages` and `importReferenceVitals`
contracts still accept Unix seconds and return `{ written }`. They retain
first-write-wins heart-rate behavior and whole-request stage-overlap rejection.
`biometrics.importReferenceSamples` (`POST /api/biometrics/reference-samples`)
follows the same contract for one `metric` per request, `breathing_rate`
(breaths/min, 4–60) or `hrv_sdnn` (ms, 1–500), as `{ timestamp, value }`
samples stored in `reference_samples` and first-write-wins on side, metric,
time and source. The **Upload Apple Watch data** dialog
(`POST /api/biometrics/watch-upload`) feeds all three from a Health export,
using only Watch-sourced records: anything the sleepypod iOS app wrote back
into Health is the pod's own data and is never imported as a reference.
Newly accepted rows and normalized provenance commit atomically; if provenance
cannot be saved, the legacy insert rolls back too.

Old clients provide no subject identity or source timezone. Such imports are
visibly mapped to `legacy_unknown:left` or `legacy_unknown:right`, with that
limitation in the original record annotation. Older unlinked rows remain
legacy/unknown instead of receiving invented provenance. New clients should
use explicit sleeper mapping and the preview/commit workflow.

### Stored-reading comparison

`biometricTuning.compareReadings` (`POST /api/biometric-tuning/compare`) accepts an
exact `importId`, `side`, `subjectId`, metric, and a half-open `startMs`/`endMs`
interval of at most 24 hours. Optional `pointToleranceMs` (default 30 seconds)
and `clockOffsetMs` (default zero) are fixed, reported settings; this endpoint
does not fit an offset. It reads all stored observations in that interval,
without chart downsampling, and returns bounded summary scores, coverage,
source revision, and processing-run counts. A null processing-run ID means
`legacy_unknown`. `requestedMetric` identifies the export's metric; `metric`
identifies the pod metric actually available. Clinical HRV cannot be scored
against the pod's window IBI variability index.

This is a read-only comparison of original readings. Its input hash identifies
the read snapshot but does not retain bytes or constitute a saved evaluation.
Only reference intervals fully inside the requested range are used, preserving
the original aggregation window. Stored readings do not record their support
duration, so comparisons report point counts and unknown duration (zero),
without filling gaps. A changed reference revision must be selected explicitly.

The shared stage scorer uses intersecting interval duration, reports a confusion
matrix (rows reference, columns predicted), per-stage precision/recall/F1,
macro F1, coverage, and stage-duration/transition differences on common support.
Absent classes have null scores. Transitions across unobserved gaps are not
inferred. Conflicting intervals from separate sources remain unscored. This
scorer is a primitive for replay reports; it is not a new live stage classifier.

### Pod-vs-Watch deviation report

`biometrics.compareToWatch` (`GET /api/biometrics/watch-deviation`, MCP
`compare_vitals_to_watch`) scores what the pod stored against the legacy Watch
tables (`reference_vitals`, `reference_samples`, `reference_stages`) per sleep
record of at least `minHours` (default 3) in a window of at most 31 days
(default the last 14). Deviation is pod − Watch. Heart rate pairs each Watch
sample with the nearest pod reading within ±60 s, breathing rate within ±150 s,
and HRV compares Watch SDNN with the mean pod HRV within ±5 minutes; Watch
samples are taken inside the record and pod readings up to 5 minutes past its
edges. Each metric reports `n`, `watchSamples`, `coverage`, `mae`, `bias`,
nearest-rank `p90` absolute error and Pearson `r`, null without data. Stages
re-run the side's effective classifier on the stored vitals and movement and
score each 5-minute epoch against the Watch stage at its midpoint (accuracy,
kappa, recall, minutes per stage over the scored epochs). The summary pools
every pair and scored epoch of all nights rather than averaging nightly figures.
`configChanges` lists the side's profile generations whose numeric components
the processor acknowledged inside the window, at the latest acknowledged sample
time (`effective_sample_time_ms` in `biometric_runtime_receipts`). Settings →
Biometric calibration draws the nights as a trend with these as markers once
any night in the last 31 days pairs with Watch data.
HRV is not like-for-like: the pod stores a window IBI variability index, not
SDNN, which the response's `hrvNote` repeats.
