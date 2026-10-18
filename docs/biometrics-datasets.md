# Frozen biometric datasets

`DatasetStore` retains bounded processed-data snapshots in `biometrics.db`.
It is the persistence layer for the calibration backtest workflow; it is not
yet a waveform replay service. Creating a dataset does not modify live vitals,
active settings, or hardware.

A snapshot contains the selected full recorded sessions, original vitals and
movement rows, exact reference import revisions and normalized measurements,
and available processing-run bundles. Unknown legacy processing provenance
stays null. Measured calibration bytes are not inferred from today's profile.
The manifest explicitly records that limitation and disables signal replay.
Stage replay must state its calibration-quality assumption when the original
quality context is unavailable.

Each snapshot owns its input bytes. Deleting or correcting a reference import,
or pruning original readings, leaves a frozen dataset unchanged. Dataset reads
verify the hash of both manifest and snapshot. Reusing an idempotency key
returns the original dataset; a different selection under that key fails.
Only one revision from a reference family may appear in a dataset. Both side
and asserted sleeper mapping must match its references.

The initial processed-data limits are 60 selected sessions, 20 reference
imports, 20,000 retained rows, 8 MiB per snapshot including its manifest, and
64 MiB across these snapshots. These are conservative service bounds, not a
claim about target-pod replay performance. Raw artifacts need separate retention
and free-space safeguards before signal replay can be enabled.

Whole-night grouping uses the selected timezone's local noon as the night
boundary. Overnight sessions and naps touching the same night stay together;
a session spanning noon connects adjacent night cohorts. Cohorts are sorted
chronologically before assigning tuning, validation, and holdout. Fewer than
three cohorts yields descriptive tuning only. More cohorts establish a split,
not validated improvement or adequate statistical power. ICU/timezone runtime
versions and the actual assignment are retained; later timezone updates cannot
silently change an existing dataset.

Coverage includes actual timestamp counts, duplicates, and leading/internal/
trailing gaps under an explicit nominal cadence. This estimates recording
availability, not measured signal support duration. Overlapping selected
sessions retain original row IDs; evaluators must deduplicate shared rows and
score one independent night cohort rather than treating sessions as independent
nights. Retrospective classification remains retrospective.

## Shared waveform replay driver

`modules/common/biometrics/replay.py` provides the internal streaming driver for
retained waveform experiments. Callers supply immutable per-logical-side
configurations, integer Unix-millisecond record times, recorded sleeper mode
and occupancy snapshots, pump-context availability, and an experiment output
sink. The driver does not read current bindings, occupancy files, or databases.
It processes both physical channels in left-before-right order using the same
sample repair, pump/presence gates, stateful estimator, and single-sleeper
arbitration as the live adapter.

Records must be ordered within the retained half-open time window. Each channel
is capped at 5,000 int32 samples per record; processor buffers retain only their
fixed windows. Pre-roll is processed, but outputs are scored only inside the
requested half-open scoring window. The output records preserve computed
logical side, physical source side, configuration hash, event timestamp,
quality, and flags, including when a held candidate is flushed after a mode
change. Context and outputs are immutable; outputs stream to the supplied sink.

Cold-start state and replacing live arrival time with recorded event time are
explicit limitations. Missing mode, occupancy, or pump context adds separate
limitations; unknown mode uses a disclosed two-side fallback. Less than five
minutes of pre-roll is also flagged. These labels do not claim exact historical
parity. The shared driver does not itself discover or retain RAW files, capture
historical context, or authorize a public waveform job. Those integration and
resource checks are required before dataset capabilities may advertise raw
signal replay.

`modules/common/biometrics/raw_artifacts.py` supplies retained-byte storage for
that integration. It accepts a selected `.RAW.gz` filename under a server-owned
archive directory, rejects path traversal, symlinks and non-regular files, and
copies into a private temporary file. It detects source changes, verifies gzip
expansion within a byte limit, hashes the exact compressed bytes, fsyncs the
copy, and atomically publishes a content-addressed artifact. Repeated retention
of identical bytes reuses the verified artifact. Deleting the rolling archive
thereafter does not remove the retained input.

A process lock serializes publication/quota checks and verified reads. Crash
staging files are reclaimed only while holding that lock. Published artifacts
are immutable and private (0600 files, 0700 directory); readers check their
size and SHA-256 before exposing a bounded decompression stream. A changed or
missing artifact fails rather than substituting an archive file with the same
original name. Gzip validation is not CBOR/frame or timestamp validation: the
record inventory must still establish those properties before advertising
waveform coverage.

The injectable retention limits default to 256 MiB compressed per artifact,
512 MiB expanded, 1 GiB and 1,024 published artifacts total, and a 512 MiB free-space
reserve. One additional compressed staging copy can exist while publication
is serialized, including during an idempotent retry at the published quota.
These are provisional storage limits, not a measured production replay policy.
Dataset references, release/garbage collection, record inventory, and job
admission must be integrated before this storage helper is exposed publicly.

`raw_records.py` adds a bounded firmware-CBOR decoder and retained-file inventory.
It supports the definite and indefinite maps/arrays/strings used by captured
firmware, with explicit record-byte, string-byte, node-count and nesting limits.
Container lengths are checked before allocation; duplicate/non-text map keys,
semantic tags, malformed UTF-8 and trailing values are rejected. The retained
iterator distinguishes clean end-of-file from a truncated outer RAW record and
counts empty sequence placeholders toward its record limit.

The inventory reports exact retained artifact identity, event-time bounds,
relevant record counts, usable dual-channel frames, lost-marker counts,
truncated sample tails, timestamp reversals and oversized channels. Its
`ordered_waveform_available` flag means the retained records meet this driver's
ordering and frame bounds; it does not establish continuous recording coverage,
complete pump context, or availability of occupancy/calibration snapshots.
Equal event timestamps are reported and preserved. Other sensor records are
counted without being misrepresented as waveform support. Numerical sensor
values retain CBOR float semantics; nonfinite or invalid event timestamps are
reported as unavailable for ordered replay.

`raw_sources.py` inspects server-owned cold archives without retaining them.
Discovery is bounded and excludes symlinks; inspection streams checksum,
expanded-size validation and record inventory. Its result explicitly states
`retained: false`. Selection passes the inspected descriptor as `expected` to
`RawArtifactStore.retain`; changed compressed bytes or sizes fail before
publication. A source name or successful inspection alone is never evidence
that a dataset has frozen input bytes. Persisted inventory caching and dataset
references remain responsible for tracking inspected versus retained state.

Migration `0028_retained_raw_artifacts` adds separate tables for inspected
sources, content-addressed retained artifacts, and ordered dataset references.
`RawSourceCatalog` validates the Python inspection contract, including matching
hashes, event bounds, record counts and ordered-waveform eligibility. Repeating
an inspection refreshes its timestamp; different evidence for identical bytes
and inventory version fails. Replacing a filename preserves the old identity
and marks it unavailable. A late failure for an old identity cannot mark newer
bytes unavailable.

Catalog queries return at most 50 entries per page for potential event-time
overlap. Unexpired inspection evidence is labelled `requires_reverification`,
not available or retained: selected copies still require the expected-descriptor
check. Source scans do not create datasets or retained-artifact rows. Shared
artifact references have unique dataset positions and cannot dangle; release
and file garbage collection must coordinate those references before deletion.
The catalog and schema do not yet enable public waveform jobs.

Dataset release now atomically tombstones its RAW references with the dataset
snapshot. Queued, running, cancellation-pending and interrupted jobs prevent
release. An artifact becomes eligible for collection only when its last live
reference is released; releasing another dataset never changes that timestamp.
This eligibility timestamp does not itself mean the file has been deleted.

`RawArtifactStore.collect_released` holds the same process lock as verified
readers and publication, then takes a SQLite immediate transaction while it
checks eligibility and unlinks files. The default one-hour grace period is
injectable. Directory traversal is bounded before any deletion; the collector
preserves unknown files/metadata, rejects symlinks and mismatched identities,
and keeps database tombstones. It scans present files, so previously collected
rows cannot starve later eligible files. Unregistered crash orphans are not yet
collected automatically.

The internal `retain(..., expected=descriptor, publish=callback)` hook allows a
trusted publisher to commit references before releasing the file lock, including
when reusing existing bytes. Publishers must lock files before beginning their
SQLite transaction, commit before returning, and never reacquire the file lock
inside the callback. Publication failure leaves complete bytes for recovery.
The public waveform dataset creation path and scheduled collector still need
to be wired through this protocol before waveform replay is enabled.

`retained_replay.py` connects immutable artifact descriptors to the shared
waveform engine. Its versioned `retained-waveform-input-v1` contract contains a
retained/pre-roll/scoring window, ordered artifact descriptors with inspected
event bounds, and frozen context intervals. It rejects duplicate or overlapping
artifact windows instead of guessing which boundary frames to discard. Missing
context intervals resolve to unknown; it never reads the current sleeper mode,
occupancy or calibration to fill historical gaps.

The adapter verifies retained bytes and consumes every selected file to EOF,
including events outside the scoring window. It checks actual event bounds and
ordering against the frozen input, then passes selected frames to the same
numerical driver as direct replay. Initial bounds are 64 artifacts, 1 GiB
compressed input, one million RAW records across all artifacts (including
empty placeholders), 20,000 context intervals and 20,000 output readings.
These are explicit implementation bounds, not a qualified pod resource policy.
The caller must also enforce a process deadline; cooperative cancellation does
not interrupt a file checksum operation already in progress.

Output sink rows are provisional until the adapter returns successfully. A
late archive integrity failure must fail the job and discard its staged result.
The returned run metadata includes consumed/decoded counts, exact artifact and
configuration hashes, processing counters and limitations. The public durable
worker still needs to capture this input contract, retain its references and
publish the completed result through its fenced job lifecycle.

The fixed Python entry point is `python -B -m common.biometrics.replay_worker
--retained-directory <server-owned-directory>`. Its input is one bounded JSON
`retained-waveform-work-v1` envelope containing `input` and both logical-side
`configs`. It opens existing retained storage in read-only mode: missing storage
or a missing lock fails, and it neither creates directories nor changes their
permissions. RAW retention/collection methods reject calls on that reader.

The worker emits bounded JSON-lines `reading` events and exactly one final
`result` on success. Readings explicitly identify HRV as
`window_ibi_variability_v1`; nonfinite output fails serialization. Input rejects
duplicate JSON fields and nonfinite constants. Errors emit one fixed diagnostic
without exporting inputs, paths or stack traces. CPU limits are 120 seconds
(121 hard), file descriptors are capped at 64, core dumps are disabled, numerical
thread counts are one, and process priority is reduced. These provisional caps
are not a qualified memory or pod admission policy and do not sandbox uploaded
code.

`runWaveformChild` provides the coordinator-side transport with a clean child
environment, 8 MiB input, 16 MiB output, 64 KiB event and 16 KiB diagnostic
limits, a 20,000-reading bound, and timeout/cancellation with TERM/KILL escalation.
It verifies event order, schema, final row counts and per-side configuration
hashes, returning readings only after a final result and zero exit. A missing or
failed worker never returns its provisional rows. Executable, module and retained
storage locations are internal server configuration and must not be accepted
from public requests. The transport is tested against the actual Python worker;
the coordinator still needs to invoke the frozen dataset publisher and durable
waveform jobs before public waveform capability can be enabled.

Waveform dataset publication now has an internal complete path. The TypeScript
preparer verifies a processed parent dataset, detaches its historical context,
and creates a new `waveform-dataset-v1` snapshot with one frozen input per
whole-night cohort. It preserves original observations and references, requires
matching scoring windows, normalizes cohort order, and hashes the complete new
snapshot. Shared artifacts must have identical descriptors and inspected event
bounds across cohorts. The parent dataset remains independently readable.

The fixed `common.biometrics.publication_worker` accepts a server-prepared row
and inspected source selections, with database/archive/retained paths supplied
only by server configuration. It opens an existing database, enables foreign
keys, and uses `retain_batch` to hold the file lifecycle lock through all copies
and reference publication. Copies and checksum/decompression verification finish
before the SQLite immediate transaction. That transaction inserts the dataset,
artifact metadata, and all ordered references together, enforcing the aggregate
snapshot quota. A failed transaction rolls back every database write. Complete
unreferenced files can remain after failure and still require orphan recovery.

Identical retries return the original dataset, including a released tombstone;
they do not resurrect it or require the rolling archives. A new dataset may
reuse exact retained bytes after rechecking compressed identity and expanded
size, even when the original archive directory has expired. Reusing an artifact
clears its collection eligibility only in the transaction adding its new live
references. Existing reference history and artifact creation time remain intact.

The shared reader understands both processed and waveform snapshot versions and
verifies their full content hashes. A committed integration test covers actual
archive inspection → TypeScript preparation → Python publication → shared
reader verification → Python numerical replay → release → collection, while
checking that canonical observations and the parent dataset remain unchanged.
Public `signalReplay` remains false until coordinator/API source selection and
fenced waveform-job/report integration are wired to this publisher.

## Off-pod fitting bundle

`GET /api/biometric-tuning/datasets/{id}/export` streams one live dataset as an
uncompressed tar: `bundle.json` (every other file with its size and SHA-256),
`manifest.json`, `snapshot.json` and the retained `raw/<sha256>.RAW.gz` archives
the snapshot references. The coordinator verifies the dataset hash, checks that
the live RAW references match the snapshot exactly, and hashes each archive before
anything is sent. The route hashes the archives again while streaming and aborts
on any change. Released or unknown datasets return 404; an integrity failure
returns 409 without streaming. The MCP tool `export_calibration_dataset` returns
the same index and the download path, never waveform bytes.
`scripts/biometrics-local-fit` replays these bundles with the shipped Python
worker and scores them with the shipped evaluator. Its reports are labelled
`exploratory-local` and are never activation evidence.

## Analysis snapshot export

`GET /api/biometrics/analysis-export?start=<ISO or ms>&end=<ISO or ms>&raw=1|0`
streams an uncompressed tar for off-pod analysis, such as comparing pod
biometrics with the Apple Watch. It replaces the ssh `backup()` + scp step and
`fetch_raw.sh`. The route is read-only and does no replay or backtest work:

- `biometrics.db`: a consistent online backup taken through a separate
  read-only connection. The backup is written to `os.tmpdir()` (tmpfs on the
  pod, so the eMMC is never written) and deleted when the stream ends, fails or
  the client disconnects. If the snapshot would not fit in tmpfs the route
  returns 507.
- `raw/<name>.RAW.gz` (when `raw=1`, the default): finished archives from
  `/persistent/biometrics-archive` whose file mtime falls in
  [start − 20 min, end + 45 min], oldest first. A frame is gzipped about 15 min
  after it closes, so the widening catches the frames that overlap the window.
  `*.tmp.*` partials and symlinks are skipped.
- `manifest.json`: the last entry, written once every other file has been
  hashed during streaming. Fields:
  - `formatVersion`: `analysis-export-v1`.
  - `generatedAt` / `generatedAtMs` and `build` (branch, commit, title and build
    date from `.git-info`).
  - `pod`: `id` is a stable pod identifier, HKDF-SHA256 over the same
    hardware-rooted seed chain the HomeKit identity uses (eMMC CID, then eMMC
    serial, then `/etc/machine-id`; ADR 0020). It is the same on every export
    and survives reinstalls; the seed itself never leaves the pod. `idSource`
    names the seed used (`id` is null on a dev machine with no hardware seed).
    `hostname`, and `model` (`podVersion`, model name and sensor hardware
    revision from the last DAC status poll, or null before the first poll).
  - `schema.biometrics`: the latest applied drizzle migration in the snapshot
    (`migrationHash`, `migrationCreatedAt`, `migrationTag` from the migration
    journal, `appliedMigrations`).
  - `window`: `requested` start/end, `rawSelection` (the widened mtime range and
    `includeRaw`) and `served` (archive count and the min/max mtime of the
    archives actually included).
  - `files`: every other entry with `bytes` and `sha256`; raw entries also carry
    the original `name` and `mtimeMs`.

The window must be at most 14 days with start before end (400 otherwise). If
the window's RAW archives total more than 2 GiB the route returns 413 without
taking a snapshot; narrow the window or pass `raw=0`. One export runs at a time
(429 while another is streaming). `Content-Length` is exact, so a download cut
short by a pruned archive or a dropped connection is detectable.

The MCP tool `export_analysis_snapshot` (tRPC `biometricTuning.describeAnalysisExport`)
returns the download path, archive count, RAW bytes and an estimated tar size
for a window, never the bytes themselves.

**Privacy:** the snapshot is the full biometrics database for both sides of the
bed plus raw sensor waveforms. Download it only to trusted machines and don't
share it.

```sh
mkdir -p snapshot && curl -fsS "http://POD:3000/api/biometrics/analysis-export?start=2026-10-15T09:16:00Z&end=2026-10-15T15:24:00Z" | tar -xf - -C snapshot/
```
