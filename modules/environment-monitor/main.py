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
import time
import signal
import logging
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cbor2
from common.raw_follower import RawFileFollower
from common.dialect import normalize_bed_temp

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


def write_freezer_temp(conn: sqlite3.Connection, ts: float, record: dict) -> None:
    """Parse frzTemp record and write to freezer_temp table.

    frzTemp format: {left, right, amb, hs} — all raw centidegrees (u16).
    """
    with conn:
        conn.execute(
            """INSERT OR IGNORE INTO freezer_temp
               (timestamp, ambient_temp, heatsink_temp,
                left_water_temp, right_water_temp)
               VALUES (?, ?, ?, ?, ?)""",
            (
                int(ts),
                record.get("amb"),
                record.get("hs"),
                record.get("left"),
                record.get("right"),
            ),
        )


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
    follower = RawFileFollower(RAW_DATA_DIR, _shutdown, poll_interval=0.5)

    # Seed cursors from DB so restarts don't replay already-ingested samples
    last_bed_write = float(
        db_conn.execute("SELECT COALESCE(MAX(timestamp), 0) FROM bed_temp").fetchone()[0] or 0
    )
    last_frz_write = float(
        db_conn.execute("SELECT COALESCE(MAX(timestamp), 0) FROM freezer_temp").fetchone()[0] or 0
    )

    report_health("healthy", "environment-monitor started")

    try:
        for record in follower.read_records():
            if not isinstance(record, dict):
                continue
            rtype = record.get("type")
            if rtype not in ("bedTemp", "bedTemp2", "frzTemp"):
                continue
            try:
                ts = float(record.get("ts", time.time()))
            except (TypeError, ValueError):
                log.warning("Skipping record with invalid ts: %r", record.get("ts"))
                continue

            if rtype in ("bedTemp", "bedTemp2"):
                if ts - last_bed_write >= DOWNSAMPLE_INTERVAL_S:
                    if write_bed_temp(db_conn, ts, record):
                        last_bed_write = ts

            elif rtype == "frzTemp":
                if ts - last_frz_write >= DOWNSAMPLE_INTERVAL_S:
                    write_freezer_temp(db_conn, ts, record)
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
