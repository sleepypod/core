# environment-monitor

Python sidecar that follows `/persistent/*.RAW` (CBOR-encoded sensor stream from `frankenfirmware`) and writes ambient, bed-zone, and freezer-loop temperatures into `biometrics.db`.

## What it writes

| Table | Columns | Source record |
| --- | --- | --- |
| `bed_temp` | `ambient_temp`, `mcu_temp`, `humidity`, six bed-zone thermistors (`{left,right}_{outer,center,inner}_temp`) | `bedTemp` (Pod 3/4) and `bedTemp2` (Pod 5) frames |
| `freezer_temp` | `ambient_temp`, `heatsink_temp`, `left_water_temp`, `right_water_temp` | `frzTemp` frames |

All values are stored in centidegrees C / centipercent so the schema is integer-typed and dialect-free. The two record dialects (`bedTemp` vs `bedTemp2`) are normalized in `modules/common/dialect.py` before insertion.

## Downsampling

Each record type is rate-limited to **one row per 60 seconds** (`DOWNSAMPLE_INTERVAL_S`), matching the vitals cadence used by `piezo-processor`. The firmware emits these frames much faster (every few seconds); at full rate the table would grow ~21k rows/day per record type. The downsample cursor only advances on a successful insert — an all-sentinel frame doesn't block the next 60s of valid samples.

## Sentinel filtering

Disconnected freezer sensors emit `-327.68 °C` (`0x8000` / `0xFFFF` in the raw u16 domain) instead of throwing. `_safe_freezer_centidegrees` drops these plus any reading outside `[-50 °C, 125 °C]` so `freezer_temp` never accumulates implausible spikes. See [ADR-0021](../../docs/adr/) for the rationale and #325 for the original incident.

## When `freezer_temp` is empty

The freezer table only populates on hardware that actually emits `frzTemp` frames — Pod 5 cover-only variants (no chiller hardware) won't write to it. That's expected, not a bug. `bed_temp` should still populate on every Pod generation.

## Operational signals

```bash
# Live logs (decisions, dropped sentinels, fatal errors)
journalctl -u sleepypod-environment-monitor.service -f

# Most recent rows
sqlite3 /persistent/sleepypod-data/biometrics.db \
  'SELECT * FROM bed_temp ORDER BY timestamp DESC LIMIT 3;'
sqlite3 /persistent/sleepypod-data/biometrics.db \
  'SELECT * FROM freezer_temp ORDER BY timestamp DESC LIMIT 3;'

# Health row (component='environment-monitor' is updated on start/exit)
sqlite3 /persistent/sleepypod-data/sleepypod.db \
  "SELECT * FROM system_health WHERE component='environment-monitor';"
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `RAW_DATA_DIR` | `/persistent` | Directory the RAW follower tails. The systemd unit overrides to `/persistent/biometrics` (tmpfs) — see ADR-0018. |
| `BIOMETRICS_DATABASE_URL` | `file:/persistent/sleepypod-data/biometrics.db` | Sink for `bed_temp` / `freezer_temp` rows. |
| `DATABASE_URL` | `file:/persistent/sleepypod-data/sleepypod.db` | Used only to write `system_health` heartbeats. |

## Python version

Pinned to `>=3.9,<3.11` to match the stock Pod interpreter (Pod 5 ships 3.9.9). Avoid PEP 604 union syntax (`int | None`) in this module — use `Optional[int]` from `typing` instead.
