# Initial synthetic replay measurement

Measured on the requested pod (`192.168.1.88`, SSH port 8822) on October 12,
2026. This is an initial worker-cost measurement, not the final admission-policy
or end-to-end live-system qualification.

| Property | Observation |
| --- | --- |
| Runtime | ARM64, four CPUs, Node 24.16.0 |
| Physical memory | 2,014,796 KiB |
| Available memory before / after | 1,440,260 / 1,425,340 KiB |
| `/persistent` available before | 3,741,108 KiB |
| One-minute load before / after | 0.54 / 0.36 |
| Input | 27 separate 12-hour nights, 720 minute readings each; 19,440 readings total |
| Input bytes | 2,374,215 |
| Configurations | Identical default/current; one unique numerical evaluation after deduplication |
| Child settings | nice 19, 128 MiB Node heap limit, 30-second external timeout |
| Evaluator elapsed time | 2,519.355 ms |
| Child peak RSS | 132,436 KiB (about 129 MiB) |
| Complete report size | 2,450,542 bytes |
| Core / piezo service status | Both active before and after |

The shipped worker SHA-256 was
`16bab5135fcf0ba4d4a1624660f8565ba0b073cf39e7d13760df17347cd24d6a`.
Input was generated from the repository's processed-backtest fixture, expanded
to daily-separated nights with synthetic `60 + sin(minute / 10) * 8` BPM,
HRV index 30 and breathing rate 14. No personal recordings were transferred.
The worker and synthetic input/output existed only in a unique temporary pod
directory, which was removed after measurement. No live database, service
configuration or hardware controls were changed.

The report exceeded the old 2 MiB inline limit. That concrete failure motivated
the large-report artifact path rather than reducing dataset size or dropping
traces. The worker was invoked directly for measurement; the old repository
would have rejected publication of this report.

Still required before choosing final admission limits: three distinct candidate
configurations, repeated and worst-case inputs, wall-clock startup/serialization,
artifact I/O, CPU utilization, SQLite contention, ingest age, temperatures and
control/API responsiveness while replay runs. Service `active` status alone does
not prove those properties. This measurement does not cover waveform replay or
untrusted algorithm execution, and does not justify a universal speed claim.

## Three-configuration follow-up

On October 12, the same pod and worker hash completed three consecutive runs
with distinct default/current/candidate configuration hashes. Input remained
27 synthetic twelve-hour nights (19,440 readings). The deep-stage HR-ratio
thresholds were 0.92, 0.90, and 0.94 respectively. Other input and protocol
settings were unchanged, including assumed calibration quality zero. These
are distinct evaluations, but this fixture does not exercise every stage branch
or establish a worst-case runtime.

| Run | Wall time, including child startup/output | Evaluator time | Peak worker RSS | JSONL output bytes |
| --- | --- | --- | --- | --- |
| 1 | 4,295.804 ms | 3,397.305 ms | 156,036 KiB | 3,675,631 |
| 2 | 4,163.752 ms | 3,252.410 ms | 141,956 KiB | 3,675,638 |
| 3 | 4,247.537 ms | 3,330.915 ms | 145,188 KiB | 3,675,631 |

A Python harness sampled local read-only performance, sensor-source, and device
status HTTP endpoints approximately every half second (requests are sequential,
so request time extends the interval). It recorded only latency, frame age,
resource counters and thermal-zone-zero temperature. It used four seconds of
baseline and three seconds afterward. There were seven baseline samples,
twenty-three replay samples and four afterward; all requests succeeded.

| Measurement | Baseline | During replay | After |
| --- | --- | --- | --- |
| Minimum available memory | 1,358,520 KiB | 1,215,752 KiB | 1,328,848 KiB |
| Median aggregate CPU busy | 23.78% | 56.65% | 22.22% |
| Maximum aggregate CPU busy | 28.76% | 76.68% | 29.92% |
| Maximum zone-zero temperature | 33.503 °C | 37.356 °C | 30.934 °C |
| Maximum performance GET latency | 34.92 ms | 328.04 ms | 26.11 ms |
| Maximum sensor-source GET latency | 103.29 ms | 45.32 ms | 27.32 ms |
| Maximum device-status GET latency | 51.58 ms | 108.24 ms | 74.00 ms |
| Maximum reported live-frame age | 457 ms | 514 ms | 418 ms |

CPU busy is the change in `/proc/stat` non-idle counters across adjacent samples
in the same phase, aggregated across all four CPUs. It includes the running
services and measurement harness. The server's lifetime event-loop p95 remained
21.14 ms; that lifetime histogram cannot establish the replay interval's p95.
The sensor endpoint reports the newest frame of any sensor type, so this is not
proof of piezo-specific freshness. Temperature zones one through three were
unreadable; only zone zero was sampled. Status GET latency is not proof of
hardware-write or closed-loop control responsiveness.

The harness read the worker's complete output file and extracted operational
counters; it did not run the production Node result parser, artifact publisher
or database transactions. Thus parent-process event-loop cost, persistent
artifact I/O, SQLite contention, larger/reference-heavy fixtures, waveform replay
and sustained-load qualification remain outstanding before final admission limits
are selected. Node ran at nice 19 with a 128 MiB heap and a 45-second external
timeout. Both services remained active afterward. Temporary synthetic input,
worker, harness and output were removed from the pod; no live configuration,
observations or hardware settings were changed.

## Production runner and reference-heavy qualification

A follow-up on October 12 used the production `DatasetStore`, `BacktestJobStore`,
child driver, result publication, and integrity-checked result reader against a
new synthetic SQLite database on the pod's persistent storage. The application
service and its databases were left untouched. The reusable harness is
`scripts/benchmarks/biometrics-runner.ts`; bundle it with esbuild for Node, leaving
`better-sqlite3` external, and pass a **new** directory, copied migration
folder, packaged worker path, and `mixed` or `dense` fixture name. Directory
creation is exclusive so an existing database cannot be selected accidentally.

The tested worker SHA-256 was
`45547553cd456cba5051fe6e60e8562b5510ae32bbf8b92cfeb62c59cdeb59d1`.
The coordinator used Node's 384 MiB heap limit; its evaluator child retained
nice 19 and the 128 MiB heap limit. These are measurement settings, not yet an
approved deployment policy.

The mixed fixture retained 20 twelve-hour nights, 14,400 vital readings,
3,600 movement rows, and 1,600 heart-rate/stage reference records. It includes
periodic missing HR readings, motion, and varying HR/HRV/breathing. Chronological
splitting evaluated 12 tuning nights. The three configurations have distinct
deep-stage HR-ratio thresholds; assumed calibration quality is explicitly one.
This synthetic fixture measures execution and does not validate biometrics.

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Coordinator execution through publication | 12,007.73 ms | 11,543.85 ms | 11,673.61 ms |
| Evaluator runtime | 5,202.12 ms | 4,962.23 ms | 5,048.52 ms |
| Evaluator peak RSS | 168,392 KiB | 167,180 KiB | 174,336 KiB |
| Integrity-checked result read | 2,286.37 ms | 2,256.85 ms | 2,267.35 ms |
| Coordinator event-loop maximum | 2,386.56 ms | 2,300.58 ms | 2,365.59 ms |
| Coordinator event-loop p95 | 22.64 ms | 22.95 ms | 20.92 ms |
| Coordinator process peak RSS (cumulative) | 257,564 KiB | 261,296 KiB | 262,292 KiB |

All three attempts succeeded, produced 1,813,618-byte reports, and left the
synthetic canonical vitals unchanged. Dataset creation took 4,322.13 ms. These
reports remain below the 2 MiB inline threshold, so this workload does not
qualify the artifact path. Minimum available system memory during the replay
phase was 1,140,300 KiB and maximum zone-zero temperature was 39.457 °C.

**Admission is not qualified by these results.** The coordinator's multi-second
synchronous work would block the application if wired into its main event loop.
Dataset construction and result reads have the same issue. Move these operations
into a bounded coordinator worker before enabling production execution, then
repeat the benchmark. A favorable p95 conceals the long individual stalls.

The harness's own HTTP requests and piezo receipt callbacks run on that same
coordinator event loop. Their delays therefore cannot be attributed solely to
the application server or sensor ingestion. The separate standard-library probe
`scripts/benchmarks/biometrics-probe.py` measures loopback API latency from another
process. Neither probe retains API bodies or raw sensor samples. The Node
probe retains only sensor timing and resource measurements. This remains
synthetic, non-production-database testing: it does not establish live SQLite
contention, hardware-write responsiveness, waveform replay, or untrusted-code
isolation.

### Large artifacts and independent API probe

The dense fixture used the same worker with 19,000 synthetic vitals, no movement
rows, and 800 reference records across 20 nights. Twelve tuning nights produced
reports of 2,301,040, 2,301,041, and 2,301,034 bytes. All three stored result
descriptors were verified as `biometric-report-artifact-v1`, all result reads
passed integrity checks, and canonical synthetic vitals were unchanged.

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Coordinator execution through publication | 13,236.50 ms | 12,901.88 ms | 13,064.22 ms |
| Evaluator runtime | 5,501.95 ms | 5,455.62 ms | 5,499.04 ms |
| Integrity-checked artifact result read | 2,803.76 ms | 2,933.55 ms | 2,973.02 ms |
| Coordinator event-loop maximum | 2,961.18 ms | 2,780.82 ms | 2,885.68 ms |
| Evaluator peak RSS | 166,692 KiB | 161,240 KiB | 162,472 KiB |

Dataset creation took 4,477.81 ms. Coordinator peak RSS reached 262,456 KiB;
minimum available system memory during replay was 1,105,904 KiB; zone-zero
maximum temperature was 40.274 °C. Piezo source-timestamp age seen by the
coordinator peaked at 4,728 ms during replay versus 2,584 ms in its baseline.
Because this callback shares the blocked coordinator loop, that measurement
still combines actual frame age with callback delay.

The independent Python probe made 12 baseline samples, 251 samples spanning
fixture setup and all three attempts, and 9 afterward. Every GET returned 200.

| Maximum HTTP latency | Baseline | Entire benchmark | After |
| --- | --- | --- | --- |
| Performance | 36.88 ms | 57.52 ms | 22.48 ms |
| Sensor source | 93.53 ms | 72.37 ms | 22.72 ms |
| Device status | 66.74 ms | 80.61 ms | 52.32 ms |

The production service remained active after the benchmark. These observations
support keeping heavy coordination separate from the application event loop;
they do not approve running it on that loop. The harness's configuration labels
are synthetic comparison roles (thresholds 0.90, 0.92, 0.94), not a promotion
comparison against an asserted shipped-default profile. Repeat qualification
after coordinator isolation and again for the final deployed worker. The
measurements do not yet select universal admission thresholds or qualify live
SQLite contention and closed-loop control responsiveness.

## Isolated coordinator follow-up

The coordinator implementation at `0e5c87c0` was measured on the same pod on
October 12 using the dense fixture above. The optional final `COORDINATOR`
argument to `scripts/benchmarks/biometrics-runner.ts` routes dataset creation,
experiment creation, execution, and report reads through the shipped coordinator.
The caller uses the same 384 MiB heap cap as the preceding benchmark; each
coordinator has a 384 MiB cap and nice 19, and its evaluator retains 128 MiB/nice
19. Each operation gets a fresh process. The worker hash remains
`45547553cd456cba5051fe6e60e8562b5510ae32bbf8b92cfeb62c59cdeb59d1`.

An initial isolated run succeeded three times. The repeat below adds a timer
turn after report serialization, so its event-loop maximum includes final IPC
deserialization and JSON serialization as well as execution/publication. This
is a calling-process measurement, not the production application's event-loop
histogram. Both runs used exclusively created synthetic databases and retained
no personal recordings or API response bodies.

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Execution through publication | 14,955.19 ms | 15,390.62 ms | 15,141.36 ms |
| Integrity-checked full report read | 4,178.71 ms | 4,418.67 ms | 4,237.17 ms |
| Calling-process event-loop maximum | 144.83 ms | 187.83 ms | 174.59 ms |
| Calling-process event-loop p95 | 21.22 ms | 21.04 ms | 21.12 ms |
| Calling-process cumulative peak RSS | 153,428 KiB | 156,940 KiB | 156,940 KiB |
| Evaluator peak RSS | 164,460 KiB | 171,136 KiB | 162,032 KiB |

All three attempts succeeded; full reports remained approximately 2.30 MB and
canonical synthetic vitals were unchanged. Dataset construction took 5,693.98 ms
with a calling-process event-loop maximum of 56.30 ms. During replay, minimum
available system memory was 1,046,688 KiB, maximum zone-zero temperature was
41.909 °C, and maximum piezo source timestamp age was 2,756 ms. This does not
measure the coordinator's peak RSS; the memory values above must not be summed
as a complete process-tree maximum.

The independent probe recorded 12 baseline samples, 291 spanning the complete
benchmark, and nine afterward. Every request returned HTTP 200.

| Maximum HTTP latency | Baseline | Entire benchmark | After |
| --- | --- | --- | --- |
| Performance | 30.48 ms | 160.12 ms | 38.15 ms |
| Sensor source | 27.47 ms | 109.92 ms | 24.23 ms |
| Device status | 65.74 ms | 159.46 ms | 76.02 ms |

Isolation removed the multi-second calling-loop stalls observed previously,
but full-report IPC/serialization still transfers large trace arrays. In one
retained synthetic report, `nights` occupied about 2.21 MB; the first evaluated
window's `blocks` alone occupied 56,786 bytes. A bounded summary for interactive
review, with exact traces fetched through the existing paginated endpoint, is
an appropriate next optimization. Keep the complete immutable report and its
hash; a transport projection must not silently redefine the retained artifact.

These observations still do not qualify live-database write contention,
closed-loop hardware responsiveness, waveform processing, or arbitrary-code
isolation. No production resource policy or automatic background execution was
enabled by this benchmark. Temporary benchmark databases and binaries were
removed after measurements were copied locally; the production service was
left running without a deployment or restart.

## Retained waveform pipeline on the pod

The October 12 follow-up used the coordinator and Node evaluator built from
`fe25e71a`, plus the Python process-limit compatibility fix accompanying this
measurement. The pod's Python 3.10.4 installation omits the optional `resource`
extension. Workers now use `/usr/bin/prlimit` on Linux when that extension is
missing, failing startup if the utility fails. A separate child on the pod
confirmed CPU soft/hard limits of 120/121 seconds, core limits of zero, and
open-file limits of 64/64 in `/proc/self/limits`.

The new `scripts/benchmarks/biometrics-waveform-fixture.py` creates deterministic
500 Hz dual-channel sine-plus-noise CBOR archives in an exclusively created
directory. The runner `biometrics-waveform-runner.ts` creates a separate database,
retains those archives through the production publisher, enqueues three unique
configuration hashes, executes the leased waveform pipeline, and reads its
summary. The first five minutes are retained pre-roll. Configuration labels
are synthetic roles; this fixture does not measure biological accuracy.

The 30-minute fixture contained 5,976,451 compressed bytes. Dataset creation
took 1.309 seconds and retention took 15.809 seconds. Execution reached its
180-second coordinator limit before publishing a result. Canonical synthetic
observations were unchanged. **This workload is not qualified for automatic
execution.** Full-night execution needs a different scheduling/budget design;
simply enabling the existing host would not make these jobs complete.

The independent probe sampled the benchmark process and its descendants through
`/proc`, in addition to the existing loopback HTTP measurements. RSS is a sampled
sum, not an exact peak or unique physical-memory accounting. The failed
30-minute run produced 12 baseline, 448 benchmark, and nine post-run samples.
All sampled HTTP responses returned 200.

| Measurement | During the complete 30-minute-fixture benchmark |
| --- | --- |
| Maximum sampled process-tree RSS | 313,332 KiB |
| Minimum available system memory | 1,181,144 KiB |
| Maximum zone-zero temperature | 40.041 °C |
| Maximum performance GET latency | 49.01 ms |
| Maximum sensor-source GET latency | 79.46 ms |
| Maximum device-status GET latency | 115.39 ms |
| Maximum age of piezo WebSocket receipt | 1,446 ms |

The receipt age is measured at the benchmark client; it is not the age of the
original sensor timestamp. The calling process's largest sampled scheduling
delay was 179.88 ms, so favorable HTTP timings alone do not establish its event
loop budget. Measurements use synthetic databases and do not qualify live
SQLite write contention or hardware-command latency. No production admission
policy is selected by these results.

A 10-minute follow-up (five minutes pre-roll and five minutes scored) completed
the entire pipeline with the same three configurations. Its 1,992,541 compressed
bytes took 15.599 seconds to retain. Leased replay and publication took 83.402
seconds, and integrity-checked summary retrieval took 1.289 seconds. The summary
was 28,798 bytes; synthetic canonical observations again remained unchanged.
The replay caller's event-loop p95/max were 22.00/63.90 ms, including a timer
turn after the coordinator reply. This is a successful short fixture, not a
qualified whole-night workload.

The independent probe recorded 12 baseline, 247 benchmark, and nine post-run
samples, all with HTTP 200 responses. During the benchmark, process-tree RSS
reached 314,852 KiB, available memory stayed at or above 1,184,736 KiB, and
zone-zero temperature reached 39.924 °C. Maximum performance/sensor-source/device
GET times were 155.93/96.78/75.31 ms. Maximum piezo receipt age was 1,626 ms.

The successful run pinned compound build
`b91e8552bc6d973922bd38808d04490683e3e05d8c67c9af5ad37d40a64bfe45`
and Python build
`fad13cfff0b361fbec950e0b6ddd892fe3d97f42f3ef9c5031af2e700c579aca`.
Its complete report hash was
`8446b1a8fd4c0f1530c25ed186ac5231c8020c60e4dffc42b1ec248aa2b46291`.
Python used the pod's installed NumPy 2.2.6 and SciPy 1.15.3. The staged
benchmark used fixed production worker bundles, not the temporary diagnostic
coordinator used to investigate the missing Python extension.

After both runs, no benchmark descendants remained. Synthetic telemetry and
logs were copied locally, and the staging directory was removed. Both installed
services remained active on the original `homekit-0b53800` release. No deployment,
restart, live-database modification, or hardware command was part of this test.

### Where waveform execution time goes

A subsequent synthetic 30-minute profile on the same pod separated startup
from processing. The Yocto Python installation also lacks `_lsprof`, so the
diagnostic used `time.monotonic()` and `time.process_time()` around the shipped
functions. These timings include small wrapper overhead and are not a complete
function profiler. It retained the same noisy dual-channel fixture in a new
directory and discarded derived readings after counting them.

| Operation | Wall time | CPU time |
| --- | --- | --- |
| Import replay and numerical dependencies | 12.726 s | Not measured |
| Retain the synthetic archive | 0.369 s | Not measured |
| Complete one-configuration retained replay | 45.184 s | 44.751 s |
| Inner CBOR decoding (included above) | 0.596 s | 0.583 s |
| Per-side ingestion (included above) | 41.623 s | 41.238 s |
| Numerical estimates (included in ingestion) | 30.365 s | 30.082 s |

The run consumed 1,860 records including 1,800 piezo frames and produced 50
scored readings plus ten pre-roll readings. These overlapping timings must not
be summed. Both startup and numerical processing matter; archive decoding was
not the dominant cost. A full-night run still needs direct measurement rather
than extrapolating this short profile into a production runtime guarantee.

### Interrupted eight-hour qualification (2026-10-13 UTC)

The three-configuration, eight-hour synthetic run on `192.168.1.88:8822`
was cancelled during its third configuration after systemd explicitly stopped
`sleepypod` at 01:09:44 UTC. Core and piezo services restarted at 01:10:17 UTC;
`NRestarts=0` and the journal showed the stop request and SIGTERM. This task did
not issue that stop. The installed release remained `homekit-0b53800`.
The admission monitor withdrew permission when HTTP health disappeared. This
run is **not a completed qualification**, regardless of the operation timer's
`succeeded` field (which only records that the execution RPC returned).

Before cancellation, the benchmark recorded 293 concurrent descriptor reads,
zero read failures, read p95 1520 ms / maximum 2077 ms, 5962 HTTP probes with six
failures at shutdown, HTTP p95 42 ms / maximum 937 ms, at least 1,045,213,184 bytes
available memory, maximum temperature 44.594 C, maximum piezo receipt age 1768 ms,
and peak benchmark process-tree RSS 396,940 KiB. Canonical observations remained
unchanged. These observations support cancellation behavior but do not establish
a production resource policy or a successful full-night replay.

Synthetic measurements and probe metadata were copied locally for analysis.
After confirming all benchmark descendants had exited, its exact staging directory
was removed; both installed services were active. Repeat full qualification in an
uninterrupted window before enabling the production replay host.

Retained RAW cleanup runs through the coordinator's serialized work lane when
its host performs startup/periodic collection. It uses a fixed Python module,
server-derived database/storage paths, a two-minute deadline, bounded diagnostics,
and a count-only response. Admission is checked before execution and every five
seconds; host shutdown cancels the child. Released artifacts and unpublished
orphans retain their one-hour grace periods and cross-process publication locks.
An absent retained directory is a no-op. Enabling the production host still
requires deployment qualification; adding cleanup does not enable replay.

### Per-run process measurements

New retained waveform runs include `resources` with version
`waveform-process-resources-v1`. Monotonic wall time and process CPU time cover
input reading, build verification, replay, and the final build check through
result generation. They exclude interpreter startup before `run`, final result
serialization, and teardown. Peak RSS is the kernel process-lifetime high water
mark: Linux `/proc/self/status` `VmHWM` converted from KiB to bytes (including
Yocto without Python's `resource` extension), or Darwin `ru_maxrss` in bytes.
Unavailable telemetry is null; current RSS is never substituted for a peak.

Waveform reports summarize the sequential processes as total measured wall/CPU
time and the largest individual process memory peak. Shared configuration hashes
are executed once and are counted once. Missing legacy measurements make the
corresponding aggregate unavailable. Compact report projections retain these
measurements, and the review UI labels their units and scope. They exclude Node
coordination/scoring and do not measure live ingestion health, so they cannot
alone satisfy a whole-job operational promotion policy. Execution measurements
are part of the retained report hash; replay determinism is assessed on derived
readings rather than equality of timing counters between executions.

Successful jobs also retain `jobOperations` (`backtest-job-operations-v1`),
written by the coordinator after its final admission check rather than supplied
by the scoring child or experiment. Its monotonic duration runs from initial
admission through publication preparation. The supervisor sends ingestion age
from the same fresh health sample used to admit work over the internal process
channel. Only count, maximum observed age, largest monotonic observation gap,
and qualification identity are retained; raw sensor frames are not included.

`allChecksMeasured` means every admission check supplied evidence under one
qualification identity, with at least initial and final checks. It does not mean
continuous monitoring: the nominal check interval is five seconds, delays are
reported, and intervening health is unobserved. Boolean-only admission callbacks
used by older tools/tests remain supported but produce unavailable health
evidence. A failed or invalid health callback cannot fall back to a permissive
boolean callback. Admission withdrawal still interrupts work without publishing
a result. The waveform report UI shows these observations separately from Python
process costs. Whole-job memory evidence and designated promotion policy remain
separate requirements.

The supervisor now also samples summed RSS for the owned replay process group
at a nominal one-second interval, plus admission boundaries. Linux procfs scans
are bounded to 4,096 process IDs and 64 group members with at most 16 concurrent
reads. Only group IDs and RSS are read; arguments, environments and sensor data
are excluded. Missing procfs, unsupported platforms, malformed data, or exceeded
bounds yield unavailable samples. Exited processes may disappear during a scan.

The final admission receipt carries this accumulator into `jobOperations.memory`
(`process-group-rss-observations-v1`): attempts, valid sample count, largest
observed summed RSS and largest observation gap. The coordinator and its worker
children share the owned group; the main application process is outside it.
The sampler stops when the coordinator closes, with no detached polling loop.
This is not an exact kernel peak: short-lived processes or peaks between scans
may be missed, scans are not atomic, and shared pages may be counted more than
once. Reports retain these scope limitations rather than substituting this value
for the per-process lifetime high-water marks.

### Completed eight-hour synthetic qualification (2026-10-13 UTC)

The uninterrupted run on `192.168.1.88` completed all three distinct
configurations over the 28,800-second dual-channel 500 Hz synthetic fixture
(95,621,299 compressed bytes). Staged production code was `e1ab3942`, with the
completion-validating benchmark runner from `2ff9bf58`. Completion required a
successful job, retained waveform report, matching dataset/Python identities,
three unique expected configuration hashes, and positive scored outputs for each.
Canonical synthetic observations remained unchanged.

- Replay: 2,625,664 ms (43.8 minutes); retention: 22,064 ms; summary: 2,849 ms.
- 366 concurrent dataset reads, zero failures; p95 1,516 ms, maximum 1,867 ms.
- Internal probe: 7,456 API requests, zero failures; p95 41.5 ms, maximum 311 ms.
- External probe: 16,905 API requests, zero failures; p95 38.6 ms, maximum 1,429 ms.
- Peak observed benchmark process-tree RSS: 413,163,520 bytes (394 MiB).
- Minimum sampled available memory: 1,132,576,768 bytes; maximum temperature 43.777°C.
- Maximum sampled ingestion age: 1,250 ms. In 68 samples a newer frame arrived
  after the collector captured its start timestamp, producing a negative age;
  those are collection-timing artifacts, not measured negative latency.
- Replay parent event-loop p95 23.1 ms, maximum 96.7 ms.

Retained report hash:
`bc1ac53d9168a5f2e6fd521212c69f6ae53939911e7ba17e4f1ccb0fb8e7cdcc`.
Compound build:
`375b2ae0e0e81545b234f1ee3357a2b0cd4cde222cd413591c71c88766b75607`.
Python build:
`23670017f01a37b0281fdea016440261af6f9e6519bff5f294b9056d6f5caf29`.

Synthetic measurements, probe output, and compact summary were retained locally
under `/tmp/biometrics-waveform-qualification-results/fullnight-success/`.
The owned pod staging directory was removed only after successful termination
and a descendant-process check. Core (`sleepypod.service`) and piezo services
remained active and the health API returned 200 afterward. These results qualify
the stated staged build and fixture; later telemetry and objective changes need
additional target verification. Synthetic signal recovery does not establish
agreement with real reference exports or clinical accuracy.

A subsequent target smoke test exercised the new process-group sampler against
an isolated Node child holding a touched 32 MiB buffer. Four of four observations
were available; peak observed RSS was 83,582,976 bytes, maximum observation gap
999.8 ms. The child exited and the temporary sampler directory was removed;
both application and piezo services remained active. This verifies Linux
collection and cleanup, not a repeat full-night qualification of newer code.

### Frozen sampled operational objectives

Numeric objective policies may explicitly opt into
`operational.observations.version = sampled-process-group-v1`, with maximum
memory and ingestion observation gaps. Without that opt-in, sampled RSS cannot
satisfy the existing peak-memory field. After the final admission check, the
coordinator replaces the scorer's operational evidence with its own measured
job duration, group RSS, and ingestion observations. Missing/partial samples
remain unavailable; excessive observation gaps or a qualification identity
mismatch prevent improvement. Threshold values and sampling semantics remain
part of the frozen experiment protocol. This supplies operational evidence;
a designated qualified policy, sufficient independent reference support, and
subgroup checks are still required for validated promotion.

### Current-build 30-minute smoke (2026-10-13 UTC)

An isolated run of `4453c0a5` on the same aarch64 pod (Node 24.16.0, locked
Python 3.10.4 environment) completed three distinct configurations over an
1,800-second dual-channel 500 Hz synthetic fixture, 5,976,451 compressed bytes.
It used the current packaged coordinator/evaluator and common Python sources,
including numerical flock, shared application admission and process-group cleanup
confirmation. Production services continued running; this was not a deployment.

- Replay 202,760 ms; retention 16,172 ms; summary 1,542 ms.
- 27 concurrent dataset reads, zero failures; p95 1,860 ms.
- 638 internal API requests and 1,545 independent probe requests, zero failures;
  respective p95 latencies 65.7 ms and 41.6 ms.
- Peak sampled benchmark process-tree RSS 433,369,088 bytes (413 MiB).
- Minimum available memory 992,690,176 bytes; minimum free disk 3,450,945,536 bytes.
- Maximum temperature 46.696°C; maximum measured ingest age 992 ms. Nine negative
  ages reflect collector/frame timing, as in the earlier full-night run.
- Replay parent event-loop p95 28.0 ms, maximum 186.4 ms.

Completion verifies a retained report, exact dataset/Python/configuration identities,
and positive scored outputs for each configuration. Synthetic canonical rows
remained unchanged. After termination, no process referenced the owned staging
directory; it was removed. Core and piezo services remained active and the health
API returned 200. No production databases, bindings or service configuration changed.

The [compact measurement summary](performance/biometrics-replay-2026-10-13/smoke-4453c0a5.json)
records exact result/build hashes, explicit test budgets and SHA256 identities of
the inputs and telemetry. Full synthetic telemetry is retained locally at
`/tmp/biometrics-qualification-4453c0a5/`. These are sampled observations, not exact
kernel peaks or continuous guarantees. They verify this short replay workload;
full-night current-build, representative-reference and prospective shadow
qualification remain outstanding. The measured event-loop maximum also prevents
interpreting the admission samples as a guarantee that all delays stayed below
the benchmark's 100 ms admission threshold. No promotion registry or production
budget defaults were derived from this smoke alone.

### Synthetic shadow supervisor measurement harness

`scripts/benchmarks/biometrics-shadow-runner.ts` exercises the shipped Node
supervisor and kernel-limited Python shadow child with generated 500 Hz dual
channels. It retains bounded resource receipts, partial failure observations,
output identity, exact Python/runner identities and parent event-loop measurements.
It uses no live waveform subscription, database, credentials or hardware API.

Bundle with esbuild (`--bundle --platform=node --target=node22 --format=cjs`),
then run on the target Linux pod with arguments `OUTPUT_JSON PYTHON_PATH
MODULES_PATH [SECONDS]`. The default is 1,800 synthetic seconds, processed as
fast as the worker permits; accepted durations are 150–28,800 seconds. Use the
locked installed Python environment and the source modules matching the build.
Wrap it in `biometrics-probe.py` for independent live-service telemetry. Run only
after other replay/shadow measurements finish: the child uses their same kernel
execution lock. The harness's explicit ceilings are measurement stop conditions,
not installed qualification or recommended deployment limits.

This measures synthetic processing and supervision only. It does not establish
live capture/sink performance, representative artifact robustness, held-out
accuracy or permission to install a shadow qualification registry.

### Current worker eight-hour run (2026-10-13)

The current worker/coordinator bytes completed three configurations over 28,800
synthetic seconds at 500 Hz on the same four-core ARM64, 2 GiB pod. The staged
source was `db52f1da`; subsequent API/UI/prompt changes leave the measured worker
and coordinator hashes unchanged. Exact hashes and artifact identities are in
[the compact evidence](performance/biometrics-replay-2026-10-13/fullnight-db52f1da.json).

- Replay: 2,756.7 seconds (45.94 minutes); retention: 21.74 seconds; summary:
  2.99 seconds. All operations completed and fixture canonical rows were unchanged.
- 363 concurrent report reads: no failures, p95 1,943.7 ms, maximum 2,183.3 ms.
- 7,390 internal HTTP observations: no failures, p95 57.1 ms, maximum 300.8 ms.
  The independent probe recorded 17,568 observations, also without failures,
  p95 39.6 ms and maximum 500.1 ms.
- Peak sampled process-tree RSS: 443.1 MiB; minimum available memory: 902.6 MiB;
  minimum filesystem space: 3.02 GiB; maximum temperature: 49.965 °C.
- Aggregate CPU busy averaged 68.1%, peaking at 99.0% over a sampling interval.
  Maximum one-minute load per CPU was 1.0575. These include live services and
  the probe, not just the replay child.
- Maximum observed piezo arrival age: 1,560 ms. There were 71 negative age
  differences because the collector records its start before asynchronous reads
  and can observe a newer frame afterward; those are not negative ingest latency.
- Parent event-loop p95 during replay: 27.28 ms, maximum 154.01 ms. A 100 ms
  admission check is therefore not a continuous event-loop latency guarantee.

The original process handle exited successfully and no owned worker descendants
remained before the separate shadow measurement started. Core and piezo services
were active afterward. The read-only HTTP probes do not prove actuator-write
latency or clinical performance. Raw measurements remain under
`/tmp/biometrics-qualification-db52f1da/` on the measurement workstation; the
committed evidence records their SHA-256 hashes. No live database or profile was
changed by this benchmark.

### Shadow supervisor measurement (2026-10-13)

After the full-night replay released its worker slot, the staged shadow harness
processed 1,800 synthetic seconds at 500 Hz through the shipped Linux process
wrapper and Node supervisor. It completed in 61.34 seconds, producing 30 outputs
and reporting 29.17 seconds of numerical CPU time. The child process-group RSS
peaked at a sampled 113.15 MiB; the independent probe observed 256.5 MiB for the
whole benchmark tree. The completion receipt retains cold-start and insufficient
preroll limitations.

The probe recorded 456 read-only HTTP observations with no failures (p95 45.41 ms,
maximum 130.39 ms). Minimum available memory was 1,019.5 MiB and maximum temperature
47.513 °C. Parent event-loop p95 was 26.10 ms and maximum 68.62 ms. RSS observation
gaps reached 333.42 ms; this is sampled memory evidence, not an exact kernel peak.

[The compact receipt](performance/biometrics-replay-2026-10-13/shadow-4ee74c25.json)
retains build identities, completion/cleanup observations, limits and raw-artifact
hashes. The original SSH handle exited zero, no owned descendants remained, and
both live services were active before the owned staging directory was removed.
This run does not exercise the live source/database sink, establish held-out
accuracy or authorize a shadow qualification registry.

### Target-specific replay deployment policy

The measured pod uses the [recorded policy](performance/biometrics-replay-2026-10-13/deployment-policy.json).
Its admission floor is 768 MiB available memory and 2 GiB free disk; it refuses
load per CPU above 1.1, temperature above 55 °C, piezo age above five seconds,
stale health samples above two seconds, or a scheduling probe above 100 ms.
These are conservative operating cutoffs around the observed workload, not
universal hardware defaults or guarantees that every transient stays below them.
A temporary refusal is expected when current health exceeds a cutoff.

The whole-job deadline is two hours; each numerical waveform child has a
30-minute wall deadline and 1,200 CPU-second limit, matching the successful
full-night measurement. Larger jobs can still exceed these ceilings and fail
explicitly. Existing worker serialization, process limits, quotas and health
checks remain enforced. This policy authorizes bounded replay on this measured
pod only; it provides no accuracy designation or shadow qualification.

**Raised 2026-10-16.** Calibration datasets frozen from real Pod 5 nights include
sessions of 10–14 hours. Replay ran about 31× slower on the pod than on a laptop
(a 2-hour cohort took 124 CPU-seconds), so a 10.5-hour night needed roughly 2,100
CPU-seconds and was killed at the 1,200-second limit on every attempt. With the
owner's approval the budget on this pod is now the schema maximum: 3,600 CPU-seconds
and a one-hour wall deadline per waveform child, and a four-hour whole-job deadline
(`{"jobWallMs":14400000,"waveformWallMs":3600000,"waveformCpuSeconds":3600}`). The
admission cutoffs above are unchanged, so health refusals still pause or interrupt
replay; workers still run one at a time at nice 19. The previous file is kept as
`/etc/sleepypod/biometrics-replay.env.bak-20261016`.

Deployment stores the two environment values in
`/etc/sleepypod/biometrics-replay.env`, loaded by
`/etc/systemd/system/sleepypod.service.d/biometrics-replay.conf`. A service restart
is required after changing them. Remove that drop-in and restart to return to
unconfigured admission. No user profile or hardware temperature setting changes
when installing this policy.

### Live source and isolated sink measurement (2026-10-13)

The [live operational receipt](performance/biometrics-replay-2026-10-13/live-shadow-operational.json)
records a successful 180-second observation through the loopback sensor stream,
read-only active observations, shared numerical worker and fenced isolated sink.
It retained six comparison points (5,396 bytes), with zero canonical rows in the
isolated database. The worker used 4.95 CPU seconds, sampled peak group RSS of
108.61 MiB and a maximum RSS observation gap of 497.24 ms. The independent probe
made 1,587 read-only HTTP requests with no failures (p95 40.21 ms, maximum
123.67 ms); minimum available memory was 1,082.67 MiB and maximum temperature
44.828 °C. No raw frames or numerical readings were exported in this receipt.

Two earlier attempts failed: one refused health admission; another reported
unavailable RSS after its worker completed. The latter exposed a process-exit
race fixed in `4c3a6a6e`: disappearance after a validated terminal response now
requires bounded, successful pipe closure. Missing RSS during processing, bad
exit status and a worker that never exits still fail. Regression tests reproduce
all three outcomes. The successful repeat used the fixed supervisor without
relaxing resource limits. Its SSH process exited zero, owned processes were
absent, and all three owned staging directories were removed after saving
metadata receipts locally.

This trusted measurement harness uses read-only production handles and a fresh
isolated database. It does not install a qualification registry, alter profile
bindings or exercise production registry admission. Cold start, insufficient
preroll, missing occupancy context and missing pump context remain recorded;
this operational check cannot establish accuracy or authorize promotion.
