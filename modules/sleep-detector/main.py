#!/usr/bin/env python3
"""
SleepyPod sleep-detector module.

Reads capacitance sensor data from /persistent/*.RAW (CBOR-encoded) to detect
bed occupancy, session boundaries, and movement. Writes results to biometrics.db.

Writes to two tables:
  - sleep_records: one row per sleep session (entered/left bed, duration, intervals)
  - movement:      one row per sample interval with aggregate movement score

Detection logic:
  Each capacitance record contains three channels per side (out, cen, in).
  Presence is determined by whether any channel exceeds its calibrated threshold.
  A session starts on the first present sample and ends after ABSENCE_TIMEOUT_S
  consecutive absent samples.
"""

import os
import sys
import time
import json
import signal
import logging
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional

import cbor2
import numpy as np

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RAW_DATA_DIR = Path(os.environ.get("RAW_DATA_DIR", "/persistent"))
BIOMETRICS_DB = Path(os.environ.get("BIOMETRICS_DATABASE_URL", "file:/persistent/sleepypod-data/biometrics.db").replace("file:", ""))
SLEEPYPOD_DB = Path(os.environ.get("DATABASE_URL", "file:/persistent/sleepypod-data/sleepypod.db").replace("file:", ""))

# Seconds of continuous absence before we consider the user has left bed
ABSENCE_TIMEOUT_S = 120
# Minimum session length to record (filters out accidental detections)
MIN_SESSION_S = 300
# How often to write a movement row (seconds)
MOVEMENT_INTERVAL_S = 60
# Presence threshold: sum of all three capacitance channels must exceed this
PRESENCE_THRESHOLD = 1500

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [sleep-detector] %(levelname)s %(message)s",
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


def write_sleep_record(conn: sqlite3.Connection, side: str,
                       entered: datetime, left: datetime,
                       duration_s: int, exits: int,
                       present_intervals: list, absent_intervals: list) -> None:
    with conn:
        conn.execute(
            """INSERT INTO sleep_records
               (side, entered_bed_at, left_bed_at, sleep_duration_seconds,
                times_exited_bed, present_intervals, not_present_intervals, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                side,
                int(entered.timestamp()),
                int(left.timestamp()),
                duration_s,
                exits,
                json.dumps(present_intervals),
                json.dumps(absent_intervals),
                int(time.time()),
            ),
        )


def write_movement(conn: sqlite3.Connection, side: str,
                   ts: datetime, total_movement: int) -> None:
    with conn:
        conn.execute(
            "INSERT INTO movement (side, timestamp, total_movement) VALUES (?, ?, ?)",
            (side, int(ts.timestamp()), total_movement),
        )


def report_health(status: str, message: str) -> None:
    try:
        conn = sqlite3.connect(str(SLEEPYPOD_DB), timeout=2.0)
        with conn:
            conn.execute(
                """INSERT INTO system_health (component, status, message, last_checked)
                   VALUES ('sleep-detector', ?, ?, ?)
                   ON CONFLICT(component) DO UPDATE SET
                     status=excluded.status,
                     message=excluded.message,
                     last_checked=excluded.last_checked""",
                (status, message, int(time.time())),
            )
        conn.close()
    except Exception as e:
        log.warning("Could not write health status: %s", e)

# ---------------------------------------------------------------------------
# Presence detection
# ---------------------------------------------------------------------------

def is_present_capsense(record: dict, side: str) -> bool:
    """Determine presence from capacitance channels for a given side."""
    data = record.get(side, {})
    total = (
        int(data.get("out", 0))
        + int(data.get("cen", 0))
        + int(data.get("in", 0))
    )
    return total > PRESENCE_THRESHOLD


def movement_score(record: dict, side: str) -> int:
    """Aggregate movement proxy: sum of absolute channel values."""
    data = record.get(side, {})
    return abs(int(data.get("out", 0))) + abs(int(data.get("cen", 0))) + abs(int(data.get("in", 0)))

# ---------------------------------------------------------------------------
# Per-side session tracker
# ---------------------------------------------------------------------------

@dataclass
class SessionTracker:
    side: str
    db: sqlite3.Connection
    _session_start: Optional[datetime] = None
    _last_present_ts: Optional[float] = None
    _present_intervals: list = field(default_factory=list)
    _absent_intervals: list = field(default_factory=list)
    _interval_start: Optional[float] = None
    _was_present: bool = False
    _exit_count: int = 0
    _movement_buf: list = field(default_factory=list)
    _last_movement_write: float = field(default_factory=time.time)

    def update(self, ts: float, present: bool, movement: int) -> None:
        self._movement_buf.append(movement)
        self._flush_movement(ts)

        if present:
            if self._session_start is None:
                # New session starts
                self._session_start = datetime.fromtimestamp(ts, tz=timezone.utc)
                self._interval_start = ts
                self._was_present = True
                log.info("%s: session started at %s", self.side, self._session_start.isoformat())

            elif not self._was_present and self._interval_start is not None:
                # Returning from absence — close absent interval, open present interval
                self._absent_intervals.append([self._interval_start, ts])
                self._interval_start = ts

            self._last_present_ts = ts
            self._was_present = True

        else:
            if self._was_present and self._interval_start is not None:
                # Just went absent — close present interval, open absent interval
                self._present_intervals.append([self._interval_start, ts])
                self._interval_start = ts
                self._exit_count += 1

            self._was_present = False

            # Check if absence timeout has elapsed → close session
            if (self._session_start is not None
                    and self._last_present_ts is not None
                    and ts - self._last_present_ts >= ABSENCE_TIMEOUT_S):
                # Close at interval_start (first absent sample) when available to
                # avoid emitting absent intervals with end < start
                close_ts = self._interval_start if self._interval_start is not None else self._last_present_ts
                self._close_session(close_ts)

    def _close_session(self, left_ts: float) -> None:
        if self._session_start is None:
            return

        left_at = datetime.fromtimestamp(left_ts, tz=timezone.utc)
        duration_s = int(left_ts - self._session_start.timestamp())

        if duration_s < MIN_SESSION_S:
            log.info("%s: session too short (%ds), discarding", self.side, duration_s)
        else:
            # Close any open interval
            if self._interval_start is not None:
                if self._was_present:
                    self._present_intervals.append([self._interval_start, left_ts])
                elif left_ts > self._interval_start:
                    self._absent_intervals.append([self._interval_start, left_ts])

            write_sleep_record(
                self.db, self.side,
                self._session_start, left_at,
                duration_s, self._exit_count,
                self._present_intervals, self._absent_intervals,
            )
            log.info("%s: session recorded — %.1f hr, %d exits",
                     self.side, duration_s / 3600, self._exit_count)

        # Reset
        self._session_start = None
        self._last_present_ts = None
        self._present_intervals = []
        self._absent_intervals = []
        self._interval_start = None
        self._was_present = False
        self._exit_count = 0

    def _flush_movement(self, ts: float) -> None:
        if ts - self._last_movement_write < MOVEMENT_INTERVAL_S:
            return
        if self._movement_buf:
            total = int(np.mean(self._movement_buf))
            write_movement(self.db, self.side,
                           datetime.fromtimestamp(ts, tz=timezone.utc), total)
            self._movement_buf = []
        self._last_movement_write = ts

# ---------------------------------------------------------------------------
# RAW file follower (same pattern as piezo-processor)
# ---------------------------------------------------------------------------

class RawFileFollower:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self._file = None
        self._path = None

    def _find_latest(self):
        candidates = sorted(self.data_dir.glob("*.RAW"), key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates[0] if candidates else None

    def read_records(self):
        while not _shutdown.is_set():
            latest = self._find_latest()
            if latest is None:
                time.sleep(1)
                continue

            if latest != self._path:
                log.info("Switched to RAW file: %s", latest.name)
                if self._file:
                    self._file.close()
                self._file = open(latest, "rb")
                self._path = latest

            try:
                record = cbor2.load(self._file)
                inner = cbor2.loads(record["data"])
                yield inner
            except EOFError:
                time.sleep(0.5)
            except Exception as e:
                log.warning("Error reading RAW record: %s", e)
                time.sleep(1)

        # Clean up file handle on shutdown
        if self._file:
            self._file.close()
            self._file = None

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    log.info("Starting sleep-detector (biometrics.db=%s)", BIOMETRICS_DB)

    if not BIOMETRICS_DB.parent.exists():
        log.error("Biometrics DB directory does not exist: %s", BIOMETRICS_DB.parent)
        sys.exit(1)

    db_conn = open_biometrics_db()
    left = SessionTracker(side="left", db=db_conn)
    right = SessionTracker(side="right", db=db_conn)
    follower = RawFileFollower(RAW_DATA_DIR)

    report_health("healthy", "sleep-detector started")

    try:
        for record in follower.read_records():
            if record.get("type") != "capSense":
                continue

            ts = float(record.get("ts", time.time()))
            left.update(ts, is_present_capsense(record, "left"), movement_score(record, "left"))
            right.update(ts, is_present_capsense(record, "right"), movement_score(record, "right"))

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        db_conn.close()
        log.info("Shutdown complete")

    # Only reached on clean shutdown (not via sys.exit)
    report_health("down", "sleep-detector stopped")


if __name__ == "__main__":
    main()
