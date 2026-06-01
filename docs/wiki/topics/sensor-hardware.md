# Sensor Hardware

CBOR record types and data shapes across pod generations. The [[biometrics-system]] modules must handle all known variants.

## Record Type Matrix

| Record Type | Pod 3 | Pod 5 | Notes |
|---|---|---|---|
| `piezo-dual` | Yes | Yes | Same format — used by [[piezo-processing]] |
| `capSense` | Yes | No | 3 named integer channels — used by [[sleep-detection]] |
| `capSense2` | No | Yes | 8 unnamed float channels — used by [[sleep-detection]] |
| `bedTemp` / `bedTemp2` | Pod 3 / Pod 5 | — | Generation-specific |
| `frzTemp` | Yes | Yes | Same format |
| `frzTherm` | No | Yes | Pod 5 only |
| `frzHealth` | No | Yes | Pod 5 only — provides pump RPM for gating |
| `log` | Yes | Yes | Same format |

## capSense vs capSense2

### capSense (Pod 3)
3 named integer channels per side: `out`, `cen`, `in`. Values in hundreds/thousands.

### capSense2 (Pod 5)
8 unnamed float channels per side in a `values` array. 4 redundant pairs (3 sensing + 1 reference). Values in tens.

### Channel Map (Pod 5, validated 2026-03-16)

| Index | Name | Empty | Occupied (left) | Delta | Role |
|---|---|---|---|---|---|
| 0-1 | A pair | 14.03 | 33.85 | **+19.8** | Primary presence (highest sensitivity) |
| 2-3 | B pair | 14.31 | 23.90 | **+9.6** | Secondary presence |
| 4-5 | C pair | 19.40 | 24.15 | **+4.8** | Tertiary presence |
| 6-7 | REF pair | 1.16 | 1.15 | -0.01 | Reference/ground (no body response) |

Key observations:
- A pair is most sensitive (+140% delta) — best single indicator of presence
- REF pair confirmed as reference (used for drift compensation in [[sleep-detection]])
- No cross-talk between left and right sides
- After exit, values remain slightly elevated and decay slowly (residual heat signature)
- Sampling rate: ~2 Hz

### Comparison

| Property | capSense (Pod 3) | capSense2 (Pod 5) |
|---|---|---|
| Channels | 3 named (`out`, `cen`, `in`) | 4 pairs (8 values), 3 sensing + 1 ref |
| Data type | Integer (hundreds/thousands) | Float (tens) |
| Reference channel | None | ch6-7 (~1.16, stable) |
| Pairing | Single-ended | Redundant pairs (r > 0.99) |

## Impact on Calibration

The [[sensor-calibration]] system needs separate calibrators per sensor type because of different data shapes, value ranges, and reference channel availability. See `CapCalibrator` vs future `CapSense2Calibrator`.

## Pod Hardware

| Field | Pod 5 |
|---|---|
| Board | MT8365 Pumpkin |
| SoC | MediaTek MT8365 (aarch64) |
| Kernel | 5.15.42 |
| OS | Eight Layer 4.0.2 (Yocto kirkstone) |

## Discovery Notes

- capSense2 format identified by community member Ely as specific to newest Pod 5 cover version
- Cap sense calibration has never worked on Pod 5 — code was only tested on Pod 3
- Format difference is hardware-specific (different cover PCB), not a firmware update

## Sources

- `docs/hardware/sensor-profiles.md`
