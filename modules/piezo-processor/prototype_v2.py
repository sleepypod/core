#!/usr/bin/env python3
"""
Prototype v2 piezo processor — literature-informed signal processing.

Run on-pod against live RAW data. Prints results to stdout.

Usage (on pod):
    /opt/sleepypod/modules/piezo-processor/.venv/bin/python prototype_v2.py

Pipeline (per literature):
  - Pump gating: dual-channel energy + 5s guard (Shin et al. IEEE TBME 2009)
  - Presence: hysteresis state machine + autocorr quality (Paalasmaa et al. 2012)
  - HR: 0.8-8.5 Hz bandpass + subharmonic summation autocorrelation (Bruser et al. 2011; Hermes 1988)
  - HR tracking: inter-window Gaussian consistency (Bruser et al. 2011)
  - BR: Hilbert envelope of cardiac band (PMC9354426)
  - HRV: sub-window autocorrelation IBI + Hampel filter (PMC9305910)
"""

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from scipy.signal import butter, sosfiltfilt, hilbert, find_peaks, welch
import cbor2
from common.cbor_raw import read_raw_record

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SAMPLE_RATE = 500.0
HR_WINDOW_S = 30
HRV_WINDOW_S = 300
BR_WINDOW_S = 60

# Pump gating
PUMP_ENERGY_MULTIPLIER = 10.0
PUMP_CORRELATION_MIN = 0.5

# HR band: 0.8 Hz preserves fundamental of 48+ BPM; 8.5 Hz per PMC7582983
HR_BAND = (0.8, 8.5)

# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

def _bandpass(signal, lo, hi, fs, order=4):
    sos = butter(order, [lo, hi], btype='band', fs=fs, output='sos')
    return sosfiltfilt(sos, signal)

# ---------------------------------------------------------------------------
# Pump gating (Shin et al. 2009 — temporal gating with guard period)
# ---------------------------------------------------------------------------

class PumpGate:
    GUARD_S = 5.0

    def __init__(self, fs=SAMPLE_RATE, chunk_s=1.0):
        self.fs = fs
        self.chunk_size = int(chunk_s * fs)
        self._baseline = None

    def build_mask(self, left_arr, right_arr):
        n = min(len(left_arr), len(right_arr))
        mask = np.ones(n, dtype=bool)
        guard = int(self.GUARD_S * self.fs)

        for i in range(0, n - self.chunk_size, self.chunk_size):
            le = float(np.var(left_arr[i:i+self.chunk_size].astype(np.float64)))
            re = float(np.var(right_arr[i:i+self.chunk_size].astype(np.float64)))
            if le == 0 or re == 0:
                continue
            ratio = min(le, re) / max(le, re)
            if self._baseline and self._baseline > 0:
                spike = max(le, re) / self._baseline
                if ratio > PUMP_CORRELATION_MIN and spike > PUMP_ENERGY_MULTIPLIER:
                    mask[i:min(n, i + self.chunk_size + guard)] = False
                    continue
            avg = (le + re) / 2
            if self._baseline is None:
                self._baseline = avg
            elif avg < self._baseline * 3:
                self._baseline = 0.95 * self._baseline + 0.05 * avg
        return mask

# ---------------------------------------------------------------------------
# Presence detection — hysteresis state machine (Paalasmaa et al. 2012)
# ---------------------------------------------------------------------------

def autocorr_quality(signal, fs=SAMPLE_RATE):
    """Peak height of best autocorrelation peak in cardiac range.
    Person → periodic signal → high peak. Empty → noise → low peak."""
    try:
        filtered = _bandpass(signal, 0.8, 8.5, fs)
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
        return float(max(np.max(acr[min_lag:max_lag+1]), 0.0))
    except Exception:
        return 0.0


class PresenceDetector:
    """Hysteresis-based presence with autocorrelation quality."""
    ABSENT = 0
    PRESENT = 1

    def __init__(self):
        self.state = self.ABSENT
        self.consecutive_low = 0
        self.enter_threshold = 400_000
        self.exit_threshold = 150_000
        self.exit_count = 3  # 3 × 60s = 3 min of silence to declare absent
        self.acr_threshold = 0.45  # higher: autocorr on empty side picks up coupling

    def update(self, window_std, acr_qual):
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

def _compute_autocorr(filtered, fs):
    n = len(filtered)
    fft_size = 1
    while fft_size < 2 * n:
        fft_size *= 2
    fft_f = np.fft.rfft(filtered, n=fft_size)
    acr = np.fft.irfft(fft_f * np.conj(fft_f), n=fft_size)[:n]
    if acr[0] == 0:
        return None
    return acr / acr[0]


def subharmonic_summation_hr(samples, fs=SAMPLE_RATE, bpm_range=(45, 120), n_harmonics=3):
    """Subharmonic summation for robust fundamental detection.

    Only scores autocorrelation PEAKS (not every lag) to avoid edge effects
    where long lags accumulate noise. For each candidate peak lag L,
    score = weighted sum of autocorr at L, L/2, L/3.

    Hermes 1988 (JASA), adapted for BCG by Bruser et al. 2011.
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
    peaks, props = find_peaks(search, height=0.02, distance=int(fs * 0.15))
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


# --- Inter-window HR tracking (Bruser et al. 2011) ---

class HRTracker:
    """Physiological rate-of-change constraint across windows.
    HR cannot jump >15 BPM between consecutive 60s windows at rest."""

    def __init__(self, max_delta=15.0, history_len=5):
        self.history = []
        self.max_delta = max_delta
        self.history_len = history_len

    def update(self, hr_candidate, score):
        if hr_candidate is None:
            return None

        if not self.history:
            # First window: prefer resting range
            self.history.append(hr_candidate)
            return hr_candidate

        recent = np.median(self.history[-self.history_len:])
        delta = abs(hr_candidate - recent)

        # Gaussian consistency weight
        consistency = np.exp(-0.5 * (delta / self.max_delta) ** 2)
        # If consistent, accept. If not, check if halving brings it in range
        # (catches residual harmonic escapes)
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
            double_consistency = np.exp(-0.5 * (double_delta / self.max_delta) ** 2)
            if double_consistency > 0.3:
                self.history.append(double_hr)
                return double_hr

        # Accept anyway but flag (don't poison history)
        return hr_candidate


# ---------------------------------------------------------------------------
# Breathing rate — Hilbert envelope (PMC9354426)
# ---------------------------------------------------------------------------

def v2_breathing_rate(samples, fs=SAMPLE_RATE):
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
    except Exception:
        return None


# ---------------------------------------------------------------------------
# HRV — sub-window autocorrelation IBI + Hampel (PMC9305910)
# ---------------------------------------------------------------------------

def v2_hrv(samples, fs=SAMPLE_RATE):
    try:
        filtered = _bandpass(samples, HR_BAND[0], HR_BAND[1], fs)
        sub_window = int(30 * fs)
        ibis = []
        min_lag = int(fs * 60 / 150)
        max_lag = int(fs * 60 / 40)

        for start in range(0, len(filtered) - sub_window, sub_window // 2):  # 50% overlap
            chunk = filtered[start:start + sub_window]
            acr = _compute_autocorr(chunk, fs)
            if acr is None:
                continue
            search = acr[min_lag:min(max_lag, len(acr))]
            if len(search) == 0:
                continue

            # Use SHS for IBI too
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
            return None, "too_few (%d)" % len(ibis)

        ibis = np.array(ibis)
        # Hampel filter
        clean = []
        for i in range(len(ibis)):
            lo = max(0, i - 3)
            hi = min(len(ibis), i + 4)
            local = ibis[lo:hi]
            med = np.median(local)
            mad = max(np.median(np.abs(local - med)), 1e-6)
            if abs(ibis[i] - med) <= 3.0 * 1.4826 * mad:
                clean.append(ibis[i])
        clean = np.array(clean)

        if len(clean) < 3:
            return None, "filtered"
        diffs = np.diff(clean)
        rmssd = float(np.sqrt(np.mean(diffs ** 2)))
        if 5 <= rmssd <= 400:
            return rmssd, "ok (%d ibi)" % len(clean)
        return None, "range (%.1f)" % rmssd
    except Exception as e:
        return None, str(e)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run(raw_file):
    print("=" * 85)
    print("PIEZO PROCESSOR V2 — FINAL PROTOTYPE")
    print("=" * 85)
    print("File: %s" % raw_file.name)
    print("HR band: %.1f-%.1f Hz  |  SHS autocorrelation  |  Hysteresis presence" % HR_BAND)
    print()

    # Load records
    left_all, right_all = [], []
    with open(raw_file, 'rb') as f:
        while True:
            try:
                data = read_raw_record(f)
                if data is None:
                    continue
                rec = cbor2.loads(data)
                if not isinstance(rec, dict) or rec.get('type') != 'piezo-dual':
                    continue
                for key, store in [('left1', left_all), ('right1', right_all)]:
                    raw = rec.get(key)
                    if isinstance(raw, (bytes, bytearray)):
                        n = len(raw) // 4
                        store.extend(struct.unpack('<' + str(n) + 'i', raw[:n * 4]))
            except EOFError:
                break
            except ValueError:
                continue

    left = np.array(left_all, dtype=np.float64)
    right = np.array(right_all, dtype=np.float64)
    dur = min(len(left), len(right)) / SAMPLE_RATE
    print("Duration: %.0fs (%.1f min)  |  L=%d  R=%d samples" % (
        dur, dur / 60, len(left), len(right)))

    # Pump mask
    mask = PumpGate().build_mask(left, right)
    clean_s = np.sum(mask) / SAMPLE_RATE
    dirty_s = (len(mask) - np.sum(mask)) / SAMPLE_RATE
    print("Pump gate: %.0fs clean (%.0f%%), %.0fs rejected" % (
        clean_s, 100 * clean_s / dur, dirty_s))
    print()

    # Process 60s windows
    window = int(60 * SAMPLE_RATE)
    n_win = min(len(left), len(right)) // window

    for side_name, arr, other in [("LEFT (empty)", left, right), ("RIGHT (occupied)", right, left)]:
        print("  %s" % side_name)
        print("  %3s  %7s  %6s  %9s  %5s  %7s  %6s  %s" % (
            "#", "Present", "Std_k", "HR(bpm)", "Score", "BR(bpm)", "Clean", "Notes"))
        print("  " + "-" * 68)

        presence = PresenceDetector()
        tracker = HRTracker()

        for i in range(n_win):
            s = i * window
            chunk_mask = mask[s:s + window]
            clean_pct = 100 * np.sum(chunk_mask) / len(chunk_mask)
            clean = arr[s:s + window][chunk_mask[:len(arr[s:s + window])]]

            if len(clean) < int(10 * SAMPLE_RATE):
                print("  %3d  %7s  %6s  %9s  %5s  %7s  %5.0f%%  %s" % (
                    i, "-", "-", "-", "-", "-", clean_pct, "too short"))
                continue

            # Presence (hysteresis + autocorr quality)
            filt = _bandpass(clean, 1.0, 10.0, SAMPLE_RATE)
            w = int(5 * SAMPLE_RATE)
            stds = [np.var(filt[j:j+w]) for j in range(0, len(filt)-w, w)]
            med_std = float(np.median(stds)) if stds else 0
            acr_q = autocorr_quality(clean)
            pres = presence.update(med_std, acr_q)

            notes = ""
            if not pres:
                print("  %3d  %7s  %5.0fk  %9s  %5s  %7s  %5.0f%%  acr=%.2f" % (
                    i, "no", med_std / 1000, "-", "-", "-", clean_pct, acr_q))
                continue

            # HR via subharmonic summation
            hr_chunk = clean[-int(30 * SAMPLE_RATE):] if len(clean) > int(30 * SAMPLE_RATE) else clean
            hr_raw, hr_score = subharmonic_summation_hr(hr_chunk)

            # Tracking (catches residual harmonics via consistency)
            hr_final = tracker.update(hr_raw, hr_score)
            if hr_raw and hr_final and abs(hr_raw - hr_final) > 1:
                notes = "tracked %.0f->%.0f" % (hr_raw, hr_final)

            # BR
            br = v2_breathing_rate(clean)

            print("  %3d  %7s  %5.0fk  %9s  %5.2f  %7s  %5.0f%%  %s" % (
                i, "YES", med_std / 1000,
                "%.1f" % hr_final if hr_final else "-",
                hr_score,
                "%.1f" % br if br else "-",
                clean_pct,
                notes if notes else "acr=%.2f" % acr_q))

        print()

    # HRV
    print("  --- HRV (5-min, pump-excised) ---")
    hrv_win = int(HRV_WINDOW_S * SAMPLE_RATE)
    for side_name, arr in [("LEFT", left), ("RIGHT", right)]:
        if len(arr) >= hrv_win:
            s = len(arr) - hrv_win
            m = mask[s:s + hrv_win]
            clean = arr[s:s + hrv_win][m[:hrv_win]]
            val, status = v2_hrv(clean)
            print("  %s: %s (%s)" % (
                side_name,
                "%.1f ms RMSSD" % val if val else "-",
                status))

    # Signal summary
    print()
    print("  --- Signal quality (0.8-8.5 Hz, pump-excised) ---")
    for side_name, arr in [("LEFT", left), ("RIGHT", right)]:
        clean = arr[mask[:len(arr)]]
        if len(clean) > int(SAMPLE_RATE):
            filt = _bandpass(clean, HR_BAND[0], HR_BAND[1], SAMPLE_RATE)
            print("  %s: RMS=%.0f  Std=%.0f  P2P=%.0f" % (
                side_name, np.sqrt(np.mean(filt**2)), np.std(filt), np.ptp(filt)))


if __name__ == "__main__":
    if len(sys.argv) > 1:
        target = Path(sys.argv[1])
        if target.is_file():
            run(target)
        else:
            raw_files = sorted(target.glob("*.RAW"), key=lambda p: p.stat().st_mtime, reverse=True)
            raw_files = [f for f in raw_files if f.name != "SEQNO.RAW" and f.stat().st_size > 100_000]
            if len(raw_files) > 0:
                run(raw_files[0])
            else:
                print("No suitable RAW files found.")
                sys.exit(1)
    else:
        raw_dir = Path("/persistent")
        raw_files = sorted(raw_dir.glob("*.RAW"), key=lambda p: p.stat().st_mtime, reverse=True)
        raw_files = [f for f in raw_files if f.name != "SEQNO.RAW" and f.stat().st_size > 100_000]
        if len(raw_files) < 2:
            print("Need at least 2 complete RAW files.")
            sys.exit(1)
        run(raw_files[1])
