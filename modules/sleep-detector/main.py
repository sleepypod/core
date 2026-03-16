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
  Presence is determined via calibrated z-score thresholds when a calibration
  profile is available, falling back to a fixed sum threshold otherwise.
  A session starts on the first present sample and ends after ABSENCE_TIMEOUT_S
  consecutive absent samples.

Movement scoring:
  When calibrated, movement is measured as the sum of per-channel deviations
  from the empty-bed baseline (in units of standard deviations). This makes
  scores comparable across pods with different sensor characteristics.
  Without calibration, raw channel magnitude is used as a fallback.
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
from typing import Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cbor2
from common.raw_follower import RawFileFollower
from common.calibration import (
    CalibrationStore,
    is_present_capsense_calibrated,
    is_present_capsense2_calibrated,
)
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
# Fallback presence threshold when uncalibrated
PRESENCE_THRESHOLD = 1500
# How often to reload calibration profiles (seconds)
CALIBRATION_RELOAD_S = 60

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
        try:
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
        finally:
            conn.close()
    except Exception as e:
        log.warning("Could not write health status: %s", e)

# ---------------------------------------------------------------------------
# Calibration-aware presence and movement
# ---------------------------------------------------------------------------

CHANNELS = ("out", "cen", "in")


def movement_score_calibrated(record: dict, side: str, baselines: Optional[dict]) -> int:
    """Compute movement as sum of per-channel z-score deviations from baseline.

    Returns a value in "centi-sigma" units (z-score * 100) regardless of
    calibration state, so that the movement column has a consistent scale.

    With calibration: each channel's deviation is measured in standard deviations
    from the empty-bed mean, then summed and scaled by 100.

    Without calibration: uses a default std of 500 per channel (empirical
    estimate for uncalibrated capacitance sensors) to produce scores in the
    same unit space. These will be less accurate but comparable in magnitude.
    """
    data = record.get(side, {})
    if not data:
        return 0

    # Default baseline: mean=0, std=500 per channel — empirical estimate
    # for uncalibrated capacitance sensors. Keeps output in the same
    # centi-sigma unit space as calibrated scores.
    DEFAULT_STD = 500

    if baselines is None:
        raw_sum = 0.0
        for ch in CHANNELS:
            raw_sum += abs(int(data.get(ch, 0))) / DEFAULT_STD
        return int(round(raw_sum * 100))

    channels = baselines.get("channels", {})
    score = 0.0
    for ch in CHANNELS:
        val = int(data.get(ch, 0))
        ch_cal = channels.get(ch, {})
        mean = ch_cal.get("mean", 0)
        std = ch_cal.get("std", 1)
        if std > 0:
            score += abs((val - mean) / std)
    return int(round(score * 100))


class CalibrationCache:
    """Periodically reloads capacitance calibration profiles for both sides."""

    def __init__(self, store: CalibrationStore):
        self._store = store
        self._profiles: Dict[str, Optional[dict]] = {"left": None, "right": None}
        self._last_reload = 0.0

    def get_baselines(self, side: str) -> Optional[dict]:
        self._maybe_reload()
        return self._profiles.get(side)

    def _maybe_reload(self) -> None:
        now = time.time()
        if now - self._last_reload < CALIBRATION_RELOAD_S:
            return
        self._last_reload = now
        for side in ("left", "right"):
            try:
                profile = self._store.get_active(side, "capacitance")
                if profile:
                    params = profile["parameters"]
                    self._profiles[side] = json.loads(params) if isinstance(params, str) else params
                else:
                    self._profiles[side] = None
            except Exception as e:
                log.warning("Failed to load calibration for %s: %s", side, e)

# ---------------------------------------------------------------------------
# Per-side session tracker
# ---------------------------------------------------------------------------

@dataclass
class SessionTracker:
    side: str
    db: sqlite3.Connection
    calibration: CalibrationCache
    _session_start: Optional[datetime] = None
    _last_present_ts: Optional[float] = None
    _present_intervals: list = field(default_factory=list)
    _absent_intervals: list = field(default_factory=list)
    _interval_start: Optional[float] = None
    _was_present: bool = False
    _exit_count: int = 0
    _movement_buf: list = field(default_factory=list)
    _last_movement_write: float = field(default_factory=time.time)

    def process(self, ts: float, record: dict) -> None:
        baselines = self.calibration.get_baselines(self.side)
        rtype = record.get("type", "")
        if rtype == "capSense2":
            present = is_present_capsense2_calibrated(
                record, self.side, baselines, fallback_threshold=60.0,
            )
        else:
            present = is_present_capsense_calibrated(
                record, self.side, baselines, fallback_threshold=PRESENCE_THRESHOLD,
            )
        movement = movement_score_calibrated(record, self.side, baselines)
        self._update(ts, present, movement)

    def _update(self, ts: float, present: bool, movement: int) -> None:
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
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    log.info("Starting sleep-detector (biometrics.db=%s)", BIOMETRICS_DB)

    if not BIOMETRICS_DB.parent.exists():
        log.error("Biometrics DB directory does not exist: %s", BIOMETRICS_DB.parent)
        sys.exit(1)

    db_conn = open_biometrics_db()
    cal_store = CalibrationStore(BIOMETRICS_DB)
    cal_cache = CalibrationCache(cal_store)

    left = SessionTracker(side="left", db=db_conn, calibration=cal_cache)
    right = SessionTracker(side="right", db=db_conn, calibration=cal_cache)
    follower = RawFileFollower(RAW_DATA_DIR, _shutdown, poll_interval=0.5)

    report_health("healthy", "sleep-detector started")
    log.info("Calibration profiles will be loaded from biometrics.db (reload every %ds)", CALIBRATION_RELOAD_S)

    try:
        for record in follower.read_records():
            if record.get("type") not in ("capSense", "capSense2"):
                continue

            ts = float(record.get("ts", time.time()))
            left.process(ts, record)
            right.process(ts, record)

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        cal_store.close()
        db_conn.close()
        log.info("Shutdown complete")

    # Only reached on clean shutdown (not via sys.exit)
    report_health("down", "sleep-detector stopped")


if __name__ == "__main__":
    main()
