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
  Presence is the summed signed raw-unit rise above a self-adjusting
  per-channel empty-bed baseline (a body only adds capacitance) — see
  AdaptiveBaseline. Scheduled calibration no longer sets it.
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
from common.nats_follower import create_follower
from common.side_mode import SingleSleeperMode
from common.dialect import (
    KNOWN_RECORD_TYPES,
    log_capsense_status_once,
    warn_unknown_type_once,
)
from common.calibration import (
    CAPSENSE_PRESENCE_THRESHOLD,
    CalibrationStore,
    capsense_channel_values,
    capsense_threshold,
    capsense2_channel_values,
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
# Presence debounce / hysteresis: a present<->absent flip is only committed
# after the new raw state has persisted for this many seconds. Without it,
# brief capSense dropouts (sub-second flaps at 2 Hz while the occupant is
# genuinely in bed) each split the session and bump times_exited_bed, yielding
# dozens of <15min fragments with 66-109 bogus exits overnight (pod 88 field
# debug 2026-06-10). Must be < ABSENCE_TIMEOUT_S so debounced absence still
# closes the session on a real bed-exit.
PRESENCE_DEBOUNCE_S = 30.0
# Hard upper bound on a single session. Belt-and-suspenders against a session
# that never closes (e.g. presence flapping that historically kept resetting
# the absence timer, producing 2736/2850min runaway durations). A continuous
# presence span beyond this is force-closed at the cap rather than persisted as
# a multi-day sleep_record.
MAX_SESSION_S = 16 * 3600
# How often to write a movement row (seconds)
MOVEMENT_INTERVAL_S = 60
# How often to reload calibration profiles (seconds)
CALIBRATION_RELOAD_S = 60
# Self-adjusting empty-bed baseline (replaces scheduled capacitance
# calibration, which could capture a motionless sleeper as "empty").
# Presence enters above the threshold and exits below this fraction of it,
# so a reading hovering at the threshold can't flap.
PRESENCE_EXIT_FRACTION = 0.5
# While empty and within the exit threshold, the baseline follows slow drift
# (thermal, bedding) with this time constant (seconds).
BASELINE_UP_TAU_S = 30 * 60
# A reading BELOW baseline is always an empty bed (a body only adds
# capacitance), so a baseline captured with someone in bed drops to the true
# empty level within minutes of them getting up.
BASELINE_DOWN_TAU_S = 120
# Samples further apart than this don't count as tracking time (gaps,
# restarts), so one sample can't move the baseline all the way.
BASELINE_MAX_STEP_S = 10.0
# How often the baseline is written back to calibration_profiles so the app
# and Node's occupancy check (capSense2) see the same empty-bed level.
BASELINE_PUBLISH_S = 15 * 60
# capSense2 profile threshold default (raw float units), as the calibrator.
CAPSENSE2_PRESENCE_THRESHOLD = 6.0
# In-progress session state survives restarts/reboots via this file. Without
# it a reboot or service restart mid-session silently dropped the whole night.
STATE_PATH = Path(os.environ.get(
    "SLEEP_DETECTOR_STATE_PATH", str(BIOMETRICS_DB.parent / "sleep-detector-state.json")))
STATE_VERSION = 1
# How often to checkpoint an open session (seconds). Session start/close and
# bed-exits checkpoint immediately.
STATE_SAVE_INTERVAL_S = 60
# A restored session whose last sample is older than this is closed at the
# last presence instead of resumed — the downtime can't be attributed to sleep.
STATE_MAX_GAP_S = 30 * 60
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


def load_state(path: Path) -> dict:
    """Read the persisted per-side tracker state; {} when missing or unusable."""
    try:
        state = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        log.warning("Ignoring unreadable state file %s: %s", path, e)
        return {}
    if not isinstance(state, dict) or state.get("version") != STATE_VERSION:
        log.warning("Ignoring state file %s with unexpected shape/version", path)
        return {}
    return state


def save_state(path: Path, trackers) -> bool:
    """Atomically write every tracker's state. Returns True on success.

    tmp + fsync + rename so a power cut leaves either the previous or the new
    file, never a truncated one."""
    state = {"version": STATE_VERSION}
    for t in trackers:
        state[t.side] = t.snapshot()
    tmp = path.with_name(path.name + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        return True
    except OSError as e:
        log.warning("Could not save state to %s: %s", path, e)
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
    """Periodically reloads capacitance calibration profiles for both sides,
    and writes the self-adjusting baseline back to them."""

    def __init__(self, store: CalibrationStore):
        self._store = store
        # side -> (params, created_at) of the active completed profile
        self._profiles: Dict[str, Optional[tuple]] = {"left": None, "right": None}
        self._last_reload = 0.0

    def get_profile(self, side: str, force: bool = False) -> Optional[tuple]:
        """(params, created_at) of the active capacitance profile, or None."""
        self._maybe_reload(force)
        return self._profiles.get(side)

    def publish(self, side: str, params: dict, window_start: int,
                window_end: int, samples: int) -> bool:
        """Upsert the adaptive baseline as the side's capacitance profile."""
        try:
            self._store.upsert_profile(side, "capacitance", params, 1.0,
                                       window_start, window_end, samples)
            return True
        except Exception as e:
            log.warning("Failed to publish %s baseline: %s", side, e)
            return False

    def _maybe_reload(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_reload < CALIBRATION_RELOAD_S:
            return
        self._last_reload = now
        for side in ("left", "right"):
            try:
                profile = self._store.get_active(side, "capacitance")
                if profile:
                    params = profile["parameters"]
                    params = json.loads(params) if isinstance(params, str) else params
                    self._profiles[side] = (params, profile.get("created_at"))
                else:
                    self._profiles[side] = None
            except Exception as e:
                log.warning("Failed to load calibration for %s: %s", side, e)


class AdaptiveBaseline:
    """Self-adjusting empty-bed level for one side's capacitance channels.

    Replaces scheduled capacitance calibration: a fixed snapshot went stale
    with drift, and a snapshot taken while someone slept (the fixed-UTC-hour
    fallback can land mid-night) made the empty bed read occupied all day.

    - Presence: summed signed rise over the baseline. Enters above
      `threshold`, exits below threshold * PRESENCE_EXIT_FRACTION.
    - Drift: while empty and within the exit threshold, follows the reading
      with time constant BASELINE_UP_TAU_S.
    - Contamination: any reading below baseline pulls it down with
      BASELINE_DOWN_TAU_S — a body only adds capacitance.
    - Seeding: saved state, else the calibration profile (including a manual
      recalibration, adopted whenever a newer one appears), else the first
      sample.

    capSense tracks raw {out, cen, in}; capSense2 tracks ref-compensated
    pair averages {A, B, C} against a fixed ref_mean.
    """

    def __init__(self, fmt: str, means: dict, threshold: float,
                 ref_mean: Optional[float] = None, source: str = "bootstrap",
                 profile_seen_at: Optional[float] = None):
        self.fmt = fmt
        self.means = {ch: float(v) for ch, v in means.items()}
        self.threshold = float(threshold)
        self.ref_mean = ref_mean
        self.source = source
        # created_at of the newest external profile already adopted or
        # deliberately skipped, so it isn't re-adopted every reload.
        self.profile_seen_at = profile_seen_at
        self._last_track_ts: Optional[float] = None

    @property
    def exit_threshold(self) -> float:
        return self.threshold * PRESENCE_EXIT_FRACTION

    @classmethod
    def from_profile(cls, params: dict, fmt: str, created_at: Optional[float]):
        """Seed from a calibration profile, or None if it doesn't match fmt."""
        channels = params.get("channels") or {}
        if fmt == "capSense2":
            if params.get("format") != "capSense2":
                return None
            names = ("A", "B", "C")
            threshold = float(params.get("threshold", CAPSENSE2_PRESENCE_THRESHOLD))
            ref_mean = (params.get("ref") or {}).get("mean")
        else:
            if params.get("format") == "capSense2":
                return None
            names = ("out", "cen", "in")
            threshold = capsense_threshold(params)
            ref_mean = None
        try:
            means = {ch: float(channels[ch]["mean"]) for ch in names}
        except (KeyError, TypeError, ValueError):
            return None
        return cls(fmt, means, threshold, ref_mean=ref_mean,
                   source=params.get("source", "profile"),
                   profile_seen_at=created_at)

    @classmethod
    def from_state(cls, state: Optional[dict]):
        if not isinstance(state, dict):
            return None
        try:
            return cls(str(state["format"]), dict(state["means"]), float(state["threshold"]),
                       ref_mean=state.get("ref_mean"), source="state",
                       profile_seen_at=state.get("profile_seen_at"))
        except (KeyError, TypeError, ValueError):
            return None

    def snapshot(self) -> dict:
        return {"format": self.fmt, "means": self.means, "threshold": self.threshold,
                "ref_mean": self.ref_mean, "profile_seen_at": self.profile_seen_at}

    def values(self, record: dict, side: str) -> Optional[dict]:
        """This format's per-channel values for a frame, or None if unusable."""
        if self.fmt == "capSense2":
            return capsense2_channel_values(record, side, self.ref_mean, skip_sentinels=True)
        return capsense_channel_values(record, side)

    def deviation(self, values: dict) -> float:
        return sum(v - self.means[ch] for ch, v in values.items())

    def is_present(self, values: dict, currently_present: bool) -> bool:
        limit = self.exit_threshold if currently_present else self.threshold
        return self.deviation(values) > limit

    def track(self, ts: float, values: dict, occupied: bool) -> None:
        """Follow the empty-bed level. Called once per sample after the
        presence decision; `occupied` is the committed (debounced) state."""
        dt = 0.0 if self._last_track_ts is None else ts - self._last_track_ts
        self._last_track_ts = ts
        dt = max(0.0, min(dt, BASELINE_MAX_STEP_S))
        if dt == 0.0:
            return
        dev = self.deviation(values)
        if dev < 0:
            tau = BASELINE_DOWN_TAU_S
        elif not occupied and dev < self.exit_threshold:
            tau = BASELINE_UP_TAU_S
        else:
            return
        alpha = dt / tau
        for ch, v in values.items():
            self.means[ch] += alpha * (v - self.means[ch])

    def reseed(self, values: dict, source: str) -> None:
        self.means = {ch: float(v) for ch, v in values.items()}
        self.source = source

    def to_params(self) -> dict:
        """Calibration-profile params (the shape the calibrators write)."""
        if self.fmt == "capSense2":
            params = {"format": "capSense2", "threshold": self.threshold,
                      "channels": {ch: {"mean": round(m, 4), "std": 0.05}
                                   for ch, m in self.means.items()}}
            if self.ref_mean is not None:
                params["ref"] = {"mean": round(self.ref_mean, 4), "std": 0.001}
        else:
            params = {"format": "capSense", "threshold": self.threshold,
                      "channels": {ch: {"mean": round(m, 2), "std": 5.0}
                                   for ch, m in self.means.items()}}
        params["source"] = "adaptive"
        return params


def bootstrap_baseline(record: dict, side: str) -> Optional[AdaptiveBaseline]:
    """Seed a baseline from one frame when no state or profile exists. If the
    bed happens to be occupied, the occupant reads absent until they get up;
    the reading then falls below baseline and the fast downward track takes
    it to the true empty level."""
    fmt = record.get("type")
    if fmt == "capSense2":
        data = record.get(side, {})
        vals = data.get("values") if data else None
        ref_mean = None
        if vals and len(vals) >= 8 and CAPSENSE2_SENTINEL not in (vals[6], vals[7]):
            ref_mean = (vals[6] + vals[7]) / 2.0
        values = capsense2_channel_values(record, side, ref_mean, skip_sentinels=True)
        threshold = CAPSENSE2_PRESENCE_THRESHOLD
    else:
        ref_mean = None
        values = capsense_channel_values(record, side)
        threshold = CAPSENSE_PRESENCE_THRESHOLD
    if values is None:
        return None
    return AdaptiveBaseline(fmt, values, threshold, ref_mean=ref_mean, source="bootstrap")

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
        # Per-side timestamp (monotonic) when that pump last turned off —
        # for the guard period. Per-side because gating both beds on either
        # pump under-counted the movement table during long pump runtimes;
        # cross-side mechanical coupling is what Signal 2 (correlated
        # ref-anomaly) exists to catch. -inf = never turned off (0.0 would
        # falsely gate the first PUMP_GUARD_S after process start, since
        # time.monotonic() has an arbitrary, possibly near-zero origin).
        self._pump_off_at: Dict[str, float] = {"left": float("-inf"), "right": float("-inf")}
        # Whether each pump was active on previous check (for detecting pump-off transition)
        self._was_pump_active: Dict[str, bool] = {"left": False, "right": False}
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
                # NATS Pod 5 frzHealth nests pump state under side.pump.
                pump = side_data.get("pump")
                if rpm == 0 and isinstance(pump, dict):
                    val = pump.get("rpm")
                    if val is not None:
                        try:
                            rpm = float(val)
                        except (TypeError, ValueError):
                            pass
                # Also check pumpDuty as fallback — any duty > 0 means pump is running
                if rpm == 0:
                    duty = next((side_data.get(key) for key in
                                 ("pumpDuty", "pump_duty", "duty")
                                 if side_data.get(key) is not None), None)
                    if duty is None and isinstance(pump, dict):
                        duty = next((pump.get(key) for key in ("duty", "power")
                                     if pump.get(key) is not None), None)
                    if duty is not None:
                        try:
                            rpm = 1.0 if float(duty) > 0 else 0.0
                        except (TypeError, ValueError):
                            pass

            elif rtype == "frzTherm":
                # frzTherm may carry pump duty cycle
                for key in ("pumpDuty", "pump_duty", "duty", "pumpRpm",
                            "pump_rpm", "power"):
                    val = side_data.get(key)
                    if val is not None:
                        try:
                            rpm = 1.0 if float(val) > 0 else 0.0
                        except (TypeError, ValueError):
                            pass
                        break

            self._pump_rpm[side] = rpm

        # Track per-side pump-off transitions for the guard period
        for side in ("left", "right"):
            pump_active = self._pump_rpm[side] > 0
            if self._was_pump_active[side] and not pump_active:
                # This side's pump just turned off — start its guard period
                self._pump_off_at[side] = time.monotonic()
            self._was_pump_active[side] = pump_active

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
        # Signal 1: frzHealth pump RPM — this side's pump only. Gating both
        # sides on either pump zeroed real movement on the idle side for the
        # whole pump runtime; the other pump's mechanical coupling (if any)
        # is caught by the correlated ref-anomaly check below.
        if self._pump_rpm.get(side, 0.0) > 0:
            return True

        # Signal 3: Guard period (checked before ref anomaly since it's cheap)
        if time.monotonic() - self._pump_off_at.get(side, float("-inf")) < PUMP_GUARD_S:
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
class SideObservation:
    """One side's reading of one frame (SessionTracker.observe)."""
    ts: float
    present: Optional[bool]  # None: unusable frame, no new evidence
    delta: float
    values: Optional[dict]
    record: dict


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
    # Debounced (committed) presence state and the ts at which it began.
    # Distinct from the raw per-sample `present`: only flips after a candidate
    # state survives PRESENCE_DEBOUNCE_S (see _apply_debounce).
    _debounced_present: bool = False
    _state_since: Optional[float] = None
    _pending_state: Optional[bool] = None
    _pending_since: Optional[float] = None
    _movement_buf: list = field(default_factory=list)
    _last_movement_write: float = field(default_factory=time.time)
    _prev_values: Optional[list] = None  # previous sample's channel values
    _scale_factor: float = 10.0  # default for capSense2; updated on first record
    # Epoch score history for baseline subtraction and median filter
    _epoch_scores: deque = field(default_factory=lambda: deque(maxlen=BASELINE_TRAILING_EPOCHS))
    _median_buf: deque = field(default_factory=lambda: deque(maxlen=MEDIAN_FILTER_WINDOW))
    _pump_gated_samples: int = 0  # counter for logging
    # Sessions closed only by the MAX_SESSION_S cap since the last natural
    # (absence-timeout) close. Two in a row means the presence signal never
    # dropped for 32+ hours — a stuck level signal, not a sleeper.
    _consecutive_cap_closes: int = 0
    # ts of the latest processed sample, persisted so a restore can tell how
    # long the detector was down.
    _last_ts: Optional[float] = None
    # Set by restore() when the occupant was present at shutdown; cleared by
    # the first present sample afterwards. If absence is committed first, the
    # occupant left during the downtime, so the exit is dated at the last
    # pre-restart presence instead of the first post-restart sample.
    _resumed_last_present: Optional[float] = None
    # The RAW follower re-reads the current file from offset 0 on startup, so
    # up to ~15 min of already-processed samples replay after a restore;
    # samples at or before this ts are skipped.
    _replay_until_ts: Optional[float] = None
    # Session start/close or a bed-exit happened since the last checkpoint.
    state_dirty: bool = False
    # Self-adjusting empty-bed level (see AdaptiveBaseline).
    baseline: Optional[AdaptiveBaseline] = None
    _cap_closed: bool = False
    # Per-sample level decision (with hysteresis), independent of sessions —
    # kept current even while this side's readings are merged into the other.
    _level_present: bool = False
    _last_publish_ts: Optional[float] = None
    _tracked_samples: int = 0

    def snapshot(self) -> dict:
        """JSON-serializable state needed to resume after a restart."""
        return {
            "session_start": self._session_start.timestamp() if self._session_start else None,
            "last_present_ts": self._last_present_ts,
            "present_intervals": self._present_intervals,
            "absent_intervals": self._absent_intervals,
            "interval_start": self._interval_start,
            "was_present": self._was_present,
            "exit_count": self._exit_count,
            "debounced_present": self._debounced_present,
            "state_since": self._state_since,
            "consecutive_cap_closes": self._consecutive_cap_closes,
            "last_ts": self._last_ts,
            "level_present": self._level_present,
            "baseline": self.baseline.snapshot() if self.baseline is not None else None,
        }

    def restore(self, state: Optional[dict], now: float) -> None:
        """Resume an in-progress session saved by snapshot().

        A session whose last sample is older than STATE_MAX_GAP_S is closed at
        the last presence rather than resumed."""
        if not isinstance(state, dict):
            return
        self.baseline = AdaptiveBaseline.from_state(state.get("baseline"))
        try:
            self._consecutive_cap_closes = int(state.get("consecutive_cap_closes") or 0)
            # The replay watermark applies whether or not a session is open: a
            # sessionless side (the away side in single-sleeper mode) still
            # feeds sessions, and must not replay frames it already processed.
            last_ts = state.get("last_ts")
            self._last_ts = float(last_ts) if last_ts is not None else None
            self._replay_until_ts = self._last_ts
            # Hysteresis latch: a reading between the exit and enter
            # thresholds is occupied only if it already was — resetting it
            # on restart would close a session that is still going.
            self._level_present = bool(state.get("level_present"))
            start = state.get("session_start")
            if start is None:
                return
            self._session_start = datetime.fromtimestamp(float(start), tz=timezone.utc)
            self._last_present_ts = state.get("last_present_ts")
            self._present_intervals = list(state.get("present_intervals") or [])
            self._absent_intervals = list(state.get("absent_intervals") or [])
            self._interval_start = state.get("interval_start")
            self._was_present = bool(state.get("was_present"))
            self._exit_count = int(state.get("exit_count") or 0)
            self._debounced_present = bool(state.get("debounced_present"))
            self._state_since = state.get("state_since")
        except (TypeError, ValueError, OverflowError, OSError) as e:
            log.warning("%s: ignoring corrupt saved session: %s", self.side, e)
            self._reset_session()
            return

        last_seen = self._last_ts or self._last_present_ts or float(start)
        if now - last_seen > STATE_MAX_GAP_S:
            log.info("%s: saved session stale (down %.0f min) — closing at last presence",
                     self.side, (now - last_seen) / 60)
            self._close_session(self._last_present_ts or last_seen)
            return

        if self._debounced_present:
            self._resumed_last_present = self._last_present_ts
        log.info("%s: resumed session started at %s", self.side, self._session_start.isoformat())

    def _sync_baseline(self, record: dict) -> Optional[AdaptiveBaseline]:
        """The presence baseline for this frame's format. Adopts a calibration
        profile newer than any already seen (e.g. a manual recalibration).
        With no baseline at all (state file missing), this detector's own
        published baseline is a better seed than the first frame, which may
        be occupied. Seeds from the first frame only when nothing else exists."""
        fmt = "capSense2" if record.get("type") == "capSense2" else "capSense"
        b = self.baseline if self.baseline is not None and self.baseline.fmt == fmt else None
        profile = self.calibration.get_profile(self.side) if self.calibration else None
        if profile is not None:
            params, created_at = profile
            own = isinstance(params, dict) and params.get("source") == "adaptive"
            if isinstance(params, dict) and (not own or b is None):
                seen = b.profile_seen_at if b is not None else None
                if seen is None or (created_at or 0) > seen:
                    adopted = AdaptiveBaseline.from_profile(params, fmt, created_at)
                    if adopted is not None:
                        log.info("%s: presence baseline from calibration profile (created %s)",
                                 self.side, created_at)
                        b = adopted
                    elif b is not None:
                        b.profile_seen_at = created_at  # wrong format — stop re-checking
        if b is None:
            b = bootstrap_baseline(record, self.side)
            if b is not None:
                log.info("%s: presence baseline seeded from live %s reading", self.side, fmt)
        self.baseline = b
        return b

    def _maybe_publish_baseline(self, ts: float, record: dict) -> None:
        if self._last_publish_ts is None:
            self._last_publish_ts = ts
            return
        if ts - self._last_publish_ts < BASELINE_PUBLISH_S or self.calibration is None:
            return
        self._last_publish_ts = ts
        # Re-read first: a manual calibration that finished since the last
        # reload must be adopted, not overwritten.
        self.calibration.get_profile(self.side, force=True)
        b = self._sync_baseline(record)
        if b is not None and self.calibration.publish(
                self.side, b.to_params(), int(ts - BASELINE_PUBLISH_S), int(ts),
                self._tracked_samples):
            self._tracked_samples = 0

    def observe(self, ts: float, record: dict) -> Optional["SideObservation"]:
        """Read one frame for this side: presence evidence, movement delta and
        the channel values the baseline tracks. None for a replayed frame.
        Does not touch the session — see commit()."""
        if self._replay_until_ts is not None:
            if ts <= self._replay_until_ts:
                return None  # already processed before the restart
            self._replay_until_ts = None
        self._last_ts = ts
        rtype = record.get("type", "")
        baseline = self._sync_baseline(record)
        values = baseline.values(record, self.side) if baseline is not None else None
        present: Optional[bool] = None  # unusable frame: no new evidence
        if values is not None:
            present = baseline.is_present(values, self._level_present)
            self._level_present = present
        # Movement's capSense2 common-mode rejection uses the baseline's ref.
        baselines = ({"ref": {"mean": baseline.ref_mean}}
                     if baseline is not None and baseline.ref_mean is not None else None)

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
        return SideObservation(ts, present, delta, values, record)

    def commit(self, ts: float, present: Optional[bool], delta: float) -> bool:
        """Advance the session with one sample's presence and movement.
        Returns True if the session was just force-closed at MAX_SESSION_S."""
        self._update(ts, self._debounced_present if present is None else present, delta)
        capped, self._cap_closed = self._cap_closed, False
        return capped

    def settle(self, obs: "SideObservation", reset: bool = False) -> None:
        """Baseline upkeep after the session step. `reset` makes the current
        level the new empty level: presence never dropped for MAX_SESSION_S,
        so the load on the bed isn't a sleeper."""
        if obs.values is None or self.baseline is None:
            return
        if reset:
            self.baseline.reseed(obs.values, "cap-reset")
            log.warning("%s: presence baseline reset to current level after a capped session",
                        self.side)
        else:
            self.baseline.track(obs.ts, obs.values, self._level_present)
        self._tracked_samples += 1
        self._maybe_publish_baseline(obs.ts, obs.record)

    def process(self, ts: float, record: dict) -> None:
        obs = self.observe(ts, record)
        if obs is None:
            return
        capped = self.commit(ts, obs.present, obs.delta)
        self.settle(obs, reset=capped)

    def _apply_debounce(self, ts: float, raw_present: bool) -> bool:
        """Fold the raw per-sample presence into the committed (debounced)
        state. A flip is only committed once the differing raw state has
        persisted for PRESENCE_DEBOUNCE_S; transient flaps are cancelled.

        On commit, _state_since is set to the ts at which the new state
        actually began (the first differing sample), so interval edges and
        the session entry time reflect the true transition, not commit time.

        Returns True iff the committed state flipped on this call.
        """
        if raw_present == self._debounced_present:
            # Raw agrees with the committed state — cancel any pending flip.
            self._pending_state = None
            self._pending_since = None
            return False

        if self._pending_state != raw_present:
            # New candidate differing from committed state — start its dwell.
            self._pending_state = raw_present
            self._pending_since = ts
            return False

        if (self._pending_since is not None
                and ts - self._pending_since >= PRESENCE_DEBOUNCE_S):
            self._debounced_present = raw_present
            self._state_since = self._pending_since
            self._pending_state = None
            self._pending_since = None
            return True

        return False

    def _update(self, ts: float, present: bool, movement: float) -> None:
        self._last_ts = ts
        self._movement_buf.append(movement)
        self._flush_movement(ts)

        if present:
            self._resumed_last_present = None

        # Debounce raw presence so brief capSense dropouts don't fragment the
        # session or inflate times_exited_bed (pod 88 field debug 2026-06-10).
        changed = self._apply_debounce(ts, present)
        # Timestamp of the true transition when one just committed, else `ts`.
        edge_ts = self._state_since if changed and self._state_since is not None else ts
        if changed and not self._debounced_present and self._resumed_last_present is not None:
            # Never seen present since the restart: they left during the downtime.
            edge_ts = self._resumed_last_present
            self._resumed_last_present = None

        if self._debounced_present:
            if self._session_start is None:
                # New session starts at the true entry time.
                self._session_start = datetime.fromtimestamp(edge_ts, tz=timezone.utc)
                self._interval_start = edge_ts
                self._was_present = True
                self.state_dirty = True
                log.info("%s: session started at %s", self.side, self._session_start.isoformat())

            elif changed and self._interval_start is not None:
                # Returning from absence — close absent interval, open present interval
                self._absent_intervals.append([self._interval_start, edge_ts])
                self._interval_start = edge_ts

            self._last_present_ts = ts
            self._was_present = True

        else:
            if changed and self._was_present and self._interval_start is not None:
                # Confirmed bed-exit — close present interval, open absent interval
                self._present_intervals.append([self._interval_start, edge_ts])
                self._interval_start = edge_ts
                self._exit_count += 1
                self.state_dirty = True

            self._was_present = False

            # Check if absence timeout has elapsed → close session
            if (self._session_start is not None
                    and self._last_present_ts is not None
                    and ts - self._last_present_ts >= ABSENCE_TIMEOUT_S):
                # Close at interval_start (first absent sample) when available to
                # avoid emitting absent intervals with end < start
                close_ts = self._interval_start if self._interval_start is not None else self._last_present_ts
                self._close_session(close_ts)
                if self._session_start is None:  # committed — a real exit was seen
                    self._consecutive_cap_closes = 0

        # Safety net: force-close a runaway session that never reaches the
        # absence timeout, capping sleep_duration_seconds at MAX_SESSION_S.
        # Only when still debounced-present — once absent, the absence-timeout
        # path above closes at the true exit edge, so the cap must not move
        # left_bed_at forward to the cap timestamp.
        if (self._session_start is not None
                and self._debounced_present
                and ts - self._session_start.timestamp() >= MAX_SESSION_S):
            self._close_session(self._session_start.timestamp() + MAX_SESSION_S)
            if self._session_start is None:  # committed — count it, don't spam retries
                self._consecutive_cap_closes += 1
                self._cap_closed = True
                log.warning(
                    "%s: session force-closed at the %dh cap — presence never dropped (%d consecutive)",
                    self.side, MAX_SESSION_S // 3600, self._consecutive_cap_closes)
                if self._consecutive_cap_closes >= 2:
                    log.warning(
                        "%s: presence looks stuck-occupied — %d back-to-back sessions closed only at "
                        "the cap; check capSense2 level deviation vs calibration baseline (/debug)",
                        self.side, self._consecutive_cap_closes)

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

        self._reset_session()
        self.state_dirty = True

    def _reset_session(self) -> None:
        self._session_start = None
        self._last_present_ts = None
        self._present_intervals = []
        self._absent_intervals = []
        self._interval_start = None
        self._was_present = False
        self._exit_count = 0
        self._debounced_present = False
        self._state_since = None
        self._pending_state = None
        self._pending_since = None
        self._prev_values = None  # avoid stale delta on next session start
        self._movement_buf = []   # discard leftover deltas from session end
        self._epoch_scores.clear()
        self._median_buf.clear()
        self._pump_gated_samples = 0
        self._resumed_last_present = None

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


def process_single_sleeper(home: SessionTracker, away: SessionTracker,
                           ts: float, record: dict) -> None:
    """One frame in single-sleeper mode (the other side is in away mode).

    The sleeper is in bed while EITHER side reads occupied — rolling over or
    a leg on the away side keeps one home-side session going instead of
    opening a phantom one there. Movement from both sides is summed into the
    home side's epochs. The away side keeps tracking its own baseline but
    never records a session.
    """
    h = home.observe(ts, record)
    a = away.observe(ts, record)
    if h is None:
        # The home session already covered this frame (restart replay);
        # the away side's reading of it must not re-enter the session.
        return
    if away._session_start is not None:
        # Away mode switched on mid-session: end that side's session where
        # its occupant was last seen; from now on its readings are merged.
        away._close_session(away._last_present_ts or ts)
    evidence = [o.present for o in (h, a) if o is not None and o.present is not None]
    present = any(evidence) if evidence else None
    delta = h.delta + (a.delta if a is not None else 0.0)
    capped = home.commit(ts, present, delta)
    # A capped session in merged mode may be held open by either side's load.
    home.settle(h, reset=capped)
    if a is not None:
        away.settle(a, reset=capped)


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
    trackers = (left, right)
    # One side in away mode: a single sleeper, whose rollovers onto the away
    # side merge into their own session.
    bed_mode = SingleSleeperMode(SLEEPYPOD_DB)
    saved = load_state(STATE_PATH)
    for t in trackers:
        t.restore(saved.get(t.side), time.time())
    last_save = time.monotonic()
    # Source selected once at startup: NatsFollower on new-firmware pods (NATS
    # reachable), else the unchanged .RAW tailer. Same decoded-record contract.
    follower = create_follower(RAW_DATA_DIR, _shutdown, poll_interval=0.5)

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

            # Surface genuinely-new firmware types once (blanketReadings, log,
            # …) instead of dropping them silently.
            if not isinstance(rtype, str):
                continue
            if rtype not in KNOWN_RECORD_TYPES:
                warn_unknown_type_once(record, "sleep-detector")
                continue

            # Update pump state from freezer health/thermal records
            if rtype in PUMP_STATE_TYPES:
                pump_gate.update_pump_state(record)
                continue

            if rtype not in CAPSENSE_TYPES:
                continue

            # Record (do not gate on) new-firmware capSense per-side status.
            log_capsense_status_once(record, "sleep-detector")

            ts = sanitize_ts(record.get("ts"))
            home_side = bed_mode.home_side()
            if home_side is None:
                left.process(ts, record)
                right.process(ts, record)
            elif home_side == "left":
                process_single_sleeper(left, right, ts, record)
            else:
                process_single_sleeper(right, left, ts, record)

            if (left.state_dirty or right.state_dirty
                    or time.monotonic() - last_save >= STATE_SAVE_INTERVAL_S):
                if save_state(STATE_PATH, trackers):
                    left.state_dirty = right.state_dirty = False
                last_save = time.monotonic()

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        save_state(STATE_PATH, trackers)
        cal_store.close()
        db_holder.conn.close()
        log.info("Shutdown complete")

    # Only reached on clean shutdown (not via sys.exit)
    report_health("down", "sleep-detector stopped")


if __name__ == "__main__":
    main()
