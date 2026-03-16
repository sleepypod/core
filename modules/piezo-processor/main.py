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
  6. HRV: 30s sub-window autocorrelation IBI with 50% overlap →
     Hampel filter → RMSSD (PMC9305910)
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


def write_vitals(conn: sqlite3.Connection, side: str, ts: datetime,
                 heart_rate: Optional[float], hrv: Optional[float],
                 breathing_rate: Optional[float]) -> None:
    ts_unix = int(ts.timestamp())
    with conn:
        conn.execute(
            "INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES (?, ?, ?, ?, ?)",
            (side, ts_unix, heart_rate, hrv, breathing_rate),
        )


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
        self.history: list = []
        self.max_delta = max_delta
        self.history_len = history_len

    def update(self, hr_candidate: Optional[float],
               score: float) -> Optional[float]:
        if hr_candidate is None:
            return None

        if not self.history:
            self.history.append(hr_candidate)
            return hr_candidate

        recent = float(np.median(self.history[-self.history_len:]))
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
# HRV — sub-window autocorrelation IBI + Hampel filter (PMC9305910)
# ---------------------------------------------------------------------------

def compute_hrv(samples: np.ndarray,
                fs: float = SAMPLE_RATE) -> Optional[float]:
    """HRV (RMSSD in ms) via sub-window autocorrelation IBI series.

    Splits the buffer into 30s sub-windows with 50% overlap, computes
    SHS autocorrelation per sub-window for IBI estimation, applies
    Hampel filter on the IBI series, and returns RMSSD.
    """
    try:
        filtered = _bandpass(samples, HR_BAND[0], HR_BAND[1], fs)
        sub_window = int(30 * fs)
        ibis: list = []
        min_lag = int(fs * 60 / 150)
        max_lag = int(fs * 60 / 40)

        for start in range(0, len(filtered) - sub_window + 1, sub_window // 2):
            chunk = filtered[start:start + sub_window]
            acr = _compute_autocorr(chunk, fs)
            if acr is None:
                continue
            search = acr[min_lag:min(max_lag + 1, len(acr))]
            if len(search) == 0:
                continue

            # SHS scoring for IBI
            weights = [1.0, 0.8, 0.6]
            scores = np.zeros(len(search))
            for j in range(len(search)):
                lag = j + min_lag
                s = 0.0
                for k in range(3):
                    exact = lag / (k + 1)
                    lo_i = int(exact)
                    hi_i = lo_i + 1
                    if hi_i >= len(acr):
                        continue
                    frac = exact - lo_i
                    val = acr[lo_i] * (1 - frac) + acr[hi_i] * frac
                    s += weights[k] * max(val, 0)
                scores[j] = s

            best_j = int(np.argmax(scores))
            if scores[best_j] < 0.1:
                continue
            peak_lag = best_j + min_lag
            ibi_ms = peak_lag / fs * 1000
            if 400 <= ibi_ms <= 1500:
                ibis.append(ibi_ms)

        if len(ibis) < 4:
            return None

        ibis_arr = np.array(ibis)

        # Hampel filter — remove outliers from IBI series
        clean: list = []
        for i in range(len(ibis_arr)):
            lo_i = max(0, i - 3)
            hi_i = min(len(ibis_arr), i + 4)
            local = ibis_arr[lo_i:hi_i]
            med = np.median(local)
            mad = max(np.median(np.abs(local - med)), 1e-6)
            if abs(ibis_arr[i] - med) <= 3.0 * 1.4826 * mad:
                clean.append(ibis_arr[i])
        clean_arr = np.array(clean)

        if len(clean_arr) < 3:
            return None
        diffs = np.diff(clean_arr)
        rmssd = float(np.sqrt(np.mean(diffs ** 2)))
        # RMSSD range: 5-200 ms. Values >200 ms from BCG are artifacts
        # (Shaffer & Ginsberg 2017; even elite athletes rarely exceed 200 ms)
        return rmssd if 5 <= rmssd <= 200 else None
    except Exception as e:
        log.debug("HRV computation failed: %s", e)
        return None

# ---------------------------------------------------------------------------
# Per-side processor
# ---------------------------------------------------------------------------

class SideProcessor:
    def __init__(self, side: str, db_conn: sqlite3.Connection):
        self.side = side
        self.db = db_conn
        self._hr_buf: deque = deque(maxlen=HR_WINDOW_S * SAMPLE_RATE)
        self._hrv_buf: deque = deque(maxlen=HRV_WINDOW_S * SAMPLE_RATE)
        self._br_buf: deque = deque(maxlen=BREATHING_WINDOW_S * SAMPLE_RATE)
        self._last_write = 0.0
        self._presence = PresenceDetector()
        self._hr_tracker = HRTracker()

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
        present = self._presence.update(med_std, acr_qual)

        if not present:
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
            write_vitals(self.db, self.side, ts, hr, hrv, br)
            log.info("vitals %s — HR=%.1f HRV=%.1f BR=%.1f", self.side,
                     hr or 0, hrv or 0, br or 0)

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
    left = SideProcessor("left", db_conn)
    right = SideProcessor("right", db_conn)
    follower = RawFileFollower(RAW_DATA_DIR, _shutdown, poll_interval=0.01)

    report_health("healthy", "piezo-processor v2 started")

    try:
        for record in follower.read_records():
            if record.get("type") != "piezo-dual":
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
