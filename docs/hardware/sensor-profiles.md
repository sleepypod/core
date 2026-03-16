# Pod Hardware Sensor Profiles

CBOR record types and data shapes written by the Capybara firmware vary across pod generations. The free-sleep biometrics code was developed against Pod 3. sleepypod-core must handle all known variants.

## Record Type Matrix

| Record Type | Pod 3 | Pod 5 (new cover) | Notes |
|---|---|---|---|
| `piezo-dual` | Yes | Yes | Same format across generations |
| `capSense` | Yes | **No** | 3 named integer channels per side |
| `capSense2` | No | **Yes** | 8 unnamed float channels per side |
| `bedTemp` | Yes | **No** | |
| `bedTemp2` | No | **Yes** | |
| `frzTemp` | Yes | Yes | Same format |
| `frzTherm` | No | Yes | Pod 5 only |
| `frzHealth` | No | Yes | Pod 5 only |
| `log` | Yes | Yes | Same format |

## capSense vs capSense2

### capSense (Pod 3)

```json
{
  "type": "capSense",
  "ts": 1736506822,
  "left": {
    "out": 387,
    "cen": 381,
    "in": 505,
    "status": "good"
  },
  "right": {
    "out": 1076,
    "cen": 1075,
    "in": 1074,
    "status": "good"
  }
}
```

- 3 named channels: `out`, `cen`, `in` (integers)
- Used directly by free-sleep `cap_data.py` and sleepypod-core `CapCalibrator`

### capSense2 (Pod 5 new cover)

```json
{
  "type": "capSense2",
  "ts": 1773621373,
  "version": 1,
  "left": {
    "values": [32.64, 32.61, 25.35, 25.29, 26.53, 26.52, 1.16, 1.15],
    "status": "good"
  },
  "right": {
    "values": [16.66, 16.64, 16.06, 16.08, 20.61, 20.61, 1.16, 1.16],
    "status": "good"
  }
}
```

- 4 paired float channels in a `values` array (8 floats total)
- Has a `version` field (observed: `1`)
- Paired channels are redundant (not differential) — each pair tracks near-identically (r > 0.99)

### capSense2 Channel Map

Validated via physical presence test (empty bed → occupied left side → empty bed, 2026-03-16).

| Index | Name | Empty bed | Occupied (left) | Delta | Sensitivity | Role |
|---|---|---|---|---|---|---|
| `values[0]` | A1 | 14.03 | 33.85 | **+19.8** | Highest | Primary presence electrode |
| `values[1]` | A2 | 14.01 | 33.83 | **+19.8** | Highest | Redundant pair of A1 |
| `values[2]` | B1 | 14.31 | 23.90 | **+9.6** | Medium | Secondary presence electrode |
| `values[3]` | B2 | 14.31 | 23.83 | **+9.6** | Medium | Redundant pair of B1 |
| `values[4]` | C1 | 19.40 | 24.15 | **+4.8** | Low | Tertiary presence electrode |
| `values[5]` | C2 | 19.39 | 24.13 | **+4.8** | Low | Redundant pair of C1 |
| `values[6]` | REF1 | 1.16 | 1.15 | **-0.01** | None | Reference/ground (confirmed) |
| `values[7]` | REF2 | 1.16 | 1.15 | **-0.01** | None | Reference/ground (confirmed) |

Key observations:
- **ch0-1 (A pair)** is by far the most sensitive (+140% delta). Best single indicator of presence.
- **ch6-7 (REF pair)** confirmed as reference — essentially zero response to body presence.
- **Residual heat signature**: after exiting bed, values remain slightly elevated (14.03 → 14.55) and decay slowly.
- **Right side showed zero response** when left side was occupied — no cross-talk between sides.
- **Sampling rate**: ~2 Hz (2 samples/second per side).

### capSense2 vs capSense comparison

| Property | capSense (Pod 3) | capSense2 (Pod 5) |
|---|---|---|
| Channel count | 3 named (`out`, `cen`, `in`) | 4 pairs (8 values), 3 sensing + 1 reference |
| Data type | Integer (hundreds/thousands) | Float (tens) |
| Reference channel | None | ch6-7 (~1.16, stable) |
| Pairing | Single-ended | Redundant pairs (not differential) |
| Presence delta range | ~hundreds | ~5 to ~20 |
| `version` field | No | Yes (observed: `1`) |

## Impact on Calibration

The `CapCalibrator` currently reads `rec[side]["out"/"cen"/"in"]` which only works for `capSense`. A separate `CapSense2Calibrator` is needed because:

1. Different data shape (8 indexed floats vs 3 named ints)
2. Different value ranges and thresholds
3. Reference channels (ch6-7) can be used for drift compensation
4. Redundant pairs can be averaged for noise reduction

See `modules/common/calibration.py` (`CapCalibrator` class) and `modules/calibrator/main.py` (`load_recent_records`).

## Hardware Identification

| Field | Pod 5 (observed) |
|---|---|
| Board | MT8365 Pumpkin |
| SoC | MediaTek MT8365 (aarch64) |
| Kernel | 5.15.42 |
| OS | Eight Layer 4.0.2 (Yocto kirkstone) |
| Device label | `20500-0005-G55-*` |
| Sensor label | `20600-0003-J55-*` |
| Specialization | `pod` |
| Capybara binary | `/opt/eight/bin/Eight.Capybara` (.NET) |

## Discovery Notes

- The `capSense2` format was identified in the free-sleep community Slack by Ely as specific to the newest Pod 5 cover version, which few people have yet.
- Cap sense calibration has **never worked** on Pod 5 hardware — it has been returning 0 rows since the first log entry (2025-11-16). The code was only tested on Pod 3.
- The same firmware binary has been on disk since 2025-06-13 (`Birth` timestamp). The format difference is likely hardware-specific (different cover PCB), not a firmware update.

---

**Last Updated**: 2026-03-16
