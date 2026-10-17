"""Shared numerical core for live processing and deterministic replay.

No database, sensor transport, hardware or wall-clock access. Callers own
occupancy, pump gating, window boundaries, state reset, timestamps and sinks.
Defaults were captured against dev 3e9027ed before extraction.
"""
from collections import deque
from dataclasses import dataclass
import logging
from typing import Optional

import numpy as np
from scipy.signal import butter, sosfiltfilt, hilbert, find_peaks

from .config import manifest, resolve_config, validate_config

SAMPLE_RATE = 500
HR_BAND = (0.8, 8.5)
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProcessingParameters:
    tracking_tolerance_bpm: float
    tracking_history_length: int
    breathing_interval_lower_ratio: float
    breathing_interval_upper_ratio: float
    hrv_harmonic_tolerance: float
    hrv_minimum_windows: int
    heart_rate_minimum_peak_score: float

    def __post_init__(self):
        resolve_config([
            {"path": "heart_rate.trackingToleranceBpm", "value": self.tracking_tolerance_bpm},
            {"path": "heart_rate.trackingHistoryLength", "value": self.tracking_history_length},
            {"path": "breathing_rate.intervalLowerRatio", "value": self.breathing_interval_lower_ratio},
            {"path": "breathing_rate.intervalUpperRatio", "value": self.breathing_interval_upper_ratio},
            {"path": "hrv_index.harmonicTolerance", "value": self.hrv_harmonic_tolerance},
            {"path": "hrv_index.minimumWindows", "value": self.hrv_minimum_windows},
            {"path": "heart_rate.minimumPeakScore", "value": self.heart_rate_minimum_peak_score},
        ])

    @classmethod
    def from_config(cls, config):
        validate_config(config)
        return cls(config["heart_rate"]["trackingToleranceBpm"],
                   config["heart_rate"]["trackingHistoryLength"],
                   config["breathing_rate"]["intervalLowerRatio"],
                   config["breathing_rate"]["intervalUpperRatio"],
                   config["hrv_index"]["harmonicTolerance"],
                   config["hrv_index"]["minimumWindows"],
                   config["heart_rate"]["minimumPeakScore"])


DEFAULT_PARAMETERS = ProcessingParameters.from_config(manifest()["defaults"])


def _bandpass(sig: np.ndarray, lo: float, hi: float, fs: float,
              order: int = 4) -> np.ndarray:
    """Bandpass filter using SOS form for numerical stability."""
    sos = butter(order, [lo, hi], btype='band', fs=fs, output='sos')
    return sosfiltfilt(sos, sig)



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
                             n_harmonics: int = 3,
                             min_score: float = DEFAULT_PARAMETERS.heart_rate_minimum_peak_score):
    """Subharmonic summation for robust fundamental HR detection.

    Only scores autocorrelation PEAKS (not every lag) to avoid edge effects
    where long lags accumulate noise. For each candidate peak lag L,
    score = weighted sum of autocorr at L, L/2, L/3.

    Hermes 1988 (JASA), adapted for BCG by Bruser et al. 2011.

    Returns (heart_rate_bpm, score) or (None, 0.0) on failure. A best score
    below min_score also returns (None, score): on a weak heartbeat the tallest
    autocorrelation peak is usually not the heart (the true rate is often not a
    candidate at all), so reporting nothing beats reporting a confident guess.
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

    if best_lag is None or best_score < min_score:
        return None, best_score

    hr = 60.0 * fs / best_lag
    return hr, best_score


class HRTracker:
    """Inter-window HR tracking with Gaussian consistency constraint.

    HR cannot jump > max_delta BPM between consecutive windows at rest.
    Catches residual harmonic escapes via half/double correction.
    Bruser et al. 2011.
    """

    # After this many consecutive uncorrectable readings, re-seed history at
    # the new level. A lone outlier must not poison the median, but a
    # sustained shift (e.g. different occupant) previously froze the tracker:
    # the stale median rejected every new reading forever.
    FALLBACK_RESET_STREAK = 3

    def __init__(self, max_delta: float = DEFAULT_PARAMETERS.tracking_tolerance_bpm,
                 history_len: int = DEFAULT_PARAMETERS.tracking_history_length):
        # Bounded deque: only the last history_len entries are ever consulted,
        # so retaining the full list would leak ~1440 floats/day (#325).
        self.history: deque = deque(maxlen=history_len)
        self.max_delta = max_delta
        self.history_len = history_len
        self._fallback_streak = 0

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
            self._fallback_streak = 0
            self.history.append(hr_candidate)
            return hr_candidate

        # Try half (harmonic correction)
        half_hr = hr_candidate / 2
        if 40 <= half_hr <= 120:
            half_delta = abs(half_hr - recent)
            half_consistency = np.exp(-0.5 * (half_delta / self.max_delta) ** 2)
            if half_consistency > 0.3:
                self._fallback_streak = 0
                self.history.append(half_hr)
                return half_hr

        # Try double (sub-harmonic correction)
        double_hr = hr_candidate * 2
        if 40 <= double_hr <= 180:
            double_delta = abs(double_hr - recent)
            double_consistency = np.exp(
                -0.5 * (double_delta / self.max_delta) ** 2)
            if double_consistency > 0.3:
                self._fallback_streak = 0
                self.history.append(double_hr)
                return double_hr

        # Accept anyway but keep a lone outlier out of history. A sustained
        # streak of uncorrectable readings means the tracked level itself is
        # stale (e.g. different occupant) — previously the frozen median then
        # rejected every reading forever, so re-seed at the new level.
        self._fallback_streak += 1
        if self._fallback_streak >= self.FALLBACK_RESET_STREAK:
            self.history.clear()
            self.history.append(hr_candidate)
            self._fallback_streak = 0
        return hr_candidate

# ---------------------------------------------------------------------------
# Breathing rate — Hilbert envelope (PMC9354426)
# ---------------------------------------------------------------------------

def compute_breathing_rate(samples: np.ndarray,
                           fs: float = SAMPLE_RATE,
                           parameters: ProcessingParameters = DEFAULT_PARAMETERS) -> Optional[float]:
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
        valid = intervals[(intervals > med * parameters.breathing_interval_lower_ratio)
                          & (intervals < med * parameters.breathing_interval_upper_ratio)]
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
_HRV_HARMONIC_TOL = DEFAULT_PARAMETERS.hrv_harmonic_tolerance
# Sub-window length for IBI estimation (10s per DSP expert recommendation —
# gives ~59 windows per 5 min vs ~19 with 30s windows)
_HRV_WINDOW_S = 10
# Minimum accepted IBI estimates after filtering
_HRV_MIN_IBIS = DEFAULT_PARAMETERS.hrv_minimum_windows
# Maximum gap between consecutive accepted windows before skipping the diff
_HRV_MAX_GAP_WINDOWS = 3


def _harmonic_gate(ibi_ms: float, tracker_ibi_ms: float,
                   tolerance: float = DEFAULT_PARAMETERS.hrv_harmonic_tolerance) -> Optional[float]:
    """Reject or correct IBIs that are harmonic multiples of the expected value.

    Returns the accepted/corrected IBI in ms, or None to discard.
    """
    if tracker_ibi_ms <= 0:
        return ibi_ms  # no prior yet — accept as-is

    for multiplier in [1.0, 2.0, 0.5, 3.0, 1.0 / 3.0]:
        candidate = tracker_ibi_ms * multiplier
        if candidate > 0 and abs(ibi_ms - candidate) / candidate < tolerance:
            if multiplier == 1.0:
                return ibi_ms       # fundamental — accept
            else:
                return tracker_ibi_ms  # harmonic — substitute tracker value
    return None  # outside all harmonic relationships — discard


def compute_hrv(samples: np.ndarray,
                fs: float = SAMPLE_RATE,
                parameters: ProcessingParameters = DEFAULT_PARAMETERS) -> Optional[float]:
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

        if len(raw_ibis) < parameters.hrv_minimum_windows:
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

            accepted = _harmonic_gate(ibi_ms, tracker_ibi, parameters.hrv_harmonic_tolerance)
            if accepted is not None:
                gated.append((win_idx, accepted))
                tracker_history.append(accepted)

        if len(gated) < parameters.hrv_minimum_windows:
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

        if len(clean_ibis) < parameters.hrv_minimum_windows:
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


@dataclass(frozen=True)
class WindowEstimate:
    timestamp_s: float
    heart_rate: Optional[float]
    hrv_index: Optional[float]
    breathing_rate: Optional[float]
    hr_raw: Optional[float]
    hr_score: float
    rejection_reasons: tuple


class WindowEstimator:
    """Stateful numerical estimator used by live and historical adapters.

    Inputs are already gated, timestamped windows, in their processing order.
    This layer cannot infer missing occupancy/pump/channel context and must not
    be advertised as a full raw replay by itself. One instance per side and
    configuration boundary prevents tracker history crossing profiles.
    """
    def __init__(self, parameters: ProcessingParameters = DEFAULT_PARAMETERS):
        self.parameters = parameters
        self.hr_tracker = HRTracker(parameters.tracking_tolerance_bpm,
                                    parameters.tracking_history_length)

    def estimate(self, timestamp_s: float, hr_samples: np.ndarray,
                 breathing_samples: np.ndarray, hrv_samples: np.ndarray,
                 fs: float = SAMPLE_RATE) -> WindowEstimate:
        if not np.isfinite(timestamp_s):
            raise ValueError("Expected a finite event timestamp")
        if fs != SAMPLE_RATE:
            raise ValueError("PROFILE_INCOMPATIBLE: this engine requires 500 Hz")
        # Match live warmup exactly; never pad unavailable history with zeroes.
        if len(hr_samples) < int(10 * fs):
            return WindowEstimate(timestamp_s, None, None, None, None, 0.0, ("hr_warmup",))
        hr_raw, hr_score = subharmonic_summation_hr(hr_samples, fs, min_score=self.parameters.heart_rate_minimum_peak_score)
        hr = self.hr_tracker.update(hr_raw, hr_score)
        br = compute_breathing_rate(breathing_samples, fs, self.parameters)
        hrv = (compute_hrv(hrv_samples, fs, self.parameters)
               if len(hrv_samples) >= int(300 * fs) else None)
        reasons = []
        if hr is None:
            reasons.append("no_hr")
        if br is None:
            reasons.append("no_br")
        if hrv is None:
            reasons.append("hrv_warmup" if len(hrv_samples) < int(300 * fs) else "no_hrv")
        return WindowEstimate(timestamp_s, hr, hrv, br, hr_raw, hr_score, tuple(reasons))
