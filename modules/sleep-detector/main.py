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

  Pump artifact gating (#230):
    Pump vibrations contaminate capSense2 deltas, inflating movement scores
    from ~50 to 960-990 overnight. Three-signal pump detection gates the
    movement delta computation:
      1. Primary: frzHealth pump RPM > 0 → pump running
      2. Secondary: reference channel anomaly (|ref_delta| > 0.02 with
         correlated active channel spikes = mechanical coupling)
      3. Guard period: 3 seconds trailing after pump-off (6 samples at ~2 Hz)
    When any gate is active, delta is forced to 0.

  Post-epoch processing:
    - Baseline subtraction: 5th percentile of trailing 30 epochs (10-min cold start)
    - 3-epoch median filter for smoothing
    - Clamp to [0, 1000]

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
import math
import signal
import logging
import sqlite3
import threading
from collections import deque
from pathlib import Path
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Dict, List, Optional

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
# Earliest ts considered a valid wall-clock timestamp (2020-01-01 UTC).
# RAW frames very rarely arrive with a tiny relative ts (e.g. 3s after some
# synthetic origin) before the firmware has a real wall-clock reference.
# When that happens, we fall back to time.time() rather than persisting a
# 1970-era entered_bed_at to sleep_records.
MIN_VALID_WALL_CLOCK_TS = 1577836800.0  # 2020-01-01 00:00:00 UTC

# Pump gating for movement scoring (#230)
# Guard period after pump-off: 3 seconds = ~6 samples at 2 Hz capSense rate
PUMP_GUARD_S = 3.0
# Reference channel anomaly threshold (capSense2 units)
REF_ANOMALY_THRESHOLD = 0.02
# Baseline subtraction: trailing epoch window and cold start
BASELINE_TRAILING_EPOCHS = 30
BASELINE_COLD_START_EPOCHS = 10  # ~10 minutes at 60s epochs
# Percentile for baseline (5th percentile)
BASELINE_PERCENTILE = 5
# Median filter window (epochs)
MEDIAN_FILTER_WINDOW = 3

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


def sanitize_ts(raw_ts) -> float:
    """Coerce a RAW frame's `ts` field into a sane wall-clock timestamp.

    Falls back to time.time() when:
      - the field is missing or not a number
      - the value is NaN or +/-inf (CBOR-encoded IEEE 754 specials)
      - the value is < 2020-01-01 epoch (firmware emitted a relative
        timestamp before establishing wall-clock — directly persisting
        this leads to entered_bed_at landing in 1970, observed once on
        2026-03-21 in row id=30 of sleep_records).
    """
    try:
        ts = float(raw_ts) if raw_ts is not None else time.time()
    except (TypeError, ValueError):
        return time.time()
    if not math.isfinite(ts):
        return time.time()
    if ts < MIN_VALID_WALL_CLOCK_TS:
        return time.time()
    return ts


# After this many consecutive write failures, discard the current biometrics
# connection and open a fresh one on the next write (#325).
_DB_RECONNECT_THRESHOLD = 5
_db_write_failures = 0


class DBHolder:
    """Shared mutable reference to the biometrics connection.

    Both SessionTracker instances point at the same DBHolder so that when
    one tracker triggers a reconnect, the other automatically observes the
    new connection on its next write. Holding raw sqlite3.Connection refs
    on each tracker would orphan one of them after a reconnect (the closed
    handle would still be in use).
    """
    __slots__ = ("conn",)

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn


def _reconnect_db(holder: "DBHolder") -> None:
    """Open a fresh connection, swap into *holder*, then close the old one.
    Open-first-then-swap means an open failure leaves the live handle in
    place; the close happens after the swap so concurrent writers always
    see a valid handle. Never raises."""
    old = holder.conn
    try:
        new = open_biometrics_db()
    except sqlite3.Error as e:
        log.error("Failed to reopen biometrics DB: %s", e)
        return
    holder.conn = new
    log.info("Reopened biometrics DB connection after write failures")
    try:
        old.close()
    except sqlite3.Error:
        pass


def write_sleep_record(holder: "DBHolder", side: str,
                       entered: datetime, left: datetime,
                       duration_s: int, exits: int,
                       present_intervals: list, absent_intervals: list) -> bool:
    """Insert one sleep_records row. Logs and swallows sqlite3 errors so the
    main loop survives transient WAL/disk issues. After _DB_RECONNECT_THRESHOLD
    consecutive failures, the holder's connection is replaced (#325).

    Returns True iff the row committed; callers should only finalize
    in-memory session state on True so a transient failure can retry.
    """
    global _db_write_failures
    conn = holder.conn
    try:
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
        _db_write_failures = 0
        return True
    except sqlite3.Error as e:
        _db_write_failures += 1
        log.warning("write_sleep_record failed (%d consecutive): %s",
                    _db_write_failures, e)
        if _db_write_failures >= _DB_RECONNECT_THRESHOLD:
            _db_write_failures = 0
            _reconnect_db(holder)
        return False


def write_movement(holder: "DBHolder", side: str,
                   ts: datetime, total_movement: int) -> bool:
    """Insert one movement row. See write_sleep_record for error semantics (#325).
    Returns True iff the row committed."""
    global _db_write_failures
    conn = holder.conn
    try:
        with conn:
            conn.execute(
                "INSERT INTO movement (side, timestamp, total_movement) VALUES (?, ?, ?)",
                (side, int(ts.timestamp()), total_movement),
            )
        _db_write_failures = 0
        return True
    except sqlite3.Error as e:
        _db_write_failures += 1
        log.warning("write_movement failed (%d consecutive): %s",
                    _db_write_failures, e)
        if _db_write_failures >= _DB_RECONNECT_THRESHOLD:
            _db_write_failures = 0
            _reconnect_db(holder)
        return False


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
# Numeric helpers (no numpy dependency)
# ---------------------------------------------------------------------------

def _percentile(values: List[int], pct: int) -> int:
    """Compute the pct-th percentile of a list of integers (nearest rank)."""
    if not values:
        return 0
    s = sorted(values)
    # Nearest-rank method: ceil(pct/100 * N) - 1, clamped to [0, N-1]
    idx = max(0, min(len(s) - 1, int((pct / 100.0) * len(s) + 0.5) - 1))
    return s[idx]


def _median(values: List[int]) -> int:
    """Compute the median of a list of integers."""
    if not values:
        return 0
    s = sorted(values)
    n = len(s)
    if n % 2 == 1:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) // 2


# ---------------------------------------------------------------------------
# Pump artifact gating for capSense2 movement scoring (#230)
# ---------------------------------------------------------------------------

def _extract_ref_delta(record: dict, side: str,
                       baselines: Optional[dict] = None) -> Optional[float]:
    """Extract reference channel delta from nominal for a capSense2 record.

    Returns the deviation of the averaged reference pair from the calibrated
    reference mean (or 1.16 fallback), or None if the record is not capSense2
    or reference channels are unavailable.
    """
    if record.get("type") != "capSense2":
        return None
    data = record.get(side, {})
    if not data:
        return None
    vals = data.get("values")
    if not vals or len(vals) < 8:
        return None
    if vals[6] == CAPSENSE2_SENTINEL or vals[7] == CAPSENSE2_SENTINEL:
        return None
    ref_avg = (vals[6] + vals[7]) / 2.0
    ref_nominal = 1.16
    if baselines and baselines.get("ref"):
        ref_nominal = baselines["ref"].get("mean", 1.16)
    return ref_avg - ref_nominal


class PumpGateCapSense:
    """Three-signal pump artifact gate for capSense2 movement scoring.

    Detects pump activity via:
      1. Primary: frzHealth pump RPM > 0 on either side
      2. Secondary: reference channel anomaly with correlated active channels
      3. Guard period: 3 seconds trailing after pump-off

    When gate is active, movement delta should be forced to 0.

    The sleep-detector main loop feeds frzHealth/frzTherm records into
    update_pump_state(), and capSense2 records are checked via is_gated().
    """

    def __init__(self):
        # Per-side pump RPM state from frzHealth records
        self._pump_rpm: Dict[str, float] = {"left": 0.0, "right": 0.0}
        # Timestamp (monotonic) when pump last turned off — for guard period
        self._pump_off_at: float = 0.0
        # Whether pump was active on previous check (for detecting pump-off transition)
        self._was_pump_active: bool = False
        # Reference channel anomaly state
        self._ref_anomaly_active: bool = False

    def update_pump_state(self, record: dict) -> None:
        """Update pump RPM state from a frzHealth or frzTherm record.

        frzHealth format: { type: "frzHealth", ts, left: {..., pumpRpm: N}, right: {..., pumpRpm: N}, fan: {...} }
        frzTherm format:  { type: "frzTherm", ts, left: {..., pumpDuty: N}, right: {..., pumpDuty: N} }

        The exact field names depend on firmware version. We check multiple
        possible field names for robustness.
        """
        rtype = record.get("type", "")

        for side in ("left", "right"):
            side_data = record.get(side)
            if not isinstance(side_data, dict):
                continue

            rpm = 0.0
            if rtype == "frzHealth":
                # Try known field names for pump RPM
                for key in ("pumpRpm", "pump_rpm", "pumpRPM", "rpm"):
                    val = side_data.get(key)
                    if val is not None:
                        try:
                            rpm = float(val)
                        except (TypeError, ValueError):
                            pass
                        break
                # Also check pumpDuty as fallback — any duty > 0 means pump is running
                if rpm == 0:
                    for key in ("pumpDuty", "pump_duty", "duty"):
                        val = side_data.get(key)
                        if val is not None:
                            try:
                                rpm = 1.0 if float(val) > 0 else 0.0
                            except (TypeError, ValueError):
                                pass
                            break

            elif rtype == "frzTherm":
                # frzTherm may carry pump duty cycle
                for key in ("pumpDuty", "pump_duty", "duty", "pumpRpm", "pump_rpm"):
                    val = side_data.get(key)
                    if val is not None:
                        try:
                            rpm = 1.0 if float(val) > 0 else 0.0
                        except (TypeError, ValueError):
                            pass
                        break

            self._pump_rpm[side] = rpm

        # Track pump-off transitions for guard period
        pump_active = self._pump_rpm["left"] > 0 or self._pump_rpm["right"] > 0
        if self._was_pump_active and not pump_active:
            # Pump just turned off — start guard period
            self._pump_off_at = time.monotonic()
        self._was_pump_active = pump_active

    def is_gated(self, record: dict, side: str,
                 channel_deltas: Optional[List[float]] = None,
                 baselines: Optional[dict] = None) -> bool:
        """Check if movement delta should be gated (forced to 0).

        Args:
            record: The capSense2/capSense record being processed.
            side: "left" or "right".
            channel_deltas: Per-channel absolute deltas [|dA|, |dB|, |dC|],
                if available. Used for reference channel anomaly correlation.
            baselines: Calibration baselines for this side, used for
                calibrated reference nominal in anomaly detection.

        Returns True if the delta should be suppressed.
        """
        # Signal 1: frzHealth pump RPM
        if self._pump_rpm["left"] > 0 or self._pump_rpm["right"] > 0:
            return True

        # Signal 3: Guard period (checked before ref anomaly since it's cheap)
        if time.monotonic() - self._pump_off_at < PUMP_GUARD_S:
            return True

        # Signal 2: Reference channel anomaly (capSense2 only)
        ref_delta = _extract_ref_delta(record, side, baselines)
        if ref_delta is not None and abs(ref_delta) > REF_ANOMALY_THRESHOLD:
            # Reference channel shifted — check if active channels correlate
            # (both spiking together = mechanical coupling from pump, not body movement)
            if channel_deltas is not None and len(channel_deltas) >= 3:
                # If all active channel deltas are elevated (> 2x the ref anomaly),
                # it's likely mechanical coupling
                ref_mag = abs(ref_delta)
                correlated = sum(1 for d in channel_deltas if d > ref_mag * 0.5)
                if correlated >= 2:
                    log.debug("Ref anomaly gate: ref_delta=%.4f, correlated=%d/3",
                              ref_delta, correlated)
                    return True

        return False


# ---------------------------------------------------------------------------
# Per-side session tracker
# ---------------------------------------------------------------------------

@dataclass
class SessionTracker:
    side: str
    db: "DBHolder"
    calibration: CalibrationCache
    pump_gate: PumpGateCapSense
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
    # Epoch score history for baseline subtraction and median filter
    _epoch_scores: deque = field(default_factory=lambda: deque(maxlen=BASELINE_TRAILING_EPOCHS))
    _median_buf: deque = field(default_factory=lambda: deque(maxlen=MEDIAN_FILTER_WINDOW))
    _pump_gated_samples: int = 0  # counter for logging

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
            # Compute per-channel deltas for pump gate ref anomaly correlation
            if self._prev_values is not None:
                channel_deltas = [abs(c - p) for c, p in zip(current_values, self._prev_values)]
            else:
                channel_deltas = None
            self._prev_values = current_values

            # Pump gate: suppress delta if pump is active or in guard period (#230)
            if self.pump_gate.is_gated(record, self.side, channel_deltas, baselines):
                delta = 0.0
                self._pump_gated_samples += 1
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

        wrote = False
        if duration_s < MIN_SESSION_S:
            log.info("%s: session too short (%ds), discarding", self.side, duration_s)
            wrote = True  # treat discard as final — nothing to retry
        else:
            # Close any open interval
            if self._interval_start is not None:
                if self._was_present:
                    self._present_intervals.append([self._interval_start, left_ts])
                elif left_ts > self._interval_start:
                    self._absent_intervals.append([self._interval_start, left_ts])

            wrote = write_sleep_record(
                self.db, self.side,
                self._session_start, left_at,
                duration_s, self._exit_count,
                self._present_intervals, self._absent_intervals,
            )
            if wrote:
                log.info("%s: session recorded — %.1f hr, %d exits",
                         self.side, duration_s / 3600, self._exit_count)
            else:
                log.warning("%s: session write deferred (DB error)", self.side)

        # Only reset session state when the row committed (or was deliberately
        # discarded). Otherwise leave it in place so a follow-up call can retry
        # rather than silently losing the entire session.
        if not wrote:
            return

        self._session_start = None
        self._last_present_ts = None
        self._present_intervals = []
        self._absent_intervals = []
        self._interval_start = None
        self._was_present = False
        self._exit_count = 0
        self._prev_values = None  # avoid stale delta on next session start
        self._movement_buf = []   # discard leftover deltas from session end
        self._epoch_scores.clear()
        self._median_buf.clear()
        self._pump_gated_samples = 0

    def _flush_movement(self, ts: float) -> None:
        if ts - self._last_movement_write < MOVEMENT_INTERVAL_S:
            return
        if not self._movement_buf or self._session_start is None:
            # Only write movement during active sessions (O-2 fix)
            self._movement_buf = []
            self._pump_gated_samples = 0
            self._last_movement_write = ts
            return

        # Log pump gating stats periodically
        if self._pump_gated_samples > 0:
            log.debug("%s: pump-gated %d samples this epoch",
                      self.side, self._pump_gated_samples)
            self._pump_gated_samples = 0

        # Step 1: Sum of absolute deltas over the epoch (PIM analog)
        # Scale factor depends on sensor type:
        #   capSense2 (Pod 5): float channels, deltas ~0.05-5.0 → ×10
        #   capSense  (Pod 3): int ADC channels, deltas ~1-50 → ×0.5
        raw_sum = sum(self._movement_buf)
        raw_score = min(1000, int(raw_sum * self._scale_factor))

        # Step 2: Baseline subtraction — remove 5th percentile of trailing epochs
        # This eliminates slow-building artifacts (pump vibration residual, thermal drift)
        self._epoch_scores.append(raw_score)
        if len(self._epoch_scores) > BASELINE_COLD_START_EPOCHS:
            baseline = _percentile(list(self._epoch_scores), BASELINE_PERCENTILE)
            score_after_baseline = max(0, raw_score - baseline)
        else:
            # Cold start: not enough history yet, skip baseline subtraction
            score_after_baseline = raw_score

        # Step 3: 3-epoch median filter for smoothing
        self._median_buf.append(score_after_baseline)
        if len(self._median_buf) >= MEDIAN_FILTER_WINDOW:
            filtered_score = _median(list(self._median_buf))
        else:
            # Not enough epochs yet for median filter, pass through
            filtered_score = score_after_baseline

        # Step 4: Final clamp to [0, 1000]
        total = max(0, min(1000, filtered_score))

        wrote = write_movement(self.db, self.side,
                               datetime.fromtimestamp(ts, tz=timezone.utc), total)
        # Only clear the buffer + advance the cursor on a successful commit so
        # a transient failure can retry on the next flush rather than dropping
        # an epoch's worth of movement data.
        if wrote:
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

    db_holder = DBHolder(open_biometrics_db())
    cal_store = CalibrationStore(BIOMETRICS_DB)
    cal_cache = CalibrationCache(cal_store)
    pump_gate = PumpGateCapSense()

    # Both trackers share the same DBHolder so a reconnect triggered on one
    # side is observed by the other on its next write (no orphaned handles).
    left = SessionTracker(side="left", db=db_holder, calibration=cal_cache, pump_gate=pump_gate)
    right = SessionTracker(side="right", db=db_holder, calibration=cal_cache, pump_gate=pump_gate)
    follower = RawFileFollower(RAW_DATA_DIR, _shutdown, poll_interval=0.5)

    report_health("healthy", "sleep-detector started")
    log.info("Calibration profiles will be loaded from biometrics.db (reload every %ds)", CALIBRATION_RELOAD_S)
    log.info("Pump artifact gating enabled (guard=%.0fs, ref_threshold=%.3f)",
             PUMP_GUARD_S, REF_ANOMALY_THRESHOLD)

    # Record types we process: capSense for presence/movement, frzHealth/frzTherm for pump state
    CAPSENSE_TYPES = ("capSense", "capSense2")
    PUMP_STATE_TYPES = ("frzHealth", "frzTherm")

    try:
        for record in follower.read_records():
            rtype = record.get("type")

            # Update pump state from freezer health/thermal records
            if rtype in PUMP_STATE_TYPES:
                pump_gate.update_pump_state(record)
                continue

            if rtype not in CAPSENSE_TYPES:
                continue

            ts = sanitize_ts(record.get("ts"))
            left.process(ts, record)
            right.process(ts, record)

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        cal_store.close()
        db_holder.conn.close()
        log.info("Shutdown complete")

    # Only reached on clean shutdown (not via sys.exit)
    report_health("down", "sleep-detector stopped")


if __name__ == "__main__":
    main()
