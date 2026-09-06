# ADR 0024: Validate cover-button signals before dispatching actions

**Status:** Proposed — left single-click mapping verified; holds and combinations under investigation.

**Date:** 2026-09-06

## Context

We want to assign logic to physical cover buttons, including combinations.
The observation target is `root@192.168.1.88:8822`, hostname `eight-pod`,
running Eight Layer 4.0.2 (kirkstone). At 08:40 UTC, both `frank` and
`sleepypod-cover-buttons` were active. RAW sensor files were advancing under
`/persistent/biometrics`. The `nats` systemd unit reported inactive; this
capture uses the existing RAW files and journal.

The current [cover-buttons module](../../modules/cover-buttons/main.py)
expects sparse records shaped like:

```json
{"type":"buttonEvent","ts":1777357840,"left":{"top":1,"bottom":1},"right":{"top":1}}
```

This example comes from source documentation, **not this capture**. The
module converts positive values into repeated per-button journal entries.
It does not preserve record grouping in those entries, expose release edges,
or dispatch actions. Its assumed count semantics need physical validation.

## Observations

The available cover-buttons journal contained no `press:` entries when
queried at approximately 08:41 UTC. A live RAW follower started at 08:41:18
UTC and replayed the latest file before following new records. Its initial
heartbeat counted piezo, capacitance, temperatures, health, and log records,
but no `buttonEvent`. This establishes a functioning observation path,
not evidence that physical buttons cannot emit events.

Firmware logs contain apparent presses without a labeled physical test:

```text
2026-09-06T08:31:43.036029+0000 DBG:41476619 Sensor.cpp:614 handleCommand|[sensor] -> FW: 41462726 [tca8418R] pressed col7 row6
2026-09-06T08:31:43.045890+0000 DBG:41476832 Sensor.cpp:614 handleCommand|[sensor] -> FW: 41462940 [tca8418R] event fifo cleared, returning to normal mode
2026-09-06T08:31:43.045890+0000 DBG:41476833 Sensor.cpp:614 handleCommand|[sensor] -> FW: 41462940 [tca8418R] init ok
2026-09-06T08:31:43.045890+0000 DBG:41476869 Sensor.cpp:614 handleCommand|[sensor] -> FW: 41462977 [tca8418R] gpi press 105
2026-09-06T08:31:43.045890+0000 DBG:41476870 Sensor.cpp:614 handleCommand|[sensor] -> FW: 41462977 [tca8418R] invalid gpi->row 105->255
```

These lines follow repeated `[i2c3]` timeouts, failed transfers, and DMA
restarts. Similar `gpi press 105` messages recur approximately every five
minutes in the preceding hour. `gpi press 127` also occurs. They may be
recovery artifacts; they are **not validated button identifiers**. No
physical top/middle/bottom mapping should be inferred from them.

Journal arrival time can also distort timing: the above firmware counters
advance by milliseconds while delivery pauses for seconds. Capture journal
time, embedded firmware counters, RAW `ts`, and local receipt time separately.
Do not treat receipt time as measured hold duration or chord timing.

A separate full CBOR-sequence decode of all three retained sensor RAW files
covered record timestamps 08:00:28–08:43:20 UTC. It found no `buttonEvent`
or gesture record types and no decode errors. The files contained 67, 74,
and 60 payloads with multiple CBOR items, respectively. The installed
`RawFileFollower` calls `cbor2.loads` once per payload, so its live output
can omit trailing items. The separate scan decoded every item; the full
journal capture is also retained. A production reader must decode the
entire payload sequence before claiming complete event coverage.

At 08:45:14 UTC, an additional read-only observer began decoding every
CBOR item and retaining the original payload bytes for non-sensor records.
Its replay recovered 812 log records with no decode errors by 08:45:24.
For example, in `04F66753.RAW`, byte offsets 3081779–3083450,
`gpi press 105` is item index 11 (zero-based), and `invalid gpi->row
105->255` is index 12. Both have RAW timestamp 1788684091 (08:41:31
UTC), whereas their journal delivery occurred at 08:42:24.269749 UTC.
This directly demonstrates both the first-item omission and delayed
journal delivery for candidate button signals. No physical mapping follows
from these recovery-associated events.

## Labeled single-click trial

The operator confirmed pressing top, middle, bottom on Jon's side, believed
left. Firmware independently identifies all three as `left`. The capture
contains exactly one structured record per click, corroborated by the
installed service's journal:

```json
{"type":"buttonEvent","ts":1788684909,"left":{"top":1}}
{"type":"buttonEvent","ts":1788684911,"left":{"middle":1}}
{"type":"buttonEvent","ts":1788684914,"left":{"bottom":1}}
```

These occurred at 08:55:09, 08:55:11, and 08:55:14 UTC, respectively.
The operator reported completion later; receipt of the chat message is not
the physical event time. The following mapping is observed on this cover:

| Physical button on tested side | Firmware side | Keypad GPI (press and release) | Encoded button id | Structured field |
|---|---|---|---|---|
| Top | left (`tca8418L`) | 97 | 0 | `left.top` |
| Middle | left (`tca8418L`) | 98 | 1 | `left.middle` |
| Bottom | left (`tca8418L`) | 99 | 2 | `left.bottom` |

Each chain includes `gpi press`, `gpi release`, `[buttons] enc
{id:N,clicks:1}`, `handleButtonEvent` with the named side/button, and
`appendButtonEvent`. The observed embedded cover-counter differences from
press to release are 352, 208, and 256 ticks. Release to encoded click is
501, 502, and 501 ticks. This is consistent with a roughly 500 ms click
aggregation window if these counters tick in milliseconds; it is an
inference from three single clicks, not a verified debounce specification.

The existing service logged all three presses once, so no service change
is needed to observe these single-click events. The structured records do
not contain raw press/release times. The lower-level log edges are available
for investigating holds and simultaneous presses, provided every CBOR item
is decoded and firmware counters are kept separate from arrival time.

The [retained evidence](../hardware/evidence/cover-buttons-20260906.ndjson)
contains selected decoded signal logs with file offsets and item indices,
and the exact base64 CBOR payload for each of the three button records.
No right-side trial or multi-click/hold/chord behavior is established by
this single-click trial.

## Proposed decision

Use a read-only capture of the full `frank` and cover-buttons journals plus
unflattened RAW button records to establish the signal contract. Require
labeled physical trials before implementing dispatch:

1. Top, middle, bottom independently on each side, with repetitions.
2. Hold and release each button; determine whether edges, repeats, or only
   aggregate counts are emitted.
3. Double presses and simultaneous two-button combinations, followed by
   three-button combinations if supported.
4. An idle baseline and comparison against keypad recovery events.

Prefer a validated structured `buttonEvent` source if it represents the
required gestures. Preserve the original record, side, button values, and
timestamps before deriving events. A shared timestamp or multiple keys in
one record does not by itself prove simultaneous presses. If the source
provides only aggregated counts, hold durations and chords remain unsupported
until a suitable lower-level signal is demonstrated.

## Consequences and remaining evidence

The tested left single-click mapping is established. No action bindings
have been implemented, and the observation service remains unchanged.
The next required evidence is labeled double-click, hold/release, and
simultaneous-button trials; the other side also remains untested.
Record actual payloads and negative results here, and distinguish tested
behavior from assumptions before accepting this decision.

Session capture files are currently local and temporary:
`/tmp/pod88-buttons-20260906/{journal.log,baseline-journal.log,raw.ndjson,raw.stderr,observe.py}`.
The RAW observer uses the installed `RawFileFollower`, replays each newly
opened file, and records its file path and end offset. Replayed observations
must not be counted as new presses. Preserve relevant evidence in the
repository before removing temporary captures; do not commit unrelated
biometric data. The journal excerpts above are retained directly in this ADR.

The additional observer and output are `observe-sequences.py`,
`raw-sequences.ndjson`, and `raw-sequences.stderr` in the same temporary
directory. It preserves file offsets, item indices, all decoded non-sensor
records, and base64 payloads. It follows rotation after draining the open
file, reports decoding failures explicitly, and emits ten-second heartbeats.
Use this output for signal analysis; the original follower capture remains
available for comparison. Neither observer changes the installed service.
