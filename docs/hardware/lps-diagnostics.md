# LPS diagnostic stream

`lps` is a recognized WebSocket sensor type, available through an explicit
subscription and `useSensorFrame('lps')`. It has no occupancy, calibration,
biometric, or persistence consumer. Recognition removes the generic unknown-type
warning; it does not imply physiological validation.

```json
{"type":"subscribe","sensors":["lps","piezo-dual"]}
```

Both RAW and NATS sources use the shared dispatcher. NATS field validation is
still pending; the field reports below are from RAW firmware.

## Field provenance and transport verification

Trinity reports Pod 4 model prefix `20500-0004-G09`, firmware 1.4.2,
Eight Layer 4.0.2. The 210-second sequence was captured on the older `dd5c425`
build; it is evidence about sensor data, not verification of the subscription fix.
The original `lps-piezo-sequence.jsonl` was analyzed on September 8, 2026:

- 3,690,384 bytes, 420 records; SHA-256
  `d4f16caafe34ed6eebcc89c074098b2c3378da64f1655f2313d31c00de200652`.
- 210 frames per stream; phase counts 30/60/30/60/30 for each stream.
- LPS timestamps 1788776870–1788777079; piezo timestamps
  1788776869–1788777078, with consecutive one-second steps in both streams.
  These ranges differ by one second. The analysis uses firmware timestamps
  without shifting either stream or assuming their sample clocks are aligned.

After updating to `64c70e6`, Trinity separately verified:

- No `unknown sensor frame type "lps"` warnings during the new boot; the prior
  boot had logged the warning at 01:01:54.
- The exact subscription above returned
  `{"type":"subscribed","sensors":["lps","piezo-dual"]}`.
- A 30-second check delivered 30 LPS and 30 piezo frames, with no unrequested
  types, and logged `[sensorStream] Client subscribed to: lps, piezo-dual`.
- LPS retained `adc=1`, `freq=200`, four 800-byte channels and the same temp block.
- Startup logged `selecting RAW source (raw installation)` immediately,
  avoiding the 60-second NATS probe.

These are user-reported on-device checks, distinct from the automated fixture
regression below.

## Verified sample structure

Every captured LPS frame has `type: "lps"`, `ts` in Unix seconds, `temp` with
numeric `left1`, `left2`, `right1`, `right2` (all zero), and `pres` containing
`adc: 1`, `freq: 200`, and four equally named byte channels. Each channel contains
800 bytes: 200 little-endian int32 samples, one second at the reported rate.
Frames arrive at 1 Hz; samples within LPS frames are at 200 Hz. Paired piezo
frames contain 500 numeric samples per channel at `freq=500`, for `left1` and
`right1` only. LPS runs alongside piezo, not in its place.

LPS preserves its nested payload. On the Node WebSocket stream byte buffers
serialize as `{"type":"Buffer","data":[...bytes]}`. In contrast, `piezo-dual`
is already converted to numeric sample arrays before WebSocket transmission;
its WebSocket payload is not the original firmware byte representation.
The acronym, measurement units, and underlying sensor hardware remain unconfirmed.

## Verified occupancy sequence

The sequence comprises `empty_1` (30 s), `left` occupied (60 s), `empty_2`
(30 s), `right` occupied (60 s), `empty_3` (30 s), with both sides off throughout
according to the capture report. "Left" means the sleeper's left lying face-up.

The following are medians of per-frame means over each phase's final 20 frames,
excluding candidate sentinel samples from statistics. These are exploratory raw
counts, not calibrated pressure units or occupancy thresholds.

| Phase | LPS left1 | LPS right1 |
|---|---:|---:|
| empty_1 | 340.5 | 181.2 |
| left | 34,264.5 | 1,202,453.8 |
| empty_2 | 514.4 | 13,114.6 |
| right | 451,992.3 | 28,197.7 |
| empty_3 | 2,855.6 | 797.3 |

- `right1` responds most strongly to physical left occupancy; `left1` responds
  most strongly to physical right occupancy. The piezo channels follow the same
  convention: median within-frame SD over the final 20 piezo frames is roughly
  21 times greater in `right1` during left occupancy and 13 times greater in
  `left1` during right occupancy. Preserve firmware channel names.
- LPS `left2` and `right2` stay around 32767 with tiny fluctuations (median
  within-frame SD about 0.6 counts). This supports inactivity in the trial,
  not proof of unpopulated or disconnected hardware.
- All temperature fields remain zero. Units and validity are unknown; do not
  present these as measured temperatures.
- Previously occupied channels fall substantially during empty periods, with
  transients and residual elevation. This is not a fitted recovery constant or
  proof of static pressure sensing. The initial empty phase also settles.
- Similar phase responses do not establish that LPS is filtered piezo or validate
  physiological measurements. This trial does not separate sustained load,
  movement, filtering and sensor recovery sufficiently for production decisions.

### Candidate invalid samples

`0x7fffffff` occurs synchronously in all four channels in two frames:

| Firmware timestamp | Phase | Zero-based sample indices | Interval within frame |
|---|---|---|---|
| 1788776886 | empty_1 | 20–29 | [0.10, 0.15) seconds |
| 1788776932 | left | 100–109 | [0.50, 0.55) seconds |

This corrects the earlier summary that put both bursts at indices 20–29.
Eight channel buffers out of 840 are affected. Each burst spans 50 ms at 200 Hz.
The analyzer flags these as candidate invalid markers, excludes them from
statistics, and represents them as NaN gaps at their original sample positions
in plots. It does not interpolate, delete samples, replace them with zero, or
modify source bytes. Diagnostic transport continues to preserve these values.

The paired piezo stream also contains `0x7fffffff` in both channels at timestamps
1788776916 (index 490), 1788776980 (indices 490–491), and 1788777044 (index 491).
These affect six piezo channel arrays across three frames, at different times
from the LPS bursts. The analyzer flags these separately by stream type and uses
500 Hz for their time positions. Their firmware meaning also remains unconfirmed.

## Reproduce the analysis

The full capture stays outside Git. With Python 3.10+ and `uv`:

```bash
uv run scripts/analyze-lps-capture.py /path/to/lps-piezo-sequence.jsonl \
  --output-dir /tmp/lps-capture-report
```

The script declares its plotting dependency inline. It produces:

- `summary.json`: source hash, counts, timestamp steps, frequencies, phase
  statistics and every affected channel's sentinel indices and time offsets.
- `channels.png`: all four LPS channels alongside corresponding piezo channels,
  with labeled phase shading, valid-sample frame means, and red sentinel ticks.
  Missing piezo channels are labeled absent. Wide-range panels use symmetric-log
  y axes; narrow-range panels use linear axes. Scales are independent: compare
  numbers, not panel heights.

Time coordinates are `frame.ts + sample_index / frame.freq`. Phase shading
follows each stream's recorded labels, which mark capture phases rather than
precisely measured physical transitions. Missing frames remain time gaps.
The reader rejects malformed one-second frames and duplicate/reversed timestamps.
It is intentionally scoped to this capture format, not a general firmware decoder.
For a dependency-free summary:

```bash
python3 scripts/analyze-lps-capture.py /path/to/lps-piezo-sequence.jsonl \
  --output-dir /tmp/lps-capture-report --summary-only
python3 -m unittest discover -s scripts/tests -p 'test_analyze_lps_capture.py'
pnpm vitest run src/streaming/tests/piezoStream.test.ts
```

## Regression fixture

[`lps-field-excerpt.jsonl`](../../src/streaming/tests/fixtures/lps-field-excerpt.jsonl)
contains the two complete original JSONL lines with sentinel bursts, retaining
all channel bytes and metadata (18,907 bytes). Its SHA-256 is
`5b6fe62a42a03938f1ce6d07b5e76944ba0f3f5fd819686cd7514d2bb215d2ff`.

The WebSocket test reconstructs Buffers from these captured byte arrays, encodes
CBOR, runs the shared decoder and dispatcher with an LPS-only subscription, then
asserts exact received-frame equality, all four buffers byte-for-byte, and both
sentinel positions. This tests reconstructed transport input, not the original
RAW envelope or a live NATS feed. Existing synthetic subscription coverage remains.

No further physical experiment is requested for this analysis. Keep LPS diagnostic
only until broader evidence supports calibrated interpretation. Do not globally
swap channels or assume this format is exclusive to Pod 4 from one device.
