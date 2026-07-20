# NATS Frame Readers

**Status:** implemented — automated validation complete; field validation pending
**Source data:** 1-minute `raw.>` capture from a field Pod 5 on new firmware
(Discord user report, 2026-07-19), taken with `scripts/probe-nats-capture.py`.
236 messages across 8 subjects.

## Problem

New Pod 5 firmware (~April 2026+) stops writing CBOR `*.RAW` spool files and
instead publishes sensor frames to a local NATS server (JetStream-enabled,
`nats://localhost:4222`, no auth on loopback). Piezo-processor,
sleep-detector, environment-monitor, and cover-buttons ingest through
`common.raw_follower.RawFileFollower`; calibrator scans the same `*.RAW`
files in bounded historical batches. On NATS-only pods those paths run
cleanly and ingest nothing. Field signature: services active, journals clean,
calibrator errors `No capSense records available` /
`Insufficient temp data: 0 rows`. The Node live streamer is another RAW
consumer, feeding WebSocket clients, automation snapshots, and cap-frame
persistence.

Constraint (non-negotiable): the `.RAW` path must keep working unchanged on
old-shim and mid-era pods. The NATS reader is **added alongside**, selected at
runtime — never a replacement.

## Wire format (as captured)

Each subscribed sensor message (`raw.sens.>` / `raw.frz.>`) contains one
complete CBOR value whose decoded value is a record map. Definite and
indefinite maps both occur; consumers must not depend on a leading encoding
byte. NATS supplies the message boundary, so sensor readers need no outer
framing, magic-byte scan, or corruption recovery. `raw.log` is the exception:
the captured retained message is a CBOR sequence of 12 concatenated log maps.
It is deliberately excluded from live sensor subscriptions and queried only
as a JetStream diagnostic by `sp-status`.

| Subject | `type` | Rate | Size | Consumed by |
|---|---|---|---|---|
| `raw.sens.capsense` | `capSense` | 2 Hz | 101 B | sleep-detector, calibrator |
| `raw.sens.piezo` | `piezo-dual` | 1 msg/s | 4066 B | piezo-processor, calibrator |
| `raw.sens.bedtemp` | `bedTemp` | 0.1 Hz | 112 B | environment-monitor |
| `raw.frz.temp` | `frzTemp` | 0.1 Hz | 53 B | environment-monitor |
| `raw.frz.health` | `frzHealth` | 0.1 Hz | 213 B | flow-chart (via server) |
| `raw.frz.therm` | `frzTherm` | 0.1 Hz | 124 B | sleep-detector pump gate, Node stream |
| `raw.sens.blanket` | `blanketReadings` (new) | 0.5 Hz | 247 B | — (out of scope v1) |
| `raw.log` | `log` | sporadic | varies | `sp-status` only (not live-subscribed) |

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
  as-is. Per-side `status` also exists on legacy RAW records; the field-capture
  sample was `"good"`. This implementation records it without gating, leaving
  it available for a future quality rule.
- **`bedTemp`** — matches the v1 dialect in `common.dialect.normalize_bed_temp`
  exactly: `amb`/`mcu`/`hu` + per-side `{out, cen, in}`, all integer
  centidegrees. One new per-side key `side` — already ignored by the
  normalizer.
- **`frzTemp`** — `{left, right, amb, hs}` centidegrees; exact match for
  `environment-monitor.write_freezer_temp` including sentinel filtering.
- **`frzHealth`** — per side, nested `pump.{mode, rpm, water}`, `tec.current`,
  `temps.flowrate`, `fan.{top,bottom}.rpm`. Note: `temps` carries **only**
  `flowrate` (the #593 fallback for missing `frzHealth.temps` fields is
  load-bearing here). Existing pump guards accepted flat `pumpRpm` aliases;
  the NATS integration also reads nested `pump.rpm`. Captured `frzTherm`
  carries per-side `power`, which is likewise treated as pump activity.

The subscribed but unsupported `blanketReadings` type is passed to
`warn_unknown_type_once` semantics: logged once, not ingested, until a
consumer exists. It carries per-side temperature + xyz acceleration and
`is_connected`, and is the likely v2 candidate for cover pods. `frzTherm`
already feeds pump-state handling; `raw.log` never reaches these readers.

## How we detect NATS ("does NATS exist?")

Three layers, cheapest-first. Layers 1–2 already exist on this branch; layer 3
is what the follower itself uses.

**1. Script layer (shipped — `sp-status`, `biometrics-archiver-helpers`):**

```bash
systemctl is-active --quiet nats-server.service && [ -d /persistent/jetstream ]
```

This is the live diagnostic signal used by `sp-status`. The install/update
helper uses the more restart-tolerant persistent identity — the NATS unit is
installed and `/persistent/jetstream` exists — so a transiently restarting
server cannot accidentally install RAW tmpfs routing. When a pod transitions
from RAW firmware, the helper removes Sleepypod-owned tmpfs units and the
`frank.service` routing drop-in after archiving any remaining volatile RAW
frames; the cold archive is preserved. Neither script-layer check is
sufficient for runtime selection: identity does not prove the protocol is
reachable or frames are flowing.

**2. Protocol layer (cheap runtime reachability):** open a TCP connection to
`127.0.0.1:4222`; a real NATS server greets immediately with an `INFO {...}`
line before the client sends anything. This distinguishes NATS from a random
open port with no dependencies and ~zero cost:

```python
def nats_reachable(host="127.0.0.1", port=4222, timeout=2.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout) as s:
            s.settimeout(timeout)
            greeting = b""
            while b"\n" not in greeting and len(greeting) < 4096:
                chunk = s.recv(512)
                if not chunk:
                    return False
                greeting += chunk
            return greeting.startswith(b"INFO ")
    except OSError:
        return False
```

The implementation also bounds total greeting length/time and tests an INFO
line split across multiple TCP reads.

**3. Data layer (health signal, NOT a selection input):** once subscribed,
count messages on `raw.sens.>` and `raw.frz.>`. On live firmware capSense
ticks at 2 Hz, so a silent subscription is worth logging (once, at 60 s) —
but it does not change the source choice. See selection rationale below.

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
- **The 60 s grace window** covers the inverse race (consumer up before
  nats-server) on new-firmware pods. Cost on old pods: worst-case 60 s of
  retries before file tailing starts — acceptable per review. Belt-and-
  braces: the four Python module units and the Node `sleepypod.service` gain
  `After=nats-server.service` ordering (ignored by systemd on pods where that
  unit doesn't exist; there is intentionally no `Wants` or `Requires`).
- Probe once at startup; no mid-flight source switching. "NATS was up, then
  died" is handled by `Restart=always`: the process exits after
  `MAX_RECONNECT_FAILURES` and the whole selection re-runs on restart. This
  avoids leaving a healthy-looking process permanently stranded on a dead
  source.
- The two sources never run concurrently in one process (duplicate-row risk).

## `NatsFollower` design

New file: `modules/common/nats_follower.py`. Interface-compatible with
`RawFileFollower`: a blocking generator yielding decoded record dicts, so each
streaming module's dispatch loop remains unchanged behind the source selector.
Calibrator is the deliberate exception: it uses a bounded live NATS buffer in
place of its historical RAW scan and readiness-aware startup retries as data
accrues.

- **Client:** `nats-py` (asyncio). Runs in a daemon thread owning its event
  loop; messages are CBOR-decoded and pushed onto a bounded
  `queue.Queue(maxsize=256)`; the generator `get()`s from the queue. Queue
  full ⇒ drop-oldest + counter (matches tailer semantics: live data beats
  backlog; 256 is about one minute of the full captured sensor firehose).
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
errors that capSense2 signals via its `-1.0` sentinel values).

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
durable JetStream consumer could give every reader deterministic restart
backfill beyond the current RAW file. v1 uses core subscribe to keep the live
path small and avoid:
durable-consumer state management, ack policy, retention interplay with the
uploader, and replay-vs-live dedup in the DB writers. This is not perfectly
identical to Python's RAW restart behavior: `RawFileFollower` reads the newest
file from offset zero, whereas core NATS only sees messages published after
subscription. The bounded calibrator buffer therefore fills from live data
and retries when its minima are ready; other readers intentionally do not
backfill in v1. Revisit once the live path is stable in the field;
`INSERT OR IGNORE` on timestamped tables already makes modest replay safe.

## Testing

1. **Fixtures from the field capture:** commit one exemplar for each of the
   seven sensor subjects (`payload_b64` → raw CBOR bytes). `raw.log` is omitted:
   it is outside reader scope and contains a persistent hardware identifier.
   Unit tests decode the sensor fixtures through the actual NATS decode path
   and assert bed-temperature normalization, 500-sample piezo channels,
   capSense extraction/status recording, freezer shapes, and nested pump-state
   gating.
2. **Probe/selection tests:** fake whole and fragmented NATS INFO greetings,
   silent sockets, connection refusal, shutdown during the grace window,
   one-source-only selection, silence warning, bounded reconnect failure, and
   clean source shutdown. Frame traffic is never a selection input.
3. **Module/stream tests:** existing module tests pin unchanged RAW behavior;
   Node tests run captured NATS frames through the same broadcast, snapshot,
   listener, and `cap_sense_frames` persistence path and verify nullable/mixed
   per-side `statusCounts` windows.
4. **Live validation (pending):** the reporting user's pod (new-firmware Pod 5) +
   `eight-pod` (J55, shim variant) as the regression control. `sp-status`
   must show: NATS pipeline + rows accruing on the former; `.RAW` pipeline
   unchanged on the latter. Calibrator errors should clear once the live
   buffer reaches each sensor's sample minimum.

## Implementation and rollout

1. `NatsFollower` and the robust INFO probe live in `modules/common`; runtime
   selection is wired into piezo-processor, sleep-detector, and
   environment-monitor. Calibrator selects the same transport, starts a
   bounded live buffer on NATS, and retries pending startup profiles only when
   their data minima are ready. Cover-buttons remains deferred because its
   NATS event subject is unconfirmed and absent from the capture.
2. The Node streamer uses the official v3 `@nats-io/transport-node` client
   behind the same exclusive selector. Both sources feed one shared dispatch
   path, so WebSocket streaming, server listeners, the cap snapshot,
   automation, and cap-frame persistence behave consistently.
3. `sp-status` point-fetches the retained `raw.log` message with
   `nats stream get raw --last-for raw.log` and surfaces
   `SENSOR_SAMPLES_DROPPED` when present. The discovery probe preserves CBOR
   sequences rather than hiding trailing log maps and writes captures as
   private, exclusive files.
4. Field validation is the remaining rollout step. After it succeeds, this
   document can graduate to an ADR; cover events and durable backfill stay
   follow-up work.

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
4. **Fixtures:** the seven sensor payload exemplars are cleared for use. The
   retained `raw.log` sample is deliberately not committed because it contains
   a persistent hardware identifier and is not needed by either live reader.
