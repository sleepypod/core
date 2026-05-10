#!/usr/bin/env python3
"""
SleepyPod piezo-processor module (v2).

Reads raw piezoelectric sensor data from /persistent/*.RAW (CBOR-encoded),
computes heart rate, HRV, and breathing rate, and writes results to biometrics.db.

One row is written to the `vitals` table approximately every 60 seconds per side
while a user is detected on the pod.

Signal processing pipeline (per side):
  1. PumpGate: dual-channel energy spike detection with 5s guard period
     (Shin et al. IEEE TBME 2009) — records arriving during pump activity
     are dropped before entering side buffers
  2. Buffer incoming 500 Hz piezo samples into rolling windows
  3. Presence detection: hysteresis state machine on median std of 1-10 Hz
     filtered signal in 5s sub-windows, with autocorrelation quality as
     secondary feature (Paalasmaa et al. 2012)
  4. Heart rate: 0.8-8.5 Hz SOS bandpass → subharmonic summation
     autocorrelation (Hermes 1988; Bruser et al. 2011) with inter-window
     Gaussian consistency tracking (max 15 BPM delta)
  5. Breathing rate: Hilbert envelope of 0.8-10 Hz cardiac band →
     0.1-0.7 Hz respiratory extraction → peak counting (PMC9354426)
  6. HR variability index: 10s sub-window autocorrelation IBI with 50%
     overlap → harmonic gate → Hampel filter → gap-aware successive
     differences (NOT clinical RMSSD — see #221)
"""

import os
import sys
import json
import time
import signal
import logging
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timezone
from collections import deque
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cbor2
from common.raw_follower import RawFileFollower
import numpy as np
from scipy.signal import butter, sosfiltfilt, hilbert, find_peaks

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RAW_DATA_DIR = Path(os.environ.get("RAW_DATA_DIR", "/persistent"))
BIOMETRICS_DB = Path(os.environ.get("BIOMETRICS_DATABASE_URL", "file:/persistent/sleepypod-data/biometrics.db").replace("file:", ""))
SLEEPYPOD_DB = Path(os.environ.get("DATABASE_URL", "file:/persistent/sleepypod-data/sleepypod.db").replace("file:", ""))

SAMPLE_RATE = 500          # Hz — piezo sensor sample rate
VITALS_INTERVAL_S = 60     # write a vitals row every N seconds
HR_WINDOW_S = 30           # seconds of data for heart rate calculation
BREATHING_WINDOW_S = 60    # seconds of data for breathing rate calculation
HRV_WINDOW_S = 300         # seconds of data for HRV (5-minute RMSSD)

# Pump gating
PUMP_ENERGY_MULTIPLIER = 10.0
PUMP_CORRELATION_MIN = 0.5
PUMP_GUARD_S = 5.0

# Per-side pump activity threshold (frzHealth pump RPM). PumpGate catches
# broadband-symmetric energy spikes but misses two steady-state coupling
# modes: asymmetric (one pump on, observed 2026-05-02 Pod 3 — pump@2000RPM
# on right with left idle drove phantom HR/HRV/BR) and symmetric (both
# pumps on, observed 2026-05-05 Pod 5 — 1940/2004 rpm beat at 64/min lands
# in the cardiac band). Both are caught by the guard below.
PUMP_ACTIVE_RPM_MIN = 50          # pump considered "running" above this
PUMP_OFF_GUARD_S = 5.0            # trailing guard after own-side pump-off
PUMP_COUPLING_STD_FACTOR = 4.0    # raise enter_threshold by this factor
PUMP_COUPLING_ACR_THRESHOLD = 0.6 # require strong autocorr to enter

# HR band: 0.8 Hz preserves fundamental of 48+ BPM; 8.5 Hz per PMC7582983
HR_BAND = (0.8, 8.5)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [piezo-processor] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shutdown handling
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


# After this many consecutive write failures, discard the connection and
# reopen on the next write attempt (#325).
_DB_RECONNECT_THRESHOLD = 5
_db_write_failures = 0
_db_conn_ref: Optional[sqlite3.Connection] = None


def _replace_db_connection() -> Optional[sqlite3.Connection]:
    """Close the current biometrics connection and open a fresh one.

    Returns the new connection, or None if reconnection failed. On failure the
    caller should keep using the old handle so subsequent writes can retry.
    """
    global _db_conn_ref
    old = _db_conn_ref
    try:
        if old is not None:
            try:
                old.close()
            except sqlite3.Error:
                pass
        _db_conn_ref = open_biometrics_db()
        log.info("Reopened biometrics DB connection after write failures")
        return _db_conn_ref
    except sqlite3.Error as e:
        log.error("Failed to reopen biometrics DB: %s", e)
        return None


def write_vitals(conn: sqlite3.Connection, side: str, ts: datetime,
                 heart_rate: Optional[float], hrv: Optional[float],
                 breathing_rate: Optional[float],
                 quality_score: float,
                 flags: Optional[list] = None,
                 hr_raw: Optional[float] = None) -> tuple[sqlite3.Connection, bool]:
    """Insert one vitals row + paired vitals_quality row. Logs and swallows
    sqlite3 errors so the main loop survives transient WAL/disk issues (#325).
    After _DB_RECONNECT_THRESHOLD consecutive failures, the connection is
    replaced and the new handle is returned.

    Returns (conn, wrote): caller must use the returned connection for
    subsequent writes; `wrote` is True only when both inserts committed
    so callers don't advance their downsample cursor on a failed write.
    """
    global _db_write_failures, _db_conn_ref
    _db_conn_ref = conn
    ts_unix = int(ts.timestamp())
    now_unix = int(time.time())
    flags_json = json.dumps(flags) if flags else None
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES (?, ?, ?, ?, ?)",
                (side, ts_unix, heart_rate, hrv, breathing_rate),
            )
            conn.execute(
                "INSERT INTO vitals_quality (vitals_id, side, timestamp, quality_score, flags, hr_raw, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (cur.lastrowid, side, ts_unix, quality_score, flags_json, hr_raw, now_unix),
            )
        _db_write_failures = 0
        return conn, True
    except sqlite3.Error as e:
        _db_write_failures += 1
        log.warning("write_vitals failed (%d consecutive): %s",
                    _db_write_failures, e)
        if _db_write_failures >= _DB_RECONNECT_THRESHOLD:
            new_conn = _replace_db_connection()
            _db_write_failures = 0
            if new_conn is not None:
                return new_conn, False
        return conn, False


def report_health(status: str, message: str) -> None:
    """Write module health to sleepypod.db system_health table."""
    try:
        conn = sqlite3.connect(str(SLEEPYPOD_DB), timeout=2.0)
        try:
            with conn:
                conn.execute(
                    """INSERT INTO system_health (component, status, message, last_checked)
                       VALUES ('piezo-processor', ?, ?, ?)
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
# Signal processing — filters
# ---------------------------------------------------------------------------

def _bandpass(sig: np.ndarray, lo: float, hi: float, fs: float,
              order: int = 4) -> np.ndarray:
    """Bandpass filter using SOS form for numerical stability."""
    sos = butter(order, [lo, hi], btype='band', fs=fs, output='sos')
    return sosfiltfilt(sos, sig)

# ---------------------------------------------------------------------------
# Pump gating — streaming adaptation (Shin et al. IEEE TBME 2009)
# ---------------------------------------------------------------------------

class FrzHealthPumpState:
    """Tracks per-side pump RPM from frzHealth records.

    Used by SideProcessor to suppress phantom presence detection when
    only the same side's pump is running (asymmetric pump-coupling
    artifact). Trailing guard period mirrors the post-pump-off ringing
    in the piezo channel.
    """

    def __init__(self):
        self._pump_rpm = {"left": 0.0, "right": 0.0}
        # monotonic seconds when each side's pump last turned off
        self._pump_off_at = {"left": 0.0, "right": 0.0}
        self._was_active = {"left": False, "right": False}

    def update(self, record: dict) -> None:
        if record.get("type") != "frzHealth":
            return
        for side in ("left", "right"):
            data = record.get(side)
            if not isinstance(data, dict):
                continue
            rpm = 0.0
            for key in ("pumpRpm", "pump_rpm", "pumpRPM", "rpm"):
                val = data.get(key)
                if val is not None:
                    try:
                        rpm = float(val)
                    except (TypeError, ValueError):
                        rpm = 0.0
                    break
            if rpm == 0:
                for key in ("pumpDuty", "pump_duty", "duty"):
                    val = data.get(key)
                    if val is not None:
                        try:
                            rpm = PUMP_ACTIVE_RPM_MIN + 1.0 if float(val) > 0 else 0.0
                        except (TypeError, ValueError):
                            rpm = 0.0
                        break

            now_active = rpm >= PUMP_ACTIVE_RPM_MIN
            if self._was_active[side] and not now_active:
                self._pump_off_at[side] = time.monotonic()
            self._pump_rpm[side] = rpm
            self._was_active[side] = now_active

    def is_side_pump_active(self, side: str) -> bool:
        """Pump active = currently running OR within the trailing guard window."""
        if self._pump_rpm[side] >= PUMP_ACTIVE_RPM_MIN:
            return True
        return time.monotonic() - self._pump_off_at[side] < PUMP_OFF_GUARD_S

    def is_asymmetric_for(self, side: str) -> bool:
        """Own pump active, opposite pump idle (and outside its own guard).
        This is the configuration that produces phantom presence: pump
        vibration on the powered side without competing signal on the
        other side to balance/reject."""
        other = "right" if side == "left" else "left"
        return self.is_side_pump_active(side) and not self.is_side_pump_active(other)

    def is_symmetric_active(self) -> bool:
        """Both pumps active. RPM mismatch (Pod 5 live: 1940/2004) produces
        a beat frequency in the cardiac band, generating bilateral phantom
        vitals. PumpGate catches symmetric spikes but not steady-state."""
        return self.is_side_pump_active("left") and self.is_side_pump_active("right")


class PumpGate:
    """Detects pump activity from dual-channel energy spikes.

    In streaming mode, each incoming record's L+R chunks are checked.
    If a pump is detected, a guard period is set during which all
    subsequent records are dropped (not ingested into side buffers).
    """

    def __init__(self, fs: float = SAMPLE_RATE):
        self._fs = fs
        self._baseline: Optional[float] = None
        self._pump_until: float = 0.0  # monotonic seconds when guard expires

    def is_pump_active(self) -> bool:
        return time.monotonic() < self._pump_until

    def check(self, left_chunk: np.ndarray, right_chunk: np.ndarray) -> bool:
        """Check a single record's L+R chunks for pump activity.

        Returns True if the record should be DROPPED (pump detected or
        guard period active), False if the record is clean.
        """
        # If we're still in the guard period, drop
        if self.is_pump_active():
            return True

        # Compute energy for both channels
        le = float(np.mean(left_chunk.astype(np.float64) ** 2))
        re = float(np.mean(right_chunk.astype(np.float64) ** 2))

        if le == 0 or re == 0:
            return False

        ratio = min(le, re) / max(le, re)

        if self._baseline is not None and self._baseline > 0:
            spike = max(le, re) / self._baseline
            if ratio > PUMP_CORRELATION_MIN and spike > PUMP_ENERGY_MULTIPLIER:
                # Pump detected — set guard period
                self._pump_until = time.monotonic() + PUMP_GUARD_S
                log.debug("Pump detected (spike=%.1f, ratio=%.2f), "
                          "guard until +%.0fs", spike, ratio, PUMP_GUARD_S)
                return True

        # Update baseline with exponential moving average (only on clean data).
        # Guard: if first record has unusually high energy (module started during
        # pump), don't initialize baseline from it — wait for a quieter sample.
        avg = (le + re) / 2
        if self._baseline is None:
            self._baseline = avg
            self._baseline_samples = 1
        elif avg < self._baseline * 3:
            self._baseline = 0.95 * self._baseline + 0.05 * avg
            self._baseline_samples = getattr(self, '_baseline_samples', 0) + 1
            # If early samples are settling, allow baseline to drop faster
            if self._baseline_samples < 10:
                self._baseline = min(self._baseline, avg)

        return False

# ---------------------------------------------------------------------------
# Presence detection — hysteresis state machine (Paalasmaa et al. 2012)
# ---------------------------------------------------------------------------

def _autocorr_quality(sig: np.ndarray, fs: float = SAMPLE_RATE) -> float:
    """Peak height of best autocorrelation peak in cardiac range.

    Person on bed produces periodic signal with high peak.
    Empty bed produces noise with low peak.
    """
    try:
        filtered = _bandpass(sig, 0.8, 8.5, fs)
        seg = filtered[:int(min(len(filtered), 10 * fs))]
        seg = seg - np.mean(seg)
        norm = np.std(seg)
        if norm < 1e-10:
            return 0.0
        seg = seg / norm

        n = len(seg)
        fft_size = 1
        while fft_size < 2 * n:
            fft_size *= 2
        fft_f = np.fft.rfft(seg, n=fft_size)
        acr = np.fft.irfft(fft_f * np.conj(fft_f), n=fft_size)[:n]
        if acr[0] == 0:
            return 0.0
        acr = acr / acr[0]

        min_lag = int(fs * 60 / 150)
        max_lag = min(int(fs * 60 / 40), len(acr) - 1)
        if max_lag <= min_lag:
            return 0.0
        return float(max(np.max(acr[min_lag:max_lag + 1]), 0.0))
    except Exception:
        return 0.0


class PresenceDetector:
    """Hysteresis-based presence detection with autocorrelation quality.

    Uses median std of 1-10 Hz filtered signal in 5-second windows as
    the primary feature, with autocorrelation quality as secondary.
    Requires 3 consecutive low windows to exit PRESENT state.
    """
    ABSENT = 0
    PRESENT = 1

    def __init__(self):
        self.state = self.ABSENT
        self.consecutive_low = 0
        self.enter_threshold = 400_000
        self.exit_threshold = 150_000
        self.exit_count = 3       # 3 consecutive low windows to declare absent
        self.acr_threshold = 0.45

    def update(self, window_std: float, acr_qual: float) -> bool:
        """Update state and return True if user is present."""
        if self.state == self.ABSENT:
            if window_std > self.enter_threshold or acr_qual > self.acr_threshold:
                self.state = self.PRESENT
                self.consecutive_low = 0
                return True
            return False
        else:
            if window_std < self.exit_threshold and acr_qual < self.acr_threshold * 0.5:
                self.consecutive_low += 1
                if self.consecutive_low >= self.exit_count:
                    self.state = self.ABSENT
                    self.consecutive_low = 0
                    return False
                return True  # still present (hysteresis)
            else:
                self.consecutive_low = 0
                return True

# ---------------------------------------------------------------------------
# Heart rate — subharmonic summation autocorrelation (Hermes 1988; Bruser 2011)
# ---------------------------------------------------------------------------

def _compute_autocorr(filtered: np.ndarray, fs: float) -> Optional[np.ndarray]:
    """Compute normalised autocorrelation via FFT."""
    n = len(filtered)
    fft_size = 1
    while fft_size < 2 * n:
        fft_size *= 2
    fft_f = np.fft.rfft(filtered, n=fft_size)
    acr = np.fft.irfft(fft_f * np.conj(fft_f), n=fft_size)[:n]
    if acr[0] == 0:
        return None
    return acr / acr[0]


def subharmonic_summation_hr(samples: np.ndarray, fs: float = SAMPLE_RATE,
                             bpm_range: tuple = (45, 120),
                             n_harmonics: int = 3):
    """Subharmonic summation for robust fundamental HR detection.

    Only scores autocorrelation PEAKS (not every lag) to avoid edge effects
    where long lags accumulate noise. For each candidate peak lag L,
    score = weighted sum of autocorr at L, L/2, L/3.

    Hermes 1988 (JASA), adapted for BCG by Bruser et al. 2011.

    Returns (heart_rate_bpm, score) or (None, 0.0) on failure.
    """
    filtered = _bandpass(samples, HR_BAND[0], HR_BAND[1], fs)
    acr = _compute_autocorr(filtered, fs)
    if acr is None:
        return None, 0.0

    min_lag = int(fs * 60 / bpm_range[1])
    max_lag = int(fs * 60 / bpm_range[0])
    max_lag = min(max_lag, len(acr) - 1)

    if max_lag <= min_lag:
        return None, 0.0

    # Find actual peaks in autocorrelation (not every lag)
    search = acr[min_lag:max_lag + 1]
    peaks, _props = find_peaks(search, height=0.02, distance=int(fs * 0.15))
    if len(peaks) == 0:
        return None, 0.0

    candidate_lags = peaks + min_lag
    weights = [1.0, 0.8, 0.6][:n_harmonics]

    best_lag = None
    best_score = 0.0

    for lag in candidate_lags:
        score = 0.0
        for k in range(n_harmonics):
            exact_lag = lag / (k + 1)
            lag_lo = int(exact_lag)
            lag_hi = lag_lo + 1
            if lag_hi >= len(acr):
                continue
            frac = exact_lag - lag_lo
            val = acr[lag_lo] * (1 - frac) + acr[lag_hi] * frac
            score += weights[k] * max(val, 0)
        if score > best_score:
            best_score = score
            best_lag = lag

    if best_lag is None or best_score < 0.1:
        return None, best_score

    hr = 60.0 * fs / best_lag
    return hr, best_score


class HRTracker:
    """Inter-window HR tracking with Gaussian consistency constraint.

    HR cannot jump > max_delta BPM between consecutive windows at rest.
    Catches residual harmonic escapes via half/double correction.
    Bruser et al. 2011.
    """

    def __init__(self, max_delta: float = 15.0, history_len: int = 5):
        # Bounded deque: only the last history_len entries are ever consulted,
        # so retaining the full list would leak ~1440 floats/day (#325).
        self.history: deque = deque(maxlen=history_len)
        self.max_delta = max_delta
        self.history_len = history_len

    def update(self, hr_candidate: Optional[float],
               score: float) -> Optional[float]:
        if hr_candidate is None:
            return None

        if not self.history:
            self.history.append(hr_candidate)
            return hr_candidate

        recent = float(np.median(list(self.history)))
        delta = abs(hr_candidate - recent)

        # Gaussian consistency weight
        consistency = np.exp(-0.5 * (delta / self.max_delta) ** 2)
        if consistency > 0.3:
            self.history.append(hr_candidate)
            return hr_candidate

        # Try half (harmonic correction)
        half_hr = hr_candidate / 2
        if 40 <= half_hr <= 120:
            half_delta = abs(half_hr - recent)
            half_consistency = np.exp(-0.5 * (half_delta / self.max_delta) ** 2)
            if half_consistency > 0.3:
                self.history.append(half_hr)
                return half_hr

        # Try double (sub-harmonic correction)
        double_hr = hr_candidate * 2
        if 40 <= double_hr <= 180:
            double_delta = abs(double_hr - recent)
            double_consistency = np.exp(
                -0.5 * (double_delta / self.max_delta) ** 2)
            if double_consistency > 0.3:
                self.history.append(double_hr)
                return double_hr

        # Accept anyway but don't poison history
        return hr_candidate

# ---------------------------------------------------------------------------
# Breathing rate — Hilbert envelope (PMC9354426)
# ---------------------------------------------------------------------------

def compute_breathing_rate(samples: np.ndarray,
                           fs: float = SAMPLE_RATE) -> Optional[float]:
    """Breathing rate via Hilbert envelope of the cardiac band.

    Pipeline: bandpass 0.8-10 Hz -> Hilbert transform -> amplitude envelope
    -> bandpass 0.1-0.7 Hz -> peak counting.
    """
    try:
        cardiac = _bandpass(samples, 0.8, 10.0, fs)
        envelope = np.abs(hilbert(cardiac))
        resp = _bandpass(envelope, 0.1, 0.7, fs)
        peaks, _ = find_peaks(resp, distance=int(2.0 * fs))
        if len(peaks) < 3:
            return None
        intervals = np.diff(peaks) / fs
        med = np.median(intervals)
        valid = intervals[(intervals > med * 0.5) & (intervals < med * 1.5)]
        if len(valid) < 2:
            return None
        br = 60.0 / float(np.mean(valid))
        return br if 6 <= br <= 30 else None
    except Exception as e:
        log.debug("Breathing rate computation failed: %s", e)
        return None

# ---------------------------------------------------------------------------
# HR variability index — window-level IBI with harmonic gate
#
# NOTE: This is NOT clinical RMSSD. It computes successive differences of
# window-level IBI estimates (~59 per 5 min with 10s windows), not beat-to-beat
# intervals (~300+ per 5 min). The output measures HR stability across windows,
# not vagal beat-to-beat modulation. See #221 for the beat-level upgrade path.
# ---------------------------------------------------------------------------

# Harmonic tolerance for IBI gating (18% per DSP expert recommendation)
_HRV_HARMONIC_TOL = 0.18
# Sub-window length for IBI estimation (10s per DSP expert recommendation —
# gives ~59 windows per 5 min vs ~19 with 30s windows)
_HRV_WINDOW_S = 10
# Minimum accepted IBI estimates after filtering
_HRV_MIN_IBIS = 10
# Maximum gap between consecutive accepted windows before skipping the diff
_HRV_MAX_GAP_WINDOWS = 3


def _harmonic_gate(ibi_ms: float, tracker_ibi_ms: float) -> Optional[float]:
    """Reject or correct IBIs that are harmonic multiples of the expected value.

    Returns the accepted/corrected IBI in ms, or None to discard.
    """
    if tracker_ibi_ms <= 0:
        return ibi_ms  # no prior yet — accept as-is

    for multiplier in [1.0, 2.0, 0.5, 3.0, 1.0 / 3.0]:
        candidate = tracker_ibi_ms * multiplier
        if candidate > 0 and abs(ibi_ms - candidate) / candidate < _HRV_HARMONIC_TOL:
            if multiplier == 1.0:
                return ibi_ms       # fundamental — accept
            else:
                return tracker_ibi_ms  # harmonic — substitute tracker value
    return None  # outside all harmonic relationships — discard


def compute_hrv(samples: np.ndarray,
                fs: float = SAMPLE_RATE) -> Optional[float]:
    """HR variability index via window-level IBI with harmonic gate.

    Pipeline:
      1. Bandpass 0.8-8.5 Hz
      2. 10s sub-windows with 50% overlap (~59 windows per 5 min)
      3. SHS autocorrelation per window → raw IBI
      4. Harmonic gate: reject/correct IBIs using trimmed-mean tracker
      5. Hampel filter on accepted IBI series
      6. Gap-aware RMSSD (skip diffs across rejected-window gaps)
      7. Range gate: 5-100 ms

    NOT clinical RMSSD — see module docstring and #221.
    """
    try:
        filtered = _bandpass(samples, HR_BAND[0], HR_BAND[1], fs)
        sub_window = int(_HRV_WINDOW_S * fs)
        step = sub_window // 2
        min_lag = int(fs * 60 / 150)
        max_lag = int(fs * 60 / 40)

        # --- Pass 1: SHS autocorrelation per window → raw IBIs ---
        raw_ibis: list = []  # (window_index, ibi_ms)
        for idx, start in enumerate(
                range(0, len(filtered) - sub_window + 1, step)):
            chunk = filtered[start:start + sub_window]
            acr = _compute_autocorr(chunk, fs)
            if acr is None:
                continue
            search = acr[min_lag:min(max_lag + 1, len(acr))]
            if len(search) == 0:
                continue

            # SHS scoring — find peaks first, then score
            peaks, _props = find_peaks(search, height=0.02,
                                       distance=int(fs * 0.15))
            if len(peaks) == 0:
                continue

            candidate_lags = peaks + min_lag
            weights = [1.0, 0.8, 0.6]
            best_lag, best_score = None, 0.0
            for lag in candidate_lags:
                score = 0.0
                for k in range(3):
                    exact = lag / (k + 1)
                    lo_i = int(exact)
                    hi_i = lo_i + 1
                    if hi_i >= len(acr):
                        continue
                    frac = exact - lo_i
                    val = acr[lo_i] * (1 - frac) + acr[hi_i] * frac
                    score += weights[k] * max(val, 0)
                if score > best_score:
                    best_score = score
                    best_lag = lag

            if best_lag is None or best_score < 0.1:
                continue
            ibi_ms = best_lag / fs * 1000
            if 400 <= ibi_ms <= 1500:
                raw_ibis.append((idx, ibi_ms))

        if len(raw_ibis) < _HRV_MIN_IBIS:
            return None

        # --- Pass 2: Harmonic gate with trimmed-mean tracker ---
        tracker_history: list = []
        gated: list = []  # (window_index, ibi_ms)

        for win_idx, ibi_ms in raw_ibis:
            # Compute tracker IBI as trimmed mean of last 5 accepted
            if len(tracker_history) >= 3:
                sorted_h = sorted(tracker_history[-5:])
                # Drop min+max if we have enough
                if len(sorted_h) >= 4:
                    trimmed = sorted_h[1:-1]
                else:
                    trimmed = sorted_h
                tracker_ibi = sum(trimmed) / len(trimmed)
            elif tracker_history:
                tracker_ibi = sum(tracker_history) / len(tracker_history)
            else:
                tracker_ibi = 0  # no prior — accept first value

            accepted = _harmonic_gate(ibi_ms, tracker_ibi)
            if accepted is not None:
                gated.append((win_idx, accepted))
                tracker_history.append(accepted)

        if len(gated) < _HRV_MIN_IBIS:
            return None

        # --- Pass 3: Hampel filter on gated IBI series ---
        ibi_values = np.array([ibi for _, ibi in gated])
        win_indices = [idx for idx, _ in gated]
        clean_mask = np.ones(len(ibi_values), dtype=bool)

        for i in range(len(ibi_values)):
            lo_i = max(0, i - 3)
            hi_i = min(len(ibi_values), i + 4)
            local = ibi_values[lo_i:hi_i]
            med = np.median(local)
            mad = max(np.median(np.abs(local - med)), 1e-6)
            if abs(ibi_values[i] - med) > 3.0 * 1.4826 * mad:
                clean_mask[i] = False

        clean_ibis = ibi_values[clean_mask]
        clean_indices = [win_indices[i] for i in range(len(win_indices))
                         if clean_mask[i]]

        if len(clean_ibis) < _HRV_MIN_IBIS:
            return None

        # --- Pass 4: Gap-aware RMSSD ---
        sq_diffs: list = []
        for i in range(1, len(clean_ibis)):
            gap = clean_indices[i] - clean_indices[i - 1]
            if gap >= _HRV_MAX_GAP_WINDOWS:
                continue  # skip diff across rejected-window gap
            diff = clean_ibis[i] - clean_ibis[i - 1]
            sq_diffs.append(diff ** 2)

        if len(sq_diffs) < 5:
            return None

        hrv_index = float(np.sqrt(np.mean(sq_diffs)))
        # Range gate: 5-100 ms. Window-level HRV above 100 ms is artifact
        # even after harmonic correction (cardiologist recommendation).
        return hrv_index if 5 <= hrv_index <= 100 else None
    except Exception as e:
        log.debug("HRV computation failed: %s", e)
        return None

# ---------------------------------------------------------------------------
# Per-side processor
# ---------------------------------------------------------------------------

class SideProcessor:
    def __init__(self, side: str, db_conn: sqlite3.Connection,
                 pump_state: Optional[FrzHealthPumpState] = None):
        self.side = side
        self.db = db_conn
        self._hr_buf: deque = deque(maxlen=HR_WINDOW_S * SAMPLE_RATE)
        self._hrv_buf: deque = deque(maxlen=HRV_WINDOW_S * SAMPLE_RATE)
        self._br_buf: deque = deque(maxlen=BREATHING_WINDOW_S * SAMPLE_RATE)
        self._last_write = 0.0
        self._presence = PresenceDetector()
        self._hr_tracker = HRTracker()
        self._other: Optional['SideProcessor'] = None  # set after both sides created
        self._last_med_std: float = 0.0  # cached for cross-channel comparison
        self._last_acr_qual: float = 0.0
        self._pump_state = pump_state

    def ingest(self, samples: np.ndarray) -> None:
        self._hr_buf.extend(samples)
        self._hrv_buf.extend(samples)
        self._br_buf.extend(samples)
        self._maybe_write()

    def _maybe_write(self) -> None:
        now = time.time()
        if now - self._last_write < VITALS_INTERVAL_S:
            return

        hr_arr = np.array(self._hr_buf)
        if len(hr_arr) < int(10 * SAMPLE_RATE):
            return  # Not enough data yet

        # --- Presence detection (hysteresis + autocorrelation quality) ---
        filt = _bandpass(hr_arr, 1.0, 10.0, SAMPLE_RATE)
        w = int(5 * SAMPLE_RATE)
        stds = [np.std(filt[j:j + w])
                for j in range(0, len(filt) - w + 1, w)]
        med_std = float(np.median(stds)) if stds else 0.0
        acr_qual = _autocorr_quality(hr_arr)

        # Cross-channel rejection: if the other side has stronger or similar
        # signal AND strong autocorrelation (someone is actually there), this
        # side's signal is likely vibration coupling, not a person.
        # A real person produces ~3-5x stronger signal on their side.
        #
        # Note: due to sequential processing in main() (left before right),
        # left sees right's values from the previous cycle (~60s stale).
        # This is acceptable — coupling produces similar energy regardless
        # of which side checks first.
        if self._other is not None and self._other._last_med_std > 0:
            other_std = self._other._last_med_std
            other_acr = self._other._last_acr_qual
            # Only suppress if: other side has real periodicity (someone there),
            # other side's energy is >= ours, and our energy is below threshold
            if (other_acr > 0.3
                    and other_std > med_std * 0.7
                    and med_std < self._presence.enter_threshold):
                acr_qual = 0.0

        # Cache AFTER suppression so the other side sees post-suppression values
        self._last_med_std = med_std
        self._last_acr_qual = acr_qual

        # Pump-coupling guard. PumpGate handles symmetric spikes (ramps)
        # but misses two steady-state modes: asymmetric (own-pump-on with
        # opposite idle — vibration couples into same-side piezo, no
        # competing signal for cross-channel rejection) and symmetric
        # (both pumps on at mismatched RPMs — beat frequency lands in the
        # cardiac band, both sides look "real"). In both, require elevated
        # energy AND strong autocorrelation to enter PRESENT; coupling
        # rarely produces both, only a real person does.
        if self._pump_state is not None and self._presence.state == PresenceDetector.ABSENT:
            symmetric = self._pump_state.is_symmetric_active()
            asymmetric = self._pump_state.is_asymmetric_for(self.side)
            if symmetric or asymmetric:
                std_threshold = self._presence.enter_threshold * PUMP_COUPLING_STD_FACTOR
                if not (med_std > std_threshold and acr_qual > PUMP_COUPLING_ACR_THRESHOLD):
                    log.debug(
                        "%s: pump-coupling guard suppressed presence "
                        "(med_std=%.0f, acr=%.2f, mode=%s)",
                        self.side, med_std, acr_qual,
                        "symmetric" if symmetric else "asymmetric",
                    )
                    return

        present = self._presence.update(med_std, acr_qual)

        if not present:
            # Reset the interval cursor so a return from extended absence
            # doesn't trigger burst processing on every ingest until the
            # first write completes (#325).
            self._last_write = now
            return  # No user detected — skip

        # --- Heart rate (subharmonic summation + tracking) ---
        hr_raw, hr_score = subharmonic_summation_hr(hr_arr)
        hr = self._hr_tracker.update(hr_raw, hr_score)

        # --- Breathing rate (Hilbert envelope) ---
        br = compute_breathing_rate(np.array(self._br_buf))

        # --- HRV (sub-window autocorrelation IBI) ---
        hrv_arr = np.array(self._hrv_buf)
        hrv = compute_hrv(hrv_arr) if len(hrv_arr) >= int(
            HRV_WINDOW_S * SAMPLE_RATE) else None

        if hr is not None or hrv is not None or br is not None:
            ts = datetime.now(timezone.utc)
            snr = max(0.0, min(1.0, acr_qual))
            hr_conf = max(0.0, min(1.0, hr_score)) if hr is not None else 0.0
            quality = round(0.55 * snr + 0.45 * hr_conf, 3)
            flags = []
            if hr is None:
                flags.append("no_hr")
            if hrv is None:
                flags.append("no_hrv")
            if br is None:
                flags.append("no_br")
            if med_std < self._presence.enter_threshold:
                flags.append("low_signal")
            self.db, wrote = write_vitals(self.db, self.side, ts, hr, hrv, br,
                                          quality_score=quality, flags=flags or None,
                                          hr_raw=hr_raw)
            log.info("vitals %s — HR=%.1f HRV=%.1f BR=%.1f q=%.2f", self.side,
                     hr or 0, hrv or 0, br or 0, quality)
            # Only advance the downsample cursor when the write actually
            # committed — otherwise a transient sqlite error would skip
            # VITALS_INTERVAL_S of valid samples.
            if wrote:
                self._last_write = now
        else:
            # No metric to write — advance so we don't recompute on every ingest.
            self._last_write = now

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    log.info("Starting piezo-processor v2 (biometrics.db=%s)", BIOMETRICS_DB)

    if not BIOMETRICS_DB.parent.exists():
        log.error("Biometrics DB directory does not exist: %s", BIOMETRICS_DB.parent)
        sys.exit(1)

    db_conn = open_biometrics_db()
    pump_gate = PumpGate()
    pump_state = FrzHealthPumpState()
    left = SideProcessor("left", db_conn, pump_state=pump_state)
    right = SideProcessor("right", db_conn, pump_state=pump_state)
    left._other = right
    right._other = left
    follower = RawFileFollower(RAW_DATA_DIR, _shutdown, poll_interval=0.01)

    report_health("healthy", "piezo-processor v2 started")

    try:
        for record in follower.read_records():
            rtype = record.get("type")

            # Track per-side pump state for the asymmetric pump-coupling guard
            if rtype == "frzHealth":
                pump_state.update(record)
                continue

            if rtype != "piezo-dual":
                continue

            # Each record contains ~500 int32 samples per channel
            l_samples = np.frombuffer(record.get("left1", b""), dtype=np.int32)
            r_samples = np.frombuffer(record.get("right1", b""), dtype=np.int32)

            if l_samples.size == 0 or r_samples.size == 0:
                continue

            # Pump gating — drop entire record if pump detected or guard active
            if pump_gate.check(l_samples, r_samples):
                continue

            left.ingest(l_samples)
            right.ingest(r_samples)

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        db_conn.close()
        log.info("Shutdown complete")

    # Only reached on clean shutdown (not via sys.exit)
    report_health("down", "piezo-processor stopped")


if __name__ == "__main__":
    main()
