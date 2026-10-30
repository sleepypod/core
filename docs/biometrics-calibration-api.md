# Biometric calibration API

The `biometricTuning` tRPC router and `/api/biometric-tuning/*` OpenAPI routes
share the same services. They use the existing LAN trust model. Supplied
requester names are attribution, not authenticated identities.

## Inspect and create profiles

- `getManifest` returns the versioned default, parameter schema and current
  manifest hash.
- `getProfileOverview` separates desired configuration, the existing stage
  view, sensor-calibration freshness, and observed runtime receipts. No receipt
  means unreported, not applied. A legacy stage customization awaiting migration
  remains visible.
- `resolveProfile` validates explicit leaf/ordered-array overrides and returns
  the resolved snapshot, hash and override provenance without saving anything.
  Omit a path to restore inheritance; null does not mean remove.
- `createProfileRevision`, `getProfileRevision`, and `listProfileRevisions`
  create and inspect immutable candidates. Creating one does not bind it or
  write an activation outbox event. Public origins are manual or agent;
  migration/system origins are reserved for server workflows.

Manual activation is available. Desired profile state must not be presented as
actual runtime adoption; availability means requests can be queued, not that a
processor is currently healthy or has adopted a particular revision.

## Retain data and submit work

`listSessions` is cursor-paginated and side-specific. `getSessionCapabilities`
reports actual processed timestamp coverage, gaps, reference metric counts,
and unknown processing provenance. Raw waveforms are marked not inventoried;
the presence of processed readings does not imply signal replay capability.
Reference counts include revisions, so dataset creation requires explicit
import IDs and accepts only one revision per family.

`createDataset` takes side, asserted sleeper ID, session IDs, reference import
IDs, and an idempotency key. The server pins the configured device timezone.
`getDataset` and `listDatasets` return metadata/manifests, not the retained raw
rows. Snapshot integrity is verified on a dataset read. Reference deletion and
observation retention do not change an existing snapshot.

`createExperiment` pins a dataset and descriptive protocol: evaluation mode,
explicit assumed stage-calibration quality, and fixed alignment tolerance and
clock offset. `enqueueBacktest` takes the experiment ID, exact candidate
revision ID, expected binding generation, split, and idempotency key. Callers
cannot supply default/current snapshots, evaluator hashes, or executable paths.
The server resolves them. The current stage baseline comes from the actual
retrospective view, not a pending desired vitals profile.

The current evaluation scopes are original-reading comparison and stage rules
on original readings. Waveform parameter changes are not evaluated by these
scopes. The job descriptor states this explicitly.

`listBacktests`, `getBacktest`, `cancelBacktest`, and `getBacktestResult` expose
bounded job history, progress, cancellation and verified results. Enqueue
persists work; an admitted worker host must execute it. A queued response is
not a completed result or an activation. Result reads include the current
holdout exposure count. Existing successful retries return the original job
when the same public submission key and payload are supplied.

`getBacktestSummary` (`GET /biometric-tuning/backtests/{id}/summary`) is the
interactive review path. It verifies the complete report in the coordinator,
then omits stage-trace rows before IPC and HTTP serialization. All scores,
per-night comparisons, support, provenance, and operational measurements remain.
Its `projection` is `scores_without_stage_trace_rows_v1`; `contentHashScope` is
`complete_retained_report`. The hash identifies the retained full artifact,
not the summary's serialized bytes. Summaries exceeding 2 MiB fail explicitly
rather than silently truncating nights or scores. `getBacktestResult` continues
to return the full verified report, and `getBacktestTrace` pages exact trace
rows using that same retained hash. The UI and MCP report reader use the summary
path; release and holdout exposure semantics are unchanged.

The backtest host loop, measured resource admission, richer promotion reports,
and full client UI/MCP integration remain separate implementation steps. The API does not claim that these are enabled merely because job
submission exists.

Profile diffs report both changed resolved values and changed override intent,
including explicit-default overrides whose numerical output is unchanged.
`validateProfileRevision` checks schema/engine compatibility only; it explicitly
leaves evaluation evidence unchecked.

Experiment creation requires an idempotency key. `getExperiment` and
`listExperiments` preserve access to its frozen protocol and audit identity.
If the creation reply is lost, retry the exact dataset ID, normalized protocol
and key. A committed match returns the original experiment even after its
dataset inputs are released; it does not reopen or restore those inputs. Reusing
the key for a different request remains a conflict. A new key still requires
valid, retained inputs, and malformed protocols or keys are always rejected.

`releaseDataset` is explicit and idempotent. It refuses release while queued,
running, cancellation-pending, or interrupted jobs still need the inputs.
After cancellation or completion, release removes the retained input snapshot,
keeps its manifest/hash and holdout audit metadata, and marks it unavailable.
Existing reports remain separate retained results. New runs cannot use a
released dataset; a fresh snapshot requires a fresh creation key. Storage
accounting continues to include the retained manifest. Active configuration
lives in the configuration database and is unaffected.

Canonical dataset/report hashing uses the same finite-number encoding as
configuration hashing, with a separate bounded budget for realistic multi-night
rows. Configuration limits remain unchanged. Dataset hashes are checked when
reading retained input data, and metadata reads verify available snapshots;
released metadata remains readable without pretending inputs still exist.

Activation history is available through `listActivationHistory` (side and
optional `beforeGeneration` cursor). Pages contain at most fifty events and
include fallback/default-update evidence. Profile overview separates its
historical receipts from `runtimeHealth`, which reports current numerical
heartbeat freshness and configuration consistency. General and legacy stage
settings use the same versioned intent and acknowledgment protocol.

## Manual activation and observation

- `activateProfile` / `POST /biometric-tuning/activate` selects an exact revision.
- `resetProfile` / `POST /biometric-tuning/reset` selects current shipped defaults
  without deleting revisions or audit history. Malformed unmigratable legacy
  stage settings are retained in the legacy row and reset audit evidence; valid
  unmigrated customizations must first be preserved as a revision.
- `rollbackProfile` / `POST /biometric-tuning/rollback` selects the previous
  binding, including its exact revision identity (null means the default binding).

All three require side, expected binding generation, expected resolved hash,
immediate/next-session boundary, requester, idempotency key, and explicit
`allowUnvalidated: true`. These are deliberate manual changes, recorded as
`manual_unvalidated`. They do not assert that a backtest established improvement.
A stale binding, changed idempotent request or mismatched hash is a conflict.
Creating or evaluating a candidate never calls these mutations implicitly.

`getActivationStatus` / `GET /biometric-tuning/activation-status` accepts a side
and optional event ID. It returns the persisted audit event, observed delivery
and matching-receipt state, receipt freshness and whether the event still
belongs to the desired generation. Polling is read-only and cannot acknowledge
the stage consumer. The persisted event can lag observed receipts until the
five-second reconciliation pass. An applied old event is history, not proof it
is still selected; check `isCurrent` and the overview's current runtime health.

The cross-runtime integration test uses temporary fixture databases and the
locked piezo environment. Prepare it with
`cd modules/piezo-processor && uv sync --locked --no-install-project`, then run
`pnpm exec vitest run src/biometrics/profiles/tests/runtime-integration.test.ts`
from the repository root. The JS unit-test CI job installs that same environment.
The test runs the shipped Python adapter with a synthetic frame, verifies the
next-session boundary, TypeScript stage receipt, restart restoration and rollback;
it neither starts a sensor follower nor accesses hardware.

## Releasing completed reports

`releaseBacktestResult` (`POST /biometric-tuning/backtests/{id}/result/release`)
requires the job ID and `expectedContentHash`. It applies only to successful
jobs and rejects a mismatched hash. Repeating the same release is idempotent.
The result endpoint now includes `available` and nullable `releasedAtMs`.
After release it returns `available: false`, `report: null` and the original
content hash, completion time, winning fencing token and current holdout count.
A released report is distinct from a job that has not completed (which still
returns null as the whole result).

Release removes inline payload bytes or detaches an artifact descriptor in a
transaction before deleting the file. It does not erase experiments, jobs,
holdout exposure, profile revisions or activation history. A retried enqueue
with the same idempotency key still resolves to the original successful job;
it cannot recreate released bytes or erase previous holdout use. A new replay
requires a new request key and available retained inputs.

The additive biometrics migration `0027_release_backtest_reports` preserves
existing reports with a null release timestamp. Older readers cannot validate
a released payload against the original hash, so they report an unavailable or
corrupt result rather than silently displaying different data. UI/MCP clients
must use the explicit availability fields when presenting released evidence.

## Paginated stage traces

`getBacktestTrace` (`GET /biometric-tuning/backtests/{id}/trace`) requires
`expectedContentHash` and `configuration` (`default`, `current`, or `candidate`).
It accepts an optional `cohortId`, an `offset` (default zero), and `limit`
(default 200, maximum 500). The hash must match the verified retained result.
Unfinished jobs reject trace requests, changed hashes return a conflict, released
reports return not found, and comparison-only runs report that no stage replay
was produced. Missing cohorts/configurations and cursors beyond the selected
trace are errors rather than fabricated empty results.

The response includes exact intervals, configuration hashes/revisions, cohort
and source-window identities, the total selected interval count, and
`nextCursor: { offset, contentHash }` or null. Reuse that offset and hash as
`offset` and `expectedContentHash`, keeping the selection unchanged. No
intervals are downsampled or interpolated. Trace timestamps precede the fixed
reference-alignment offset, which is returned separately as `clockOffsetMs`.
The provenance is explicitly `versioned_stage_replay`, not original observed
stages. Filtering/pagination never changes evaluation scores.

This bounds response detail, not artifact-read cost: the service currently
verifies the entire retained report before selecting a page. Parent-process
artifact parsing and hashing remain part of the target performance qualification.


## Retained waveform discovery and publication

`getReplayAdmission` (`GET /biometric-tuning/replay-admission`) reports whether
server policy is configured, its operator-supplied qualification ID, and current
admission reasons. `SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY` is server-owned JSON
matching `admissionPolicySchema`; missing or malformed policy denies admission.
Supplying an ID does not itself qualify hardware. Each check uses fresh process,
storage, thermal, and live piezo receipt evidence; no caller can supply health
samples or override admission through an RPC parameter.

`inspectRawSource` (`POST /biometric-tuning/raw-sources/inspect`) accepts only
`afterName`, initially null, and inspects at most one server-owned archive.
Persisted evidence is a mutation even though scanning does not modify the
archive. Reuse `nextCursor` until `complete`; `source_unavailable` advances past
an unreadable source, and `archive_unavailable` reports a missing archive root.
`deferred` preserves the cursor and means no new scan was admitted. This API
accepts neither filesystem paths nor executable code.

`listRawSources` (`GET /biometric-tuning/raw-sources`) accepts `startMs`, `endMs`,
and optional `afterId`, returning at most fifty descriptors and a cursor. Query
all selected cohort windows including five minutes of pre-roll. Catalog event
bounds indicate possible overlap, not continuous support. Descriptors explicitly
say `requires_reverification`; inventory alone has not retained any waveforms.

`createWaveformDataset` (`POST /biometric-tuning/waveform-datasets`) accepts a
parent dataset ID, its exact `expectedContentHash`, an idempotency key, and
`cohorts: [{ cohortId, sourceIds }]`. The server derives context from that frozen
parent, re-verifies selected archives, and atomically retains inputs and publishes
the immutable dataset. New publication requires ongoing admission; a `deferred`
response contains no dataset. A retry of already committed publication returns
the original descriptor even when current admission is unavailable or original
archives have disappeared. Changed selections under the same key conflict.
Released descriptors remain released; retries never recreate their bytes.

Create a `signal_replay` experiment using the published dataset, then submit and
poll a durable backtest. Publication does not start a worker host or activate a
profile. Host qualification and scheduling remain separate operational gates.


The retained-dataset UI exposes **Select recorded waveforms** on available
processed datasets. It inspects one archive per explicit request, keeps scan
cursors on deferral, and preserves source selections across pages and nights.
Every parent cohort requires a selection, with at most 64 source IDs per cohort.
Publication pins the parent content hash and reuses its request key after a lost
reply or deferral. Released publication retries are shown as unavailable.

Published waveform datasets offer **Replay retained waveforms** in the protocol
editor. Sleep-stage replay is optional and requires an explicit calibration
quality assumption; numerical-only replay does not. Protocol creation and queued
submission still depend on the separate worker host for execution. The browser
demo contains no RAW archive fixture or qualified pod telemetry, so its waveform
operations remain explicitly deferred.

### Numeric objective policies

Signal-replay protocols may pin an `objectivePolicy` with version
`numeric-objective-v1`. Its metric, minimum supported nights and paired references,
maximum lost-observation fraction, minimum MAE improvement, night and subgroup
regression tolerances, required subgroup names, and operational limits are included
in the protocol hash. Processed-reading protocols reject numeric objectives.
Reports retain the thresholds and per-baseline `objectiveAssessments`.

Caller-supplied thresholds are not a designated promotion policy. The current
production evaluator has no designated policy and does not yet attach measured
operational or subgroup evidence, so its assessments remain insufficient evidence.
The pure assessor checks an independent first-use holdout, supported whole nights,
uncertainty, coverage, subgroup regressions, and measured operational limits before
it can award improvement under a designated policy. Test-only thresholds exercise
boundaries; they are not release defaults or evidence of clinical validation.

### Replay host startup

After migrations and hardware initialization, production startup reads
`SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY`. A missing or invalid policy leaves the
background host stopped. A valid policy starts the existing singleton host;
startup does not assert that hardware has been qualified. Its execution and
cleanup operations still obtain fresh admission, including live piezo receipt
age. CI skips this startup with the other hardware-dependent services. Shutdown
aborts and awaits the host before closing the coordinator.

Deploy only a policy backed by recorded pod measurements. Configure the matching
`SLEEPYPOD_BIOMETRICS_REPLAY_BUDGET` before process startup; the coordinator captures
that budget when its singleton is created. Changing process environment requires
a service restart to start a previously disabled host or replace that budget.

New waveform dataset manifests advertise retained-input replay capability.
Execution availability remains a separate, current admission query. Older
immutable manifests and their hashes are not rewritten by this change.

### Exact numeric trace pages

`GET /api/biometric-tuning/backtests/{id}/numeric-trace` (tRPC
`getBacktestNumericTrace`, MCP `backtest_biometrics` action `numeric_trace`)
returns up to 500 exact recomputed readings per page. Supply the immutable report
`expectedContentHash`, configuration label, optional cohort, and offset/limit.
The next cursor carries the same hash. Released results and stale hashes fail;
paging does not rerun an experiment or change its scores.

Pages contain only the report dataset's side, within its scoring windows. They
preserve null readings, quality, flags, routing provenance, and the original
replay timestamp; `clockOffsetMs` is metadata for reference alignment and is not
applied to the returned timestamp. Opposite-side readings and internal `hrRaw`
values are excluded. No downsampling is performed. Historical reports without
explicit side provenance cannot supply this projection. Numeric trace UI and
reference overlays remain separate consumers of this API.

Waveform reports expose these pages through **Inspect numeric traces**. Select a
night, configuration, and metric; the chart shows only that page's individual
readings. The exact-value table includes missing values, quality, flags, source
channel, and limitations. Changing night/configuration resets the cursor. The
processed-only demo does not fabricate waveform readings for this view.

### Frozen reference pages

`getBacktestReferenceTrace` / `GET .../backtests/{id}/reference-trace` and MCP
`backtest_biometrics` action `reference_trace` require a report hash, cohort,
metric, and bounded offset/limit. They read the immutable dataset selected by
that report, verify its hash, and expose the frozen import revision, source,
normalized measurement, compatibility reason, and original reference times.
They never resolve the current revision of an import. Original submitted payloads,
annotations, and subject fields are excluded.

These are display records, not newly matched pairs or independent evidence.
Point/interval and aggregation semantics remain explicit. HRV-family records
with an incompatible definition remain inspectable with their compatibility
reason. Scoring-window boundaries are preserved. A released report or dataset
makes this detail unavailable; it does not silently fall back to live data.

In a waveform report, open **Inspect numeric traces**, then **Compare frozen
references**. The overlay pages references independently from recomputed readings
(200 records per page), preserves point and interval shapes, and applies the
experiment's fixed clock offset only to recomputed timestamps. The source table
keeps reference timestamps in UTC. Incompatible definitions remain visible in the
table but are not plotted. Display overlap does not establish a new scored pair;
use the report's frozen alignment and common-support scores for comparisons.

### Numeric subgroup evidence

Waveform experiments with a numeric objective additionally compute
`reference-defined-numeric-subgroups-v1` for that objective's metric. Fixed IDs
are `reference_points`, `reference_intervals`, `window_first_half`, and
`window_second_half`. Membership uses native reference timestamps and temporal
kind, never candidate values, errors, or missingness. Each disconnected scoring
window has its own midpoint. A point at the midpoint belongs to the second half;
an interval ending there belongs to the first. Intervals spanning the midpoint
are excluded from both half-window groups without splitting or changing their
aggregation; the report retains their excluded count.

With all three numeric objectives and three configurations, the retained
`numericSubgroupSummary` has up to 36 rows: four groups × three metrics × three
pairwise comparisons. The bounded web projection accepts all 36; it must not
truncate a valid multi-metric report to the 12 rows for a single metric. Metric
identity, reference membership and missing scores remain separate in each row.

Each group uses the same all-configuration common timestamp support as the main
numeric comparison. References are weighted within a night, then nights receive
equal weight. Objective evidence requires the configured minimum paired records
in every included night; an unsupported night makes that group's mean unavailable
for promotion rather than silently dropping it. A required group with inadequate
night support blocks improvement. Per-window observation coverage counters still
refer to complete scoring windows, not inferred continuous coverage within a
reference subgroup. The report UI shows subgroup means, night counts and boundary
exclusions. Groups overlap and are not independent statistical experiments.
They do not establish motion, pump, empty-bed, or artifact-specific performance;
those require separately qualified context/fixture evidence. Unrecognized required
group names remain unsupported and cannot award improvement.

### Stage objective evidence

`stageObjectivePolicy` freezes a `stage-objective-v1` policy alongside the
experiment protocol. It requires `stage_replay`, or `signal_replay` with
`waveformStages: true`; plain comparison cannot evaluate a stage objective.
Numeric and stage policies are separate, and a joint replay may retain both.

The stage policy sets minimum independent nights and paired reference duration,
minimum candidate output coverage, maximum loss of baseline output from shared
support, minimum equal-night agreement improvement, tolerated night regressions,
macro-F1 regression, and required-stage F1 regression/support. Common-support
confusion durations are combined within each whole night before scoring. The
uncertainty gate uses the lower bound of the frozen whole-night agreement
bootstrap; epochs are not treated as independent nights. Missing required stages
on any evaluated night remain insufficient evidence, never fabricated zero error.

`stageObjectiveAssessments` preserve the exact policy and evidence for candidate
versus both default and current configurations. The coordinator replaces any
scorer-supplied operational evidence after the final admission check, using the
same explicit sampling-policy rules as numeric objectives. Only a separately
designated qualified policy can award improvement. The UI presents thresholds,
missing evidence and regression reasons. These are agreement results against the
named stage reference, not claims of clinical stage accuracy or live activation.

### Evidence verification before activation

The internal profile evidence verifier checks retained report bytes and exact
candidate revision, current configuration, shipped default, dataset/side, frozen
holdout cohorts, protocol, evaluator build, and waveform dependencies. Reused
holdout data or released artifacts cannot pass. These expectations must be
loaded by the service; they are not client assertions.

The verifier recomputes objective assessments using supervised operational
measurements and separately designated policies. It requires both baseline
comparisons and every frozen holdout night. A changed stage configuration must
improve stage agreement; a numeric change must improve its metric and pass
downstream stage coverage/regression checks, which may report no material change.
An assessment of one numeric metric cannot validate changes to another metric.
A signal replay can freeze `objectivePolicies`, a list of one to three numeric
policies with unique metric identities. It is mutually exclusive with legacy
`objectivePolicy`; legacy snapshots and hashes remain unchanged. Evaluation,
supervisor finalization, and activation verification require candidate comparisons
against both default and current for every policy. Each changed numeric component
must have its own qualified improvement evidence; a passing heart-rate objective
cannot validate breathing or HRV changes. Stage objectives remain separately
required for downstream effects. Report displays group thresholds and reasons by
metric. These policy lists do not themselves designate a production policy.

The internal validated activation service loads the retained job, experiment,
dataset, report, profile revision and current runtime baseline. It verifies
the report before acquiring write reservations, then rechecks report/dataset
availability, fencing identity, holdout exposure, runtime baseline and binding
generation before committing. A short biometrics write reservation prevents
concurrent exposure, release or runtime writes until the configuration commit
finishes. Full report parsing and hashing happen before this reservation; the
final artifact checks read only metadata. Only the configuration database is
written: binding, evidence audit and outbox intent commit together.

The audit keeps the evaluation ID, report/configuration/build hashes, policies
and assessment summary even if biometric artifacts are later released. An exact
idempotent retry returns the original activation event without requiring those
artifacts again. Changing the request under the same key is rejected; manual
and validated requests cannot alias one another. A successful request still
returns `pending_delivery`, not proof of processor adoption.

Stage replay now captures the entire acknowledged current configuration, including
numeric parameters, instead of substituting defaults for those parameters. Pending
or incompatible personalization blocks validated activation. Qualified production
policy designation remains unfinished. The shared
`activateValidatedProfile` procedure (`POST /biometric-tuning/activate-validated`)
accepts the exact revision, resolved hash, binding generation, evaluation ID,
report hash, processing boundary, requester, and idempotency key. Build hashes and
policy designations are resolved on the server. New requests currently fail closed
because no production policy is designated. Exact retries precede build probing
and artifact lookup. MCP `apply_biometric_profile` exposes the same procedure with
`action: "activate_validated"`; it does not accept `allowUnvalidated`. Explicit
manual activation retains its existing unvalidated semantics.


The holdout report UI offers application of its exact candidate and report hash.
`reviewValidatedActivation` (`GET /biometric-tuning/validated-activation-review`)
performs a read-only eligibility check using the same stored evidence and installed
build authority. A review creates no activation event or outbox item, and cannot
reserve evidence: application repeats verification and its transactional guards.
The apply control remains disabled when review fails or is refreshing. Once sent,
an uncertain request retains its exact identity and boundary for retry, including
when detailed report data is subsequently released. Processor adoption is polled
separately. The demo explicitly rejects validated activation of synthetic evidence.


Promotion designation also pins the complete experiment protocol hash. Matching
objective thresholds alone is insufficient: changes to clock offset, alignment
tolerance, assumed stage calibration quality, uncertainty settings, replay mode,
or objective lists require qualification of the resulting protocol. This server
value cannot be supplied through activation or review requests. The audit already
retains that exact protocol hash. This identity gate does not establish that missing
historical pump/occupancy context is acceptable; replay-context qualification is
still a separate release requirement.


Waveform promotion also requires a server-designated list of accepted replay
limitations. The verifier reads both per-run and per-reading diagnostics across
every held-out cohort and distinct configuration, verifies their retained payload
hash and build/configuration identities, and rejects missing or duplicate outputs.
Missing pump/occupancy/sleeper-mode context, short pre-roll, cold starts and event
clock substitution cannot pass merely because numeric scores improved. Unknown
limitation codes cannot be designated until the contract is reviewed. Activation
audit evidence records both the accepted list and the limitations actually observed.
No production replay-context allowance is installed yet; this gate does not by
itself qualify any approximation.


The publisher and activation service share a release-installed qualification
registry, `promotion-qualifications.json`, beside the packaged replay worker.
Its version is `biometric-promotion-qualifications-v1`; each entry pins the full
protocol, manifest hash, evaluator build hash, optional Python build hash,
qualification ID, fixture and pod evidence hashes, and replay-context allowance.
Every objective policy must use the entry's qualification ID. Exactly one matching
entry is required. Missing, malformed, oversized, duplicate or mismatched entries
grant no designation. Reads are capped at 256 KiB; no public endpoint writes this
registry. Evidence hashes identify release-reviewed artifacts; loading a registry
is not itself a qualification experiment. The publisher additionally rejects
context outside the registered allowance before awarding metric-level statuses.
No production registry has been generated or installed yet.


The supervisor now derives the overall retained report status with the same
assessment logic used for activation. `improved` requires complete qualified
independent evidence for every changed domain and acceptable downstream stages.
Supported failures produce `regressed`; insufficient support remains
`insufficient_evidence`, incompatible metric evidence is `incompatible`, and
supported outcomes below the improvement threshold are `no_material_change`.
An identical candidate/current configuration is also reported as no material
change. The supervisor replaces worker status claims. The UI displays these as
historical evaluation outcomes; an improved report never substitutes for current
activation review, holdout-exposure checks, or processor acknowledgement.

## Original vitals provenance and CSV compatibility

`biometrics.getVitals` retains its array and existing numerical fields. It now
adds nullable `processingRunId` and `provenance` metadata for each original
observation: `interpretation: original_observation`, a status, the recorded
configuration hash, and the recorded HRV metric identifier. The run must belong
to the same side and be a live run. Missing associations are `unavailable`; rows
without a run remain `legacy_unknown`. A missing, malformed, or unavailable HRV
definition stays null. The current shipped manifest is never used to infer an
old row's metric identity. This metadata describes the recorded association;
it is not validation evidence or a current processor-health receipt.

Only bounded scalar metadata is projected from the processing bundle. The raw
bundle, input identity, and unrelated fields are not returned. A future recorded
HRV metric identifier is preserved rather than relabelled as the current window
IBI variability index. Consumers must keep different/unknown definitions
separate when computing comparable baselines.

Summary and baseline responses now include exact SQL aggregate provenance counts
across the full selected range, independent of chart pagination: distinct recorded
configurations (manifest plus resolved configuration hash), unknown configuration
rows, HRV definitions and unknown HRV rows. Mixed known definitions, or known
and unknown HRV values together, produce null HRV aggregates. Entirely legacy
ranges retain their descriptive values with `legacy_unverified`; no definition
is inferred. All baseline means and deviations are null when multiple recorded
configurations or recorded/unknown configurations coexist. A summary may still
describe original HR/breathing values across configurations, with explicit counts.

The chart separates recorded processing runs and HRV definitions before smoothing,
omits bands/statistics across those boundaries, and explains original/unknown
provenance. Its raw log exposes run IDs and HRV definitions. Unknown legacy rows
remain unverified: missing history cannot prove that their processing was uniform.
A run boundary is deliberately conservative even when two restarts used the same
configuration. This is distinct from the manifest/configuration counts in the
whole-range API summary.

The vitals CSV keeps its original five columns first and appends interpretation,
processing-run ID, provenance status, configuration hash, and HRV metric ID.
Unavailable definitions are written as `unknown`, never inferred as clinical
RMSSD. Missing numerical values remain empty. Metadata cells are CSV-escaped
and spreadsheet-formula prefixes are neutralized. Older consumers can continue
using the original named columns; positional consumers must accept appended
columns. Demo/older responses without metadata export unknown provenance.
