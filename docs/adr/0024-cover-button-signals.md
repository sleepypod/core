# ADR 0024: Preserve firmware click counts and use raw edges for cover gestures

**Status:** Accepted — signal-source decision. Click counts are usable; hold/chord edges require loss-aware handling. This is not approval of a production gesture dispatcher.

**Date:** 2026-09-06

**Updated:** 2026-09-07 — triple through quintuple clicks, complete two-button
release sequence, and three-button onset captured.

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
or dispatch actions. The trials below validate click counts from one through five on left top
and demonstrate why the original counts must be preserved for bindings.

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
and exact base64 CBOR payloads for the single-click and follow-up trial
button records. It also retains the relevant native haptic log lines.
No right-side trial or multi-click/hold/chord behavior is established by
this single-click trial.

## Double-click, hold, and attempted combination trial

The operator reported completing the requested double-top, hold-middle,
and top+bottom sequence. The corresponding captured sequence is at
09:18:07–09:18:35 UTC; completion was reported much later. Results:

| Requested input | Observed structured event | Low-level evidence | Interpretation |
|---|---|---|---|
| Double-click left top | `{"type":"buttonEvent","ts":1788686287,"left":{"top":2}}` | Two GPI 97 press/release pairs; `enc {id:0,clicks:2}` | One event carrying a double-click count, not two independent single-click events |
| Hold left middle, then release | `{"type":"buttonEvent","ts":1788686303,"left":{"middle":1}}` | GPI 98 press at cover counter 44271316, release at 44275572 | Hold lasts 4256 ticks (approximately 4.26 s); structured event is indistinguishable from a short single click |
| Attempt top+bottom together | `{"type":"buttonEvent","ts":1788686315,"left":{"top":1}}` | GPI 97 press at 44286468, release at 44287300; no GPI 99 edge in the trial window | Only top registered in the capture; no validated chord |

For the double-click, the gap from first release to second press is 80
cover-counter ticks. The encoded click count arrives 501 ticks after the
second release. The hold is also encoded 501 ticks after release. These
observations support a release-based click aggregation window around 500
ms; they do not establish the exact cutoff or all supported click counts.
The structured hold event arrived locally at 09:18:23.648763 UTC. Both
of its raw press/release log entries arrived together at 09:18:23.802677,
so arrival-time subtraction would falsely measure a zero-length hold.

All non-sensor records in the 09:18:00–09:18:45 trial window were inspected.
No bottom edge, bottom click, or combined button payload appeared. A repeat
trial that holds top while adding bottom is required to distinguish a
missed physical actuation from firmware limitations. Do not implement a
chord by guessing from this top-only event.

The firmware also logged native behavior during this trial: top double-click
entered `handleGesture`, then `alarm[left] haptic mode--dur 2->1000` and
`start: power 25, pattern 7, dur 1000 ms`; the middle click logged
`alarm[left] off`; the final top click logged 500 ms haptic mode. Future
bindings must account for this existing firmware behavior and avoid adding
unintended duplicate haptics. No firmware behavior was changed in this session.

Additional unlabeled events occurred later (right middle single, left bottom
singles, right top double, and left top single). They show the capture
continued, but are not substitutes for labeled right-side or chord trials.

## Repeated top + bottom trial

The operator completed the requested repeat: hold top, add bottom while top
is still held, then release both. At 17:02:59–17:03:05 UTC the capture
contains both valid press edges:

| Signal | Embedded cover counter | RAW timestamp | Source in `04F8076B.RAW` |
|---|---:|---:|---|
| Left top down (`gpi press 97`) | 72152168 | 1788714179 | offset 712072, item 10 |
| Left bottom down (`gpi press 99`) | 72152296 | 1788714179 | offset 712072, item 11 |
| Left top up (`gpi release 97`) | 72158136 | 1788714185 | offset 741278, item 4 |
| Left top click (`enc {id:0,clicks:1}`) | 72158637 | 1788714185 | offset 741278, item 5 |

The second press follows the first by 128 counter ticks (approximately
128 ms) and precedes the top release by 5840 ticks. Combined with the
operator's labeled actuation, this establishes a top+bottom overlap at the
second press. Top's press-to-release duration is 5968 ticks. These values
are measured counter differences, not configured gesture thresholds.

The only structured result is:

```json
{"type":"buttonEvent","ts":1788714185,"left":{"top":1}}
```

There is **no captured bottom release or bottom click** between the bottom
press and the next left-keypad FIFO clear/init at 17:07:16 UTC
(`ts=1788714436`, cover counter 72409180). The full CBOR-sequence observer
reported no decoding errors. The independently captured frank journal
corroborates both presses and the top release, also without a bottom
release in that interval. This localizes the omission upstream of the
single-item RAW reader, but does not identify whether the keypad, cover
firmware, or upstream logging dropped the release. Do not infer that the
physical bottom button stayed held until keypad initialization.

All three edge messages share journal arrival time
17:03:05.790644 UTC, while their embedded counters span nearly six seconds.
This is another direct reason to use cover counters instead of log arrival
time. Selected trial records and the subsequent left-keypad reset are
retained in the linked evidence file.

## September 7: triple, hold, and additional combinations

After the previous SSH observer terminated with a remote connection close,
a new full-sequence observer and journal capture were started at approximately
07:22:56 UTC. The live stream was verified before the operator began. This
is a separate capture epoch; firmware counters must not be subtracted across
the two sessions. The operator reported completing the planned triple-top,
held-middle, and hold-top/add-bottom/release-bottom/release-top test, plus
additional combinations. The following describes **observed** extra sequences;
it does not assume which gesture the operator intended each one to mean.
All events in this trial use firmware `left`.

| UTC on September 7 | Decoded input | Structured `left` payload | What this proves |
|---|---|---|---|
| 08:11:55–56 | Middle + top briefly overlap; then top is pressed again | `{"middle":1,"top":2}` | Multiple button counts can share a record even when one also has a later, separate click |
| 08:12:02–03 | Three top press/release pairs | `{"top":3}` | Triple click is directly recognized |
| 08:12:11–14 | Middle held for 3136 cover ticks (~3.136 s) | `{"middle":1}` | Hold duration still exists only in edges |
| 08:12:21–26 | Top down, bottom down, bottom up, top up | `{"bottom":1}` | Complete held-top + bottom sequence is available in raw edges; structured output omits top for this gesture |
| 08:12:32–33 | Four top press/release pairs | `{"top":4}` | Quadruple click is directly recognized |
| 08:12:43–45 | Five top press/release pairs | `{"top":5}` | Quintuple click is directly recognized; this does not establish the maximum |
| 08:12:55–58 | Top, bottom, middle go down within 48 ticks; middle and top come up | `{"middle":1,"top":1}` | All-three onset is visible; bottom release and count are absent |

The [September 7 evidence](../hardware/evidence/cover-buttons-20260907.ndjson)
retains each structured payload as original base64 CBOR alongside selected
signal logs, offsets, and item indices. The frank journal independently
corroborates the click encodings and the complete two-button edge sequence.
The observer reported no decode errors through review at approximately
09:34 UTC. Additional isolated left-top single clicks at 07:59:13 and
08:15:57 UTC are outside the concentrated test above.

### Complete held-top + bottom sequence

All four edges are in `04FADE2B.RAW`:

| Edge | Cover counter | Offset / item index |
|---|---:|---|
| Top down, GPI 97 | 40314898 | 3332656 / 8 |
| Bottom down, GPI 99 | 40316098 | 3352184 / 0 |
| Bottom up, GPI 99 | 40318338 | 3352184 / 1 |
| Top up, GPI 97 | 40319234 | 3380651 / 1 |

Bottom is added 1200 ticks after top, held for 2240 ticks, and released
896 ticks before top. Top is held for 4336 ticks. The complete observed
overlap is 2240 ticks (~2.240 s). Only a bottom click record is emitted at
`ts=1788768745`; no separate top click or top encoding appears before the
next top burst starts at 08:12:32. This rules out reconstructing the physical
sequence solely from structured click counts. It does not establish why
firmware omits the top click.

### Extra overlap and all-three input

In the initial mixed event, middle goes down at 40288402, top at 40288450,
middle up at 40288546, and top up at 40288578. Their observed overlap is
96 ticks. Top then has another down/up pair at 40289010/40289154. The
firmware emits both button counts together at 40289655, 501 ticks after the
last top release. Thus `middle:1,top:2` represents both overlap and a later
click, not a single timeless chord. Preserve per-edge order when interpreting
it; a multi-key record alone is not an unambiguous combo identifier.

For all three, top goes down at 40348450, bottom at 40348482, and middle
at 40348498. Middle releases at 40351442 and top at 40351474. No bottom
release is captured before the next left-keypad FIFO clear/init at
08:16:28 (`ts=1788768988`, cover counter 40561270). All-three onset is
detectable, but its full release sequence and total overlap duration cannot
be verified. The complete two-button trial does **not** remove the missing
release limitation seen in this and earlier trials.

### Current bindable signal catalog

- Structured counts: left top single, double, triple, quadruple, and quintuple;
  left middle/bottom single. Do not claim the same count range for every
  other button/side without testing it.
- Edge-derived gestures: middle hold, top+middle overlap, complete held-top
  plus bottom, and all-three onset. These require our own recognizer;
  firmware does not emit a dedicated hold/chord type in these captures.
- Reliable universal release delivery, all release orders, top+middle+bottom
  permutations, and the entire right-side catalog remain unverified.

## Decision

Use the structured RAW `buttonEvent` as the input for verified click-count
bindings, preserving side, button, **original click count**, timestamp, and
record identity. A future dispatcher should match `(side, button, clicks)`;
`left.top:2` should select a double-click binding once. Do not dispatch two
single-click actions by reusing the observability service's count-expansion
loop. Do not add a second double-click timer after firmware has already
aggregated the clicks. Left top counts 1–5 are observed; the upper limit
and equivalent counts on other buttons remain untested.

For duration-sensitive bindings, the structured event is insufficient.
Investigate a separate edge source from `tca8418L/R` GPI press/release logs,
restricted to validated button codes, using the embedded cover counter for
duration. Preserve every CBOR item and deduplicate by source file/offset/item
(or an equivalent stable source identity), because file replay must not
retrigger actions. Treat keypad initialization, FIFO clearing, stream gaps,
and counter resets as discontinuities: discard pending edge state instead
of manufacturing releases or holds. Reset artifacts such as GPI 105/127
must not become button actions.

For top+bottom combo onset, the demonstrated signal is a second valid
press while the first button remains down in the same cover-counter epoch.
The repeat trial establishes that this information exists in the raw logs;
`buttonEvent` alone demonstrably loses it. A future recognizer can latch a
combo once on that transition, but cannot assume it will receive both
releases. Keep this path experimental until missing-edge behavior is
handled and tested: expire/cancel ambiguous state without generating a
release action, clear it on reset/gaps, and require fresh input before
rearming. Choose timeout and overlap policies explicitly in the dispatcher;
this capture does not validate numerical thresholds.

Do not infer complete chord duration or a both-buttons-released event from
this capture. Multiple structured keys or matching second-resolution
timestamps alone would not prove overlap. Any eventual edge-based
hold/chord recognizer must also suppress the corresponding firmware click
binding for the same physical gesture to avoid duplicate actions.

Before enabling bindings beyond the observed inputs, repeat physical trials
on the other side and validate hold behavior for each relevant button,
click-count boundaries, overlapping presses, release order, and reconnect
recovery. This ADR selects the supported click source and identifies the
additional signal required for holds/chords; it does not claim untested
combinations work.

## Consequences and implementation follow-up

The tested left single-click mapping is established. At the time of the
observation no action bindings had been implemented, and the observation
service remained unchanged. The subsequent
[Remote implementation](../design/remote-remapping.md) documents the
application's gesture policies and deliberately unverified native behavior.
Double-click counts and a held-middle release have now been captured.
The September 7 trial additionally captured a complete held-top/add-bottom
sequence and all-three onset. Missing releases in other trials remain a
verified limitation, not a reason to manufacture a complete edge sequence. The observation and signal-source decision are complete;
production bindings, release-loss recovery, exhaustive button combinations,
and labeled right-side validation are subsequent implementation work.

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

The September 7 continuation uses `raw-sequences-20260907.ndjson`,
`raw-sequences-20260907.stderr`, `journal-20260907.log`, and
`journal-20260907.stderr` under the same temporary directory. Relevant
selected evidence is committed separately for each date.
