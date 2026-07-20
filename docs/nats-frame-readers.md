# NATS Frame Readers — Design Spec (draft for review)

**Status:** draft — review before implementation
**Branch:** `worktree-pod5-debug` (`feat/cap-frame-readers`)
**Source data:** 2-minute `raw.>` capture from a field Pod 5 on new firmware
(Discord user report, 2026-07-19), taken with `scripts/probe-nats-capture.py`.
236 messages across 8 subjects.

## Problem

New Pod 5 firmware (~April 2026+) stops writing CBOR `*.RAW` spool files and
instead publishes sensor frames to a local NATS server (JetStream-enabled,
`nats://localhost:4222`, no auth on loopback). Every biometrics module
(piezo-processor, sleep-detector, environment-monitor, calibrator,
cover-buttons) ingests via `common.raw_follower.RawFileFollower`, which tails
`*.RAW` files — so on these pods every module runs cleanly and ingests
nothing. Field signature: services active, journals clean, calibrator errors
`No capSense records available` / `Insufficient temp data: 0 rows`.

Constraint (non-negotiable): the `.RAW` path must keep working unchanged on
old-shim and mid-era pods. The NATS reader is **added alongside**, selected at
runtime — never a replacement.

## Wire format (as captured)

All payloads are single, complete CBOR maps (indefinite-length, `0xbf`
leading byte). One message = one record. No framing, no magic-byte scanning,
no corruption recovery needed — the transport guarantees message boundaries.

| Subject | `type` | Rate | Size | Consumed by |
|---|---|---|---|---|
| `raw.sens.capsense` | `capSense` | 2 Hz | 101 B | sleep-detector, calibrator |
| `raw.sens.piezo` | `piezo-dual` | 1 msg/s | 4066 B | piezo-processor, calibrator |
| `raw.sens.bedtemp` | `bedTemp` | 0.1 Hz | 112 B | environment-monitor |
| `raw.frz.temp` | `frzTemp` | 0.1 Hz | 53 B | environment-monitor |
| `raw.frz.health` | `frzHealth` | 0.1 Hz | 213 B | flow-chart (via server) |
| `raw.frz.therm` | `frzTherm` (new) | 0.1 Hz | 124 B | — (out of scope v1) |
| `raw.sens.blanket` | `blanketReadings` (new) | 0.5 Hz | 247 B | — (out of scope v1) |
| `raw.log` | `log` (new) | sporadic | varies | — (out of scope v1) |

### Records match the existing `.RAW` dialects

The records are the **same CBOR types the module parsers already handle**.
Verified field-for-field against the parsers:

- **`piezo-dual`** — `{type, ts, freq: 500, adc: 65, gain: 400, left1, right1}`.
  `left1`/`right1` are 2000-byte strings = 500 little-endian int32 samples =
  exactly 1 s of audio at `freq` Hz. Identical to what
  `piezo-processor/main.py` dispatches on (`rtype == "piezo-dual"`,
  `_int32_samples(record["left1"])`).
- **`capSense`** — `{type, ts, left: {out, cen, in, status}, right: {...}}`,
  integer channels. This is the **Pod 3 dialect**, not the Pod 4/5
  `capSense2 {values: [], status}` wrapper. The sleep-detector's existing
  `capSense` path and `CapCalibrator.CHANNELS = ("out", "cen", "in")` work
  as-is. `status` ("good" observed) is new; ignored in v1, available as a
  future quality gate.
- **`bedTemp`** — matches the v1 dialect in `common.dialect.normalize_bed_temp`
  exactly: `amb`/`mcu`/`hu` + per-side `{out, cen, in}`, all integer
  centidegrees. One new per-side key `side` — already ignored by the
  normalizer.
- **`frzTemp`** — `{left, right, amb, hs}` centidegrees; exact match for
  `environment-monitor.write_freezer_temp` including sentinel filtering.
- **`frzHealth`** — `pump.{mode, rpm, water}`, `tec.current`,
  `temps.flowrate`, `fan.{top,bottom}.rpm`. Note: `temps` carries **only**
  `flowrate` (the #593 fallback for missing `frzHealth.temps` fields is
  load-bearing here; `pump.rpm` is present directly).

New types (`blanketReadings`, `frzTherm`, `log`) are passed to
`warn_unknown_type_once` semantics: logged once, not ingested, until a
consumer exists. `blanketReadings` (per-side temp + xyz accel,
`is_connected`) is the likely v2 candidate for cover pods.

## How we detect NATS ("does NATS exist?")

Three layers, cheapest-first. Layers 1–2 already exist on this branch; layer 3
is what the follower itself uses.

**1. Script layer (shipped — `sp-status`, `biometrics-archiver-helpers`):**

```bash
systemctl is-active --quiet nats-server.service && [ -d /persistent/jetstream ]
```

Coarse install-time/diagnostic signal. Used to pick the `sp-status` pipeline
label and to skip tmpfs `.RAW` scaffolding in the archiver helpers. Not
sufficient for runtime: says a server exists, not that frames flow.

**2. Protocol layer (cheap runtime reachability):** open a TCP connection to
`127.0.0.1:4222`; a real NATS server greets immediately with an `INFO {...}`
line before the client sends anything. This distinguishes NATS from a random
open port with no dependencies and ~zero cost:

```python
def nats_reachable(host="127.0.0.1", port=4222, timeout=2.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout) as s:
            s.settimeout(timeout)
            return s.recv(512).startswith(b"INFO ")
    except OSError:
        return False
```

**3. Data layer (health signal, NOT a selection input):** once subscribed,
count messages on `raw.>`. On live firmware capSense ticks at 2 Hz, so a
silent subscription is worth logging (once, at 60 s) — but it does not
change the source choice. See selection rationale below.

## Source selection

Reachability decides; traffic does not. Robustness beats latency here
(reviewed 2026-07-19: "we don't need data immediately").

```
deadline = now + 60s                          # boot-ordering grace window
while now < deadline:
    if nats_reachable():                      # layer 2, retried every 5 s
        source = NatsFollower(...)            # patient: waits for frames
        break
else:
    source = RawFileFollower(RAW_DATA_DIR, ...)  # existing path, untouched
```

- **Why reachability alone, not a traffic window:** the two candidate rules
  fail differently. A traffic-window rule ("NATS must show a message within
  15 s") loses a real race on every new-firmware boot — if the firmware
  publisher starts later than our probe, we'd lock onto the file tailer and
  ingest nothing until the next restart. Reachability-alone only misfires on
  a hypothetical variant that runs a NATS server while still writing `.RAW`
  spools — no such variant is known, and the shipped script-layer gate
  (archiver-helpers) already treats server-presence as "new firmware". We
  keep the safe failure mode: a NATS server's presence selects NATS, and the
  follower simply waits for frames (logging once if silent past 60 s).
- **The 60 s grace window** covers the inverse race (module up before
  nats-server) on new-firmware pods. Cost on old pods: worst-case 60 s of
  retries before file tailing starts — acceptable per review. Belt-and-
  braces: the module units gain an `After=nats-server.service` ordering
  drop-in (ignored by systemd on pods where that unit doesn't exist).
- Probe once at startup; no mid-flight source switching. "NATS was up, then
  died" is handled by `Restart=always`: the process exits after
  `MAX_RECONNECT_FAILURES` and the whole selection re-runs on restart. This
  mirrors how `RawFileFollower` already handles unrecoverable file states.
- The two sources never run concurrently in one process (duplicate-row risk).

## `NatsFollower` design

New file: `modules/common/nats_follower.py`. Interface-compatible with
`RawFileFollower`: a blocking generator yielding decoded record dicts, so each
module's dispatch loop is unchanged — the only edit per module is the source
selection above.

- **Client:** `nats-py` (asyncio). Runs in a daemon thread owning its event
  loop; messages are CBOR-decoded and pushed onto a bounded
  `queue.Queue(maxsize=256)`; the generator `get()`s from the queue. Queue
  full ⇒ drop-oldest + counter (matches tailer semantics: live data beats
  backlog; 256 ≈ 2 min of capsense).
- **Subscription:** core NATS subscribe on `raw.sens.>` and `raw.frz.>`
  (plain subscribe, not JetStream pull — see Backfill below). Per-module
  subject narrowing is a premature optimization at these rates
  (~4.6 KB/s total); every consumer gets the same firehose and filters by
  `type`, exactly like the file tailer.
- **Decode:** `cbor2.loads` per message. Malformed payload ⇒ log + drop +
  failure counter (no magic-scan recovery needed). Records pass through the
  existing per-module `type` dispatch and `common.dialect` normalizers
  untouched.
- **Reconnect:** nats-py auto-reconnect with capped backoff;
  `MAX_RECONNECT_FAILURES` consecutive failures ⇒ raise out of the generator
  ⇒ process exit ⇒ systemd restart ⇒ full re-probe.
- **Dependencies:** add `nats-py` to each consuming module's `pyproject.toml`
  (`cbor2` is already present). **Python 3.9 constraint applies** — Pod 5
  ships 3.9.9; no PEP 604 (`int | None`) annotations (the #616 crash-loop
  lesson), `Optional[...]` only.

### `capSense.status` handling

Each side of a `capSense` record carries `status` (only `"good"` observed in
the capture; the failure vocabulary is unknown — plausibly mirrors the read
errors that capSense2 signals via its 65535 sentinel values).

*How gating would work:* the mechanism is per-side sample suppression at the
extraction layer, identical in spirit to the existing capSense2 sentinel
filtering — when `side.status != "good"`, that side's `{out, cen, in}` values
are excluded from that sample: not fed to the sleep-detector's presence/
movement scoring, not eligible for `CapCalibrator` quiet-window selection,
and not written as channel values. The other side and other record types are
unaffected. This prevents error-state garbage (rail values, zeros) from
polluting calibration baselines and inflating movement scores — the same
class of bug the capSense2 sentinel filter and pump-artifact gate exist for.

*Decision (review 2026-07-19):* **v1 records but does not gate.** Because the
non-good vocabulary and its actual channel behavior are unobserved, gating
now risks silently discarding usable data on states we haven't seen (e.g. a
transient warm-up status at boot). Once field data shows what non-good looks
like, the suppression above lands as a follow-up with a pinning test per
observed status. v1 records status two ways:

- **Log:** first occurrence of each distinct non-good value, with the channel
  values alongside (journald → `sp-bundle-logs`, so field reports carry the
  evidence).
- **Persist (review 2026-07-19): one column on the existing window row.**
  `cap_sense_frames` already aggregates ~2 Hz frames into 5 s windows with a
  `frameCount` (`src/streaming/capFramePersistence.ts`); add a `statusCounts`
  JSON column — a per-window `{status: sampleCount}` map, `null` when every
  sample in the window was `"good"` (the overwhelmingly common case, so
  storage cost ≈ nil). Follows the existing `zones` JSON-column pattern,
  rides the existing 48h retention, and gives the historical correlation
  ("were the garbage-looking windows also the non-good ones?") needed to
  validate the future gate against real data. Schema change via
  `src/db/biometrics-schema.ts` + `pnpm db:biometrics:generate` (journals are
  never hand-edited).

## Backfill (explicitly out of scope for v1)

The `raw` JetStream stream exists and retains messages
(`/persistent/jetstream`, consumed by firmware's `jetstream-uploader`). A
durable JetStream consumer could give the modules restart backfill — something
the file tailer never had (it jumps to EOF; see the piezoStream backfill
gap). v1 uses core subscribe to keep semantics identical to today and avoid:
durable-consumer state management, ack policy, retention interplay with the
uploader, and replay-vs-live dedup in the DB writers. Revisit once v1 is
stable in the field; `INSERT OR IGNORE` on timestamped tables already makes
modest replay safe.

## Testing

1. **Fixtures from the field capture:** commit per-subject exemplar payloads
   from the capture (`payload_b64` → raw CBOR bytes) as test fixtures, real
   sample data included — the capture is anonymized and cleared for use
   (review 2026-07-19). Unit tests decode fixtures through `NatsFollower`'s
   decode path and assert the yielded dicts satisfy the existing parsers
   (`normalize_bed_temp`, `_int32_samples` length/dtype, capSense channel
   extraction).
2. **Probe tests:** fake NATS greeting (`INFO {...}`) vs silent socket vs
   connection refused; traffic-window timeout.
3. **Module tests:** existing `test_main.py` pattern — `nats` stubbed via
   `sys.modules`, follower fed from fixture queue; assert rows land in
   biometrics.db tables.
4. **Live validation:** the reporting user's pod (new-firmware Pod 5) +
   `eight-pod` (J55, shim variant) as the regression control. `sp-status`
   must show: NATS pipeline + rows accruing on the former; `.RAW` pipeline
   unchanged on the latter. Calibrator errors clear within one
   `LOOKBACK_HOURS` window.

## Rollout

1. `NatsFollower` + probe in `modules/common`, selection wired into
   piezo-processor, sleep-detector, environment-monitor, calibrator
   (cover-buttons deferred — button events' NATS subject is unconfirmed; not
   in this capture).
1a. **Node streaming side is a second `.RAW` consumer** (found during status-
   column review): the live broadcast loop in `src/streaming` tails RAW files
   to feed the WS stream, the in-memory `signals.biometrics` snapshot, and
   `capFramePersistence` — so on NATS-only pods the web UI live stream,
   `cap_sense_frames` (including the new `statusCounts` column), and `cap.*`
   automation signals stay empty even with all Python modules fixed. Needs a
   TypeScript NATS source (`nats` npm client) behind the same
   reachability-probe selection. Same scope decision as the Python side:
   part of this branch, since shipping one without the other leaves
   new-firmware pods half-working in a way that's confusing to diagnose.
2. Ship on `worktree-pod5-debug`; field-test via `sudo sp-update
   worktree-pod5-debug` on the reporter's pod.
3. `sp-status` gains a firmware-log line (decided in review): fetch the most
   recent `raw.log` message from the JetStream `raw` stream —
   `nats stream get raw --last-for raw.log` (already guarded on nats CLI
   presence, same as the existing stream probe) — and surface
   `SENSOR_SAMPLES_DROPPED` when present. JetStream retention makes this a
   point read; no subscribe-and-wait needed for a sporadic subject.
4. ADR after review: this doc graduates to `docs/adr/0024-nats-frame-readers.md`
   once accepted.

## Review resolutions (2026-07-19)

1. **Source selection: robustness over startup latency.** Reachability
   (retried over a 60 s grace window) selects NATS; the traffic window was
   dropped as a selection input because its boot-race failure mode starves
   ingestion until the next restart, which is worse than the hypothetical it
   guarded against. Data-layer silence is a logged health signal only.
2. **`capSense.status`: record, don't gate, in v1.** Gating mechanism
   (per-side sample suppression, mirroring capSense2 sentinel filtering) is
   specified above and lands as a follow-up once non-good statuses are
   observed in the field. Recorded two ways: first-occurrence logging, plus a
   `statusCounts` JSON column on the existing `cap_sense_frames` 5 s window
   row (null = all good) — since the window already counts samples, carrying
   their statuses is one column, not a new archive.
3. **`SENSOR_SAMPLES_DROPPED` in `sp-status`: yes** — via JetStream
   last-message fetch (rollout item 3).
4. **Fixtures: real captured payloads are cleared for use** (data is
   anonymized); no scrubbing/zeroing required.
