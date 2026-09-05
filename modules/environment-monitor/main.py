#!/usr/bin/env python3
"""
SleepyPod environment-monitor module.

Reads bedTemp and frzTemp records from /persistent/*.RAW (CBOR-encoded) to track
ambient, bed zone, and freezer temperatures plus humidity. Writes results to
biometrics.db.

Writes to two tables:
  - bed_temp:     ambient, MCU temp, humidity, six bed zone thermistors
  - freezer_temp: ambient, heatsink, left/right water temps

Downsamples to 60s writes to match the vitals cadence and avoid excessive row
counts (~1440 rows/day vs 21k if writing every raw sample).
"""

import os
import sys
import math
import time
import signal
import logging
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cbor2
from common.nats_follower import create_follower
from common.dialect import (
    KNOWN_RECORD_TYPES,
    normalize_bed_temp,
    warn_unknown_type_once,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RAW_DATA_DIR = Path(os.environ.get("RAW_DATA_DIR", "/persistent"))
BIOMETRICS_DB = Path(os.environ.get(
    "BIOMETRICS_DATABASE_URL",
    "file:/persistent/sleepypod-data/biometrics.db",
).replace("file:", ""))
SLEEPYPOD_DB = Path(os.environ.get(
    "DATABASE_URL",
    "file:/persistent/sleepypod-data/sleepypod.db",
).replace("file:", ""))

# Write at most once per 60s per record type
DOWNSAMPLE_INTERVAL_S = 60

# Timestamp sanity window (mirrors sleep-detector's sanitize_ts)
MIN_VALID_WALL_CLOCK_TS = 1577836800.0  # 2020-01-01 00:00:00 UTC
MAX_FUTURE_SKEW_S = 60.0


def sanitize_ts(raw_ts) -> float:
    """Coerce a RAW frame's `ts` field into a sane wall-clock timestamp.

    The downsample cursors seed from MAX(timestamp) at startup, so a single
    far-future timestamp written to the DB would permanently block all
    subsequent writes — surviving restarts. Falls back to time.time() when:
      - the field is missing or not a number
      - the value is NaN or +/-inf (CBOR-encoded IEEE 754 specials)
      - the value is < 2020-01-01 epoch (firmware emitted a relative
        timestamp before establishing wall-clock)
      - the value is more than MAX_FUTURE_SKEW_S in the future
    """
    now = time.time()
    try:
        ts = float(raw_ts) if raw_ts is not None else now
    except (TypeError, ValueError):
        return now
    if not math.isfinite(ts):
        return now
    if ts < MIN_VALID_WALL_CLOCK_TS:
        return now
    if ts > now + MAX_FUTURE_SKEW_S:
        return now
    return ts

# Hardware sentinel for "no sensor connected"
NO_SENSOR = -327.68
# u16-domain sentinels emitted by freezer firmware on disconnected sensors.
# -327.68 * 100 = -32768 (two's-complement) = 0x8000 / 32768 unsigned.
# 0xffff (65535) is also observed on some builds as "read error".
# Range gate: freezer water/heatsink/ambient should never be below -50 °C
# (-5000 centi°C) or above 125 °C (12500 centi°C).
_FRZ_SENTINELS = {32768, 65535, -32768, -1}
_FRZ_MIN_CENTIDEGREES = -5000
_FRZ_MAX_CENTIDEGREES = 12500


def _safe_freezer_centidegrees(val) -> Optional[int]:
    """Validate a raw firmware centidegrees value for freezer_temp insertion.

    Rejects sentinel values (disconnected sensor) and out-of-range values
    (implausible readings). Returns the int on success, None to omit (#325).
    """
    if val is None:
        return None
    try:
        iv = int(val)
    except (TypeError, ValueError):
        return None
    if iv in _FRZ_SENTINELS:
        return None
    if iv < _FRZ_MIN_CENTIDEGREES or iv > _FRZ_MAX_CENTIDEGREES:
        return None
    return iv


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [environment-monitor] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------

_shutdown = threading.Event()


def _on_signal(signum, frame):
    log.info("Received signal %d, shutting down...", signum)
    _shutdown.set()


signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


def open_biometrics_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(BIOMETRICS_DB), timeout=5.0, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def write_bed_temp(conn: sqlite3.Connection, ts: float, record: dict) -> bool:
    """Normalize a bedTemp/bedTemp2 record and write to bed_temp table.

    Dialect handling lives in common.dialect.normalize_bed_temp — this
    function consumes the canonical row-shape and writes it.

    Returns True on a successful insert, False if the record didn't match
    a known dialect (caller should not advance the downsample cursor).
    """
    canonical = normalize_bed_temp(record)
    if canonical is None:
        return False

    with conn:
        conn.execute(
            """INSERT OR IGNORE INTO bed_temp
               (timestamp, ambient_temp, mcu_temp, humidity,
                left_outer_temp, left_center_temp, left_inner_temp,
                right_outer_temp, right_center_temp, right_inner_temp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                int(ts),
                canonical["ambient_temp"],
                canonical["mcu_temp"],
                canonical["humidity"],
                canonical["left_outer_temp"],
                canonical["left_center_temp"],
                canonical["left_inner_temp"],
                canonical["right_outer_temp"],
                canonical["right_center_temp"],
                canonical["right_inner_temp"],
            ),
        )
    return True


def write_freezer_temp(conn: sqlite3.Connection, ts: float, record: dict) -> bool:
    """Parse frzTemp record and write to freezer_temp table.

    frzTemp format: {left, right, amb, hs} — all raw centidegrees (u16).
    Applies sentinel filtering and range validation (#325) so disconnected
    sensors don't pollute the freezer_temp table with 32768 / -327.68 values.

    Returns True iff a row was inserted. Caller should advance the
    downsample cursor only on True so an all-sentinel frame doesn't block
    the next 60s of valid samples.
    """
    amb = _safe_freezer_centidegrees(record.get("amb"))
    hs = _safe_freezer_centidegrees(record.get("hs"))
    lw = _safe_freezer_centidegrees(record.get("left"))
    rw = _safe_freezer_centidegrees(record.get("right"))

    if amb is None and hs is None and lw is None and rw is None:
        return False

    with conn:
        conn.execute(
            """INSERT OR IGNORE INTO freezer_temp
               (timestamp, ambient_temp, heatsink_temp,
                left_water_temp, right_water_temp)
               VALUES (?, ?, ?, ?, ?)""",
            (int(ts), amb, hs, lw, rw),
        )
    return True


def report_health(status: str, message: str) -> None:
    try:
        conn = sqlite3.connect(str(SLEEPYPOD_DB), timeout=2.0)
        try:
            with conn:
                conn.execute(
                    """INSERT INTO system_health (component, status, message, last_checked)
                       VALUES ('environment-monitor', ?, ?, ?)
                       ON CONFLICT(component) DO UPDATE SET
                         status=excluded.status,
                         message=excluded.message,
                         last_checked=excluded.last_checked""",
                    (status, message, int(time.time())),
                )
        finally:
            conn.close()
    except sqlite3.Error as e:
        log.warning("Could not write health status: %s", e)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def main() -> None:
    log.info("Starting environment-monitor (biometrics.db=%s)", BIOMETRICS_DB)

    if not BIOMETRICS_DB.parent.exists():
        log.error("Biometrics DB directory does not exist: %s", BIOMETRICS_DB.parent)
        sys.exit(1)

    db_conn = open_biometrics_db()
    # Source selected once at startup: NatsFollower on new-firmware pods (NATS
    # reachable), else the unchanged .RAW tailer. Same decoded-record contract.
    follower = create_follower(RAW_DATA_DIR, _shutdown, poll_interval=0.5)

    # Seed cursors from DB so restarts don't replay already-ingested samples.
    # Clamp to now so a DB already poisoned by a far-future timestamp (written
    # before sanitize_ts existed) self-heals instead of blocking writes forever.
    now = time.time()
    last_bed_write = min(now, float(
        db_conn.execute("SELECT COALESCE(MAX(timestamp), 0) FROM bed_temp").fetchone()[0] or 0
    ))
    last_frz_write = min(now, float(
        db_conn.execute("SELECT COALESCE(MAX(timestamp), 0) FROM freezer_temp").fetchone()[0] or 0
    ))

    report_health("healthy", "environment-monitor started")

    try:
        for record in follower.read_records():
            if not isinstance(record, dict):
                continue
            rtype = record.get("type")
            # Surface genuinely-new firmware types once (blanketReadings, log,
            # …); known types this module doesn't consume fall through quietly.
            if rtype not in KNOWN_RECORD_TYPES:
                warn_unknown_type_once(record, "environment-monitor")
                continue
            if rtype not in ("bedTemp", "bedTemp2", "frzTemp"):
                continue
            ts = sanitize_ts(record.get("ts"))

            if rtype in ("bedTemp", "bedTemp2"):
                if ts - last_bed_write >= DOWNSAMPLE_INTERVAL_S:
                    if write_bed_temp(db_conn, ts, record):
                        last_bed_write = ts

            elif rtype == "frzTemp":
                if ts - last_frz_write >= DOWNSAMPLE_INTERVAL_S:
                    if write_freezer_temp(db_conn, ts, record):
                        last_frz_write = ts

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        db_conn.close()
        log.info("Shutdown complete")

    report_health("down", "environment-monitor stopped")


if __name__ == "__main__":
    main()
