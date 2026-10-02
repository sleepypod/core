# LPS diagnostic stream

`lps` is a recognized WebSocket sensor type, available through an explicit
subscription and `useSensorFrame('lps')`. It has no occupancy, calibration,
biometric, or persistence consumer. Recognition removes the generic unknown-type
warning; it does not imply physiological validation.

```json
{"type":"subscribe","sensors":["lps","piezo-dual"]}
```

Both RAW and NATS sources use the shared dispatcher. NATS field validation is
still pending; the LPS reports below are from RAW firmware.

## Reported schema

Trinity reports Pod 4 model prefix `20500-0004-G09`, firmware 1.4.2,
Eight Layer 4.0.2, running core `dev` at `dd5c425`. Only the capture README
and summary were available for this implementation, not the JSONL records.
Tests use synthetic payloads matching the reported schema.

Each frame has `type: "lps"`, `ts` in Unix seconds, `temp` with numeric
`left1`, `left2`, `right1`, `right2`, and `pres` containing `adc: 1`,
`freq: 200`, and four equally named byte channels. Each channel contains
800 bytes: 200 little-endian int32 samples, one second at the reported rate.
The stream runs alongside `piezo-dual`, not in its place. The acronym,
measurement units, and underlying sensor hardware remain unconfirmed.

LPS preserves its nested payload. On the Node WebSocket stream byte buffers
serialize as `{"type":"Buffer","data":[...bytes]}`. In contrast, `piezo-dual`
is already converted to numeric sample arrays before WebSocket transmission;
its WebSocket payload is not the original firmware byte representation.

## Reported occupancy sequence

The 210-second sequence comprises empty (30 s), left occupied (60 s), empty
(30 s), right occupied (60 s), empty (30 s), with both sides off throughout.
"Left" means the sleeper's left while lying face-up.

- `right1` responds most strongly to physical left occupancy; `left1` responds
  most strongly to physical right occupancy. Preserve firmware names until the
  paired piezo capture establishes whether this is a shared convention.
- `left2` and `right2` stay around 32767 with zero IQR, independent of load.
  This supports inactivity in the trial, not proof of unpopulated hardware.
- All temperature fields remain zero. Units and validity are unknown; do not
  present these as measured temperatures.
- Empty phases after occupancy remain elevated. Settling, sensor recovery, or
  filtering may contribute; the initial empty phase is a reference, not a
  calibrated physical zero.
- `0x7fffffff` occurs at sample indices 20–29 in all four channels of two
  frames: eight affected channel buffers out of 840, two frames out of 210.
  The synchronized ten-sample burst spans 50 ms at 200 Hz. Treat this as a
  candidate missing-data marker in future analysis, preserving time positions.
  Diagnostic transport deliberately preserves the original bytes, including
  these values, rather than deleting samples or replacing them with zero.

## Remaining evidence

Field JSONL data remains pending. When the capture is available, use it with the
phase metadata to verify the sample bytes, compare LPS and piezo side responses
and timing, and plot unload recovery. No further physical experiment is requested.
Complete this analysis before adding
sample interpretation or biometric consumers. Do not globally swap channels,
label channels as disconnected, or assume the format is exclusive to Pod 4
based on this single-device report.
