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

Movement scoring (Proportional Integration Mode):
  Movement is computed as the sum of absolute sample-to-sample deltas across
  the 3 sensing channel pairs per epoch (Kortelainen et al. 2010; Cole-Kripke
  1992). This measures actual body displacement over time rather than static
  deviation from an empty-bed baseline.

  Sentinel values (-1.0 from firmware) are filtered via zero-order hold.
  Reference channel pair is used for common-mode rejection.

  Expected score ranges (per 60s epoch, stored as integer 0-1000):
    0-50:    still (deep sleep, stable N2)
    50-200:  minor fidgeting/twitches
    200-500: limb repositioning, partial turns
    500+:    major position change, getting up
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

# Sentinel value emitted by capSense2 firmware on read errors
CAPSENSE2_SENTINEL = -1.0


def _extract_channel_values(record: dict, side: str,
                            baselines: Optional[dict] = None):
    """Extract averaged sensing channel values from a capSense/capSense2 record.

    Returns (values_list, rtype) where values_list is [A, B, C] averages
    (floats for capSense2, ints for capSense) and rtype is the record type.
    Returns (None, rtype) if the record is invalid or contains sentinels.

    If baselines are provided and include a ref mean, uses the calibrated
    reference instead of the hardcoded nominal 1.16.
    """
    data = record.get(side, {})
    if not data:
        return None, record.get("type", "")

    rtype = record.get("type", "")

    if rtype == "capSense2":
        vals = data.get("values")
        if not vals or len(vals) < 6:
            return None, rtype
        # Check for sentinel values (-1.0)
        for i in range(6):
            if vals[i] == CAPSENSE2_SENTINEL:
                return None, rtype
        # Average redundant pairs: A=[0:2], B=[2:4], C=[4:6]
        a = (vals[0] + vals[1]) / 2.0
        b = (vals[2] + vals[3]) / 2.0
        c = (vals[4] + vals[5]) / 2.0
        # Common-mode rejection using reference channel pair (indices 6,7)
        if len(vals) >= 8 and vals[6] != CAPSENSE2_SENTINEL and vals[7] != CAPSENSE2_SENTINEL:
            # Use calibrated ref mean if available, else hardcoded nominal
            ref_nominal = 1.16
            if baselines and baselines.get("ref"):
                ref_nominal = baselines["ref"].get("mean", 1.16)
            ref_delta = ((vals[6] + vals[7]) / 2.0) - ref_nominal
            a -= ref_delta
            b -= ref_delta
            c -= ref_delta
        return [a, b, c], rtype

    # capSense (Pod 3): named int channels — baselines param unused
    # (Pod 3 has no reference channel for common-mode rejection)
    a = int(data.get("out", 0))
    b = int(data.get("cen", 0))
    c = int(data.get("in", 0))
    return [a, b, c], rtype


def compute_movement_delta(current: list, previous: list) -> float:
    """Compute instantaneous movement from sample-to-sample delta.

    Sum of absolute deltas across all sensing channels.
    This is the Proportional Integration Mode (PIM) analog for bed sensors
    (Kortelainen et al. 2010; Cole-Kripke 1992).

    Returns a non-negative float. Accumulate over an epoch for scoring.
    """
    if not current or not previous or len(current) != len(previous):
        return 0.0
    return sum(abs(c - p) for c, p in zip(current, previous))


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
    _prev_values: Optional[list] = None  # previous sample's channel values
    _scale_factor: float = 10.0  # default for capSense2; updated on first record

    def process(self, ts: float, record: dict) -> None:
        baselines = self.calibration.get_baselines(self.side)
        rtype = record.get("type", "")
        # Only use baselines if they match the record format
        fmt = baselines.get("format") if baselines else None
        if rtype == "capSense2":
            cal = baselines if fmt == "capSense2" else None
            present = is_present_capsense2_calibrated(
                record, self.side, cal, fallback_threshold=60.0,
            )
        else:
            cal = baselines if fmt != "capSense2" else None
            present = is_present_capsense_calibrated(
                record, self.side, cal, fallback_threshold=PRESENCE_THRESHOLD,
            )

        # Set scale factor based on sensor type (Pod 3 int vs Pod 5 float)
        if rtype == "capSense" and self._scale_factor != 0.5:
            self._scale_factor = 0.5
        elif rtype == "capSense2" and self._scale_factor != 10.0:
            self._scale_factor = 10.0

        # Movement: sample-to-sample delta (PIM)
        current_values, _ = _extract_channel_values(record, self.side, baselines)
        if current_values is not None:
            delta = compute_movement_delta(current_values, self._prev_values)
            self._prev_values = current_values
        else:
            # Sentinel or invalid — skip delta, keep previous (zero-order hold)
            delta = 0.0

        self._update(ts, present, delta)

    def _update(self, ts: float, present: bool, movement: float) -> None:
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
        self._prev_values = None  # avoid stale delta on next session start
        self._movement_buf = []   # discard leftover deltas from session end

    def _flush_movement(self, ts: float) -> None:
        if ts - self._last_movement_write < MOVEMENT_INTERVAL_S:
            return
        if not self._movement_buf or self._session_start is None:
            # Only write movement during active sessions (O-2 fix)
            self._movement_buf = []
            self._last_movement_write = ts
            return
        # Sum of absolute deltas over the epoch (PIM analog)
        # Scale factor depends on sensor type:
        #   capSense2 (Pod 5): float channels, deltas ~0.05-5.0 → ×10
        #   capSense  (Pod 3): int ADC channels, deltas ~1-50 → ×0.5
        raw_sum = sum(self._movement_buf)
        total = min(1000, int(raw_sum * self._scale_factor))
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
