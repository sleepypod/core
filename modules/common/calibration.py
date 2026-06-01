"""
Shared calibration library for SleepyPod biometrics modules.

Architecture: this library is the single source of truth for all calibration
logic. The calibrator module writes profiles; processing modules read them.
See docs/adr/0014-sensor-calibration.md for rationale.

Provides:
  - CalibrationStore:    read/write calibration profiles from biometrics.db
  - CapCalibrator:       compute capacitance channel baselines from RAW data
  - PiezoCalibrator:     compute piezo noise floor from RAW data
  - TempCalibrator:      compute per-thermistor offset corrections
  - HRValidator:         validate HR/HRV/BR against medical-informed thresholds
  - CalibrationWatcher:  file-watch trigger for on-demand recalibration

Medical threshold citations:
  - HR 30-100 bpm: AHA resting HR guidelines; Circulation (bradycardia in athletes)
  - HRV 8-300ms SDNN: PMC5624990 (Umetani 1998); PMC6932537 (RMSSD preference)
  - BR 6-22: PMC5027356 (respiratory rate during sleep)
  - Presence via noise floor: PMC6522616 (BCG adaptive thresholds)
"""

import json
import math
import os
import sqlite3
import time
import logging
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

log = logging.getLogger("calibration")

# ── Trigger file IPC ──

TRIGGER_PATH = Path(
    os.environ.get("CALIBRATION_TRIGGER_PATH",
                   "/persistent/sleepypod-data/.calibrate-trigger")
)


# ── Data classes ──

@dataclass
class CalibrationResult:
    """Output of a calibration run."""
    params: dict
    quality_score: float  # 0.0–1.0
    window_start: int     # unix ts
    window_end: int       # unix ts
    samples_used: int


@dataclass
class HRValidationResult:
    """Output of HR validation."""
    hr_validated: Optional[float]  # capped/None if rejected
    hrv_validated: Optional[float]
    br_validated: Optional[float]
    quality_score: float           # 0.0–1.0
    flags: list                    # ['low_signal', 'hr_out_of_bounds', ...]
    hr_raw: Optional[float]       # original value before validation


# ── CalibrationStore ──

class CalibrationStore:
    """Read/write interface to calibration tables in biometrics.db.

    NOT thread-safe — uses a single cached SQLite connection without locking.
    Each module should create its own CalibrationStore instance, or use from
    a single thread only.
    """

    def __init__(self, db_path: Path):
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(
                str(self._db_path), timeout=5.0, check_same_thread=False
            )
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
        return self._conn

    def get_active(self, side: str, sensor_type: str) -> Optional[dict]:
        """Return the active calibration profile or None."""
        row = self._get_conn().execute(
            """SELECT * FROM calibration_profiles
               WHERE side=? AND sensor_type=? AND status='completed'
               ORDER BY created_at DESC LIMIT 1""",
            (side, sensor_type),
        ).fetchone()
        return dict(row) if row else None

    def upsert_profile(self, side: str, sensor_type: str,
                       params: dict, quality: float,
                       window_start: int, window_end: int,
                       samples: int) -> int:
        """Insert or update the active calibration profile."""
        now = int(time.time())
        expires = now + 86400 * 2  # 48h expiry
        conn = self._get_conn()
        with conn:
            conn.execute(
                """INSERT INTO calibration_profiles
                   (side, sensor_type, status, parameters, quality_score,
                    source_window_start, source_window_end, samples_used,
                    created_at, expires_at)
                   VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(side, sensor_type) DO UPDATE SET
                     status='completed',
                     parameters=excluded.parameters,
                     quality_score=excluded.quality_score,
                     source_window_start=excluded.source_window_start,
                     source_window_end=excluded.source_window_end,
                     samples_used=excluded.samples_used,
                     error_message=NULL,
                     created_at=excluded.created_at,
                     expires_at=excluded.expires_at""",
                (side, sensor_type, json.dumps(params), quality,
                 window_start, window_end, samples, now, expires),
            )
            return conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    def mark_running(self, side: str, sensor_type: str) -> None:
        """Mark a calibration as in-progress."""
        now = int(time.time())
        conn = self._get_conn()
        with conn:
            conn.execute(
                """INSERT INTO calibration_profiles
                   (side, sensor_type, status, parameters, created_at)
                   VALUES (?, ?, 'running', '{}', ?)
                   ON CONFLICT(side, sensor_type) DO UPDATE SET
                     status='running', created_at=excluded.created_at""",
                (side, sensor_type, now),
            )

    def mark_failed(self, side: str, sensor_type: str, error: str) -> None:
        """Mark a calibration as failed."""
        now = int(time.time())
        conn = self._get_conn()
        with conn:
            conn.execute(
                """INSERT INTO calibration_profiles
                   (side, sensor_type, status, parameters, error_message, created_at)
                   VALUES (?, ?, 'failed', '{}', ?, ?)
                   ON CONFLICT(side, sensor_type) DO UPDATE SET
                     status='failed', error_message=excluded.error_message,
                     created_at=excluded.created_at""",
                (side, sensor_type, error, now),
            )

    def record_run(self, side: str, sensor_type: str, status: str,
                   params: Optional[dict], quality: Optional[float],
                   window_start: int, window_end: int, samples: int,
                   duration_ms: int, triggered_by: str,
                   error: Optional[str] = None) -> None:
        """Append to calibration_runs audit log."""
        conn = self._get_conn()
        with conn:
            conn.execute(
                """INSERT INTO calibration_runs
                   (side, sensor_type, status, parameters, quality_score,
                    source_window_start, source_window_end, samples_used,
                    duration_ms, triggered_by, error_message, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (side, sensor_type, status,
                 json.dumps(params) if params else None, quality,
                 window_start, window_end, samples,
                 duration_ms, triggered_by, error, int(time.time())),
            )

    def get_profile_age_hours(self, side: str, sensor_type: str) -> Optional[float]:
        """Hours since last completed calibration, or None if never calibrated."""
        profile = self.get_active(side, sensor_type)
        if not profile:
            return None
        return (time.time() - profile["created_at"]) / 3600

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None


# ── CapCalibrator ──

class CapCalibrator:
    """Compute per-channel mean+std from empty-bed capacitance data.

    Mirrors free-sleep's calibrate_sensor_thresholds.py but:
    - Stores in DB instead of JSON files
    - Computes quality score
    - Uses configurable lookback and window size
    """

    LOOKBACK_HOURS = 6
    MIN_WINDOW_S = 300       # 5 minutes
    CHANNELS = ("out", "cen", "in")
    MIN_STD = 5.0            # prevent division by zero

    def calibrate(self, records: list, side: str) -> CalibrationResult:
        """
        Given capSense records, find the quietest 5-min window and compute
        per-channel mean+std baselines.
        """
        if not records:
            raise ValueError("No capSense records available for calibration")

        # Extract per-channel time series
        timestamps = []
        channels = {ch: [] for ch in self.CHANNELS}

        for rec in records:
            data = rec.get(side, {})
            if not data:
                continue
            ts = float(rec.get("ts", 0))
            timestamps.append(ts)
            for ch in self.CHANNELS:
                channels[ch].append(int(data.get(ch, 0)))

        if len(timestamps) < 60:
            raise ValueError(f"Insufficient capSense data: {len(timestamps)} samples (need ≥60)")

        # Find quietest 5-minute window (lowest total variance)
        best_start = 0
        best_variance = float("inf")
        window_samples = self.MIN_WINDOW_S  # ~1 sample/sec for capSense

        for i in range(len(timestamps) - window_samples):
            total_var = 0
            for ch in self.CHANNELS:
                segment = channels[ch][i:i + window_samples]
                mean = sum(segment) / len(segment)
                var = sum((x - mean) ** 2 for x in segment) / len(segment)
                total_var += var

            if total_var < best_variance:
                best_variance = total_var
                best_start = i

        # Compute baselines from best window
        window_end = min(best_start + window_samples, len(timestamps))
        baseline = {"channels": {}, "threshold": 6.0}

        for ch in self.CHANNELS:
            segment = channels[ch][best_start:window_end]
            mean = sum(segment) / len(segment)
            std = math.sqrt(sum((x - mean) ** 2 for x in segment) / len(segment))
            std = max(std, self.MIN_STD)
            baseline["channels"][ch] = {"mean": round(mean, 2), "std": round(std, 2)}

        # Quality: lower variance = better baseline (normalize against typical)
        quality = max(0.0, min(1.0, 1.0 - (best_variance / 100000)))

        return CalibrationResult(
            params=baseline,
            quality_score=round(quality, 3),
            window_start=int(timestamps[best_start]),
            window_end=int(timestamps[window_end - 1]),
            samples_used=window_end - best_start,
        )


# ── CapSense2Calibrator ──

class CapSense2Calibrator:
    """Compute per-channel mean+std from empty-bed capacitance data (Pod 5 capSense2).

    capSense2 has 4 paired float channels per side (8 values total):
      - A pair (values[0:2]): highest presence sensitivity
      - B pair (values[2:4]): medium sensitivity
      - C pair (values[4:6]): lowest sensitivity
      - REF pair (values[6:8]): reference/ground, no presence response

    Each pair is redundant (r>0.99), so we average them for noise reduction.
    The REF pair is stored for drift compensation but excluded from
    presence detection.

    See docs/hardware/sensor-profiles.md for channel map and validation data.
    """

    LOOKBACK_HOURS = 6
    MIN_WINDOW_SAMPLES = 300  # ~2.5 min at ~2 Hz sampling rate
    MIN_STD = 0.05       # floats in the tens, not ints in the hundreds
    # Sensing channel pairs: (name, index_a, index_b)
    SENSE_PAIRS = (("A", 0, 1), ("B", 2, 3), ("C", 4, 5))
    REF_PAIR = ("REF", 6, 7)

    def calibrate(self, records: list, side: str) -> CalibrationResult:
        """Find the quietest ~2.5-min window and compute per-channel baselines."""
        if not records:
            raise ValueError("No capSense2 records available for calibration")

        timestamps = []
        channels = {name: [] for name, _, _ in self.SENSE_PAIRS}
        channels["REF"] = []

        for rec in records:
            data = rec.get(side, {})
            vals = data.get("values") if data else None
            if not vals or len(vals) < 8:
                continue
            ts = float(rec.get("ts", 0))
            timestamps.append(ts)
            for name, ia, ib in self.SENSE_PAIRS:
                channels[name].append((vals[ia] + vals[ib]) / 2.0)
            rn, ria, rib = self.REF_PAIR
            channels["REF"].append((vals[ria] + vals[rib]) / 2.0)

        if len(timestamps) < 60:
            raise ValueError(
                f"Insufficient capSense2 data: {len(timestamps)} samples (need >= 60)"
            )

        # Find quietest 5-min window across sensing channels only
        window = min(self.MIN_WINDOW_SAMPLES, len(timestamps))
        best_start = 0
        best_variance = float("inf")
        sense_names = [name for name, _, _ in self.SENSE_PAIRS]

        for i in range(len(timestamps) - window + 1):
            total_var = 0.0
            for name in sense_names:
                seg = channels[name][i:i + window]
                m = sum(seg) / len(seg)
                total_var += sum((x - m) ** 2 for x in seg) / len(seg)
            if total_var < best_variance:
                best_variance = total_var
                best_start = i

        window_end = min(best_start + window, len(timestamps))

        # Compute baselines from best window
        baseline = {"channels": {}, "threshold": 6.0, "format": "capSense2"}

        for name in sense_names:
            seg = channels[name][best_start:window_end]
            m = sum(seg) / len(seg)
            std = math.sqrt(sum((x - m) ** 2 for x in seg) / len(seg))
            std = max(std, self.MIN_STD)
            baseline["channels"][name] = {"mean": round(m, 4), "std": round(std, 4)}

        # Store REF baseline for drift compensation
        ref_seg = channels["REF"][best_start:window_end]
        ref_mean = sum(ref_seg) / len(ref_seg)
        ref_std = math.sqrt(sum((x - ref_mean) ** 2 for x in ref_seg) / len(ref_seg))
        baseline["ref"] = {"mean": round(ref_mean, 4), "std": round(max(ref_std, 0.001), 4)}

        # Quality: lower variance = better baseline
        # capSense2 floats are ~10-30 range, so normalize differently than capSense ints
        quality = max(0.0, min(1.0, 1.0 - (best_variance / 10.0)))

        return CalibrationResult(
            params=baseline,
            quality_score=round(quality, 3),
            window_start=int(timestamps[best_start]),
            window_end=int(timestamps[window_end - 1]),
            samples_used=window_end - best_start,
        )


# ── PiezoCalibrator ──

class PiezoCalibrator:
    """Compute RMS noise floor and presence threshold from empty-bed piezo data.

    Presence threshold is set to 6× the noise floor RMS, ensuring ambient
    vibration (HVAC, etc.) is below threshold. Per PMC6522616, adaptive
    thresholds based on variance outperform fixed thresholds for BCG sensors.
    """

    NOISE_MULTIPLIER = 6  # threshold = N × noise_floor_rms
    MIN_WINDOW_S = 300    # 5 minutes at 500Hz = 150,000 samples

    def calibrate(self, records: list, side: str) -> CalibrationResult:
        """
        Given piezo-dual records, find the quietest 5-min window and compute
        the RMS noise floor.
        """
        if not records:
            raise ValueError("No piezo records available for calibration")

        # Collect peak-to-peak ranges per record (each record is ~1s of 500Hz data)
        timestamps = []
        ranges = []

        key = f"{side}1"  # primary piezo channel
        for rec in records:
            raw = rec.get(key)
            if raw is None:
                continue
            # Handle both bytes buffers (production) and lists (tests)
            if isinstance(raw, (bytes, bytearray)):
                import struct as _struct
                count = len(raw) // 4
                if count == 0:
                    continue
                samples = list(_struct.unpack(f'<{count}i', raw[:count * 4]))
            elif isinstance(raw, list):
                samples = raw
            else:
                continue
            if not samples:
                continue
            ts = float(rec.get("ts", 0))
            timestamps.append(ts)
            p2p = max(samples) - min(samples)
            ranges.append(p2p)

        if len(ranges) < 60:
            raise ValueError(f"Insufficient piezo data: {len(ranges)} records (need ≥60)")

        # Find quietest window (use available data if < MIN_WINDOW_S records)
        window = min(self.MIN_WINDOW_S, len(ranges))
        best_start = 0
        best_mean_range = float("inf")

        for i in range(len(ranges) - window + 1):
            segment = ranges[i:i + window]
            mean_range = sum(segment) / len(segment)
            if mean_range < best_mean_range:
                best_mean_range = mean_range
                best_start = i

        window_end = min(best_start + window, len(ranges))
        segment = ranges[best_start:window_end]

        # Compute RMS of the baseline segment
        rms = math.sqrt(sum(x ** 2 for x in segment) / len(segment))
        threshold = int(max(50000, rms * self.NOISE_MULTIPLIER))

        params = {
            "noise_floor_rms": round(rms, 2),
            "presence_threshold": threshold,
            "baseline_mean_range": round(best_mean_range, 2),
        }

        # Quality: how cleanly the baseline sits below the presence threshold.
        # Self-scaling against threshold (rather than a fixed constant) keeps the
        # metric meaningful regardless of ADC range — raw int32 piezo values run
        # in the 1e8–1e9 range, where a fixed 50k denominator clamps to 0.
        quality = max(0.0, min(1.0, 1.0 - (best_mean_range / max(threshold, 1.0))))

        return CalibrationResult(
            params=params,
            quality_score=round(quality, 3),
            window_start=int(timestamps[best_start]),
            window_end=int(timestamps[window_end - 1]),
            samples_used=window_end - best_start,
        )


# ── TempCalibrator ──

class TempCalibrator:
    """Compute per-thermistor offset corrections from ambient reference.

    Reads the last 24h of bed_temp from biometrics.db. For each zone
    thermistor, computes offset = zone_mean - ambient_mean. These offsets
    are subtracted from raw readings to normalize against the ambient reference.
    """

    LOOKBACK_HOURS = 24
    ZONES = ("left_outer_temp", "left_center_temp", "left_inner_temp",
             "right_outer_temp", "right_center_temp", "right_inner_temp")

    def calibrate(self, db_conn: sqlite3.Connection, side: str) -> CalibrationResult:
        """Compute temperature offsets from recent bed_temp data."""
        cutoff = int(time.time()) - self.LOOKBACK_HOURS * 3600

        rows = db_conn.execute(
            "SELECT * FROM bed_temp WHERE timestamp > ? ORDER BY timestamp",
            (cutoff,),
        ).fetchall()

        if len(rows) < 10:
            raise ValueError(f"Insufficient temp data: {len(rows)} rows (need ≥10)")

        # Compute ambient mean as reference
        ambient_vals = [r["ambient_temp"] for r in rows if r["ambient_temp"] is not None]
        if not ambient_vals:
            raise ValueError("No ambient temperature readings")
        ambient_mean = sum(ambient_vals) / len(ambient_vals)

        # Compute per-zone offsets (only for the requested side)
        prefix = f"{side}_"
        offsets = {}
        for zone in self.ZONES:
            if not zone.startswith(prefix):
                continue
            vals = [r[zone] for r in rows if r[zone] is not None]
            if vals:
                zone_mean = sum(vals) / len(vals)
                offsets[zone] = round(zone_mean - ambient_mean, 1)
            else:
                offsets[zone] = 0

        params = {"offsets": offsets, "ambient_mean": round(ambient_mean, 1)}

        # Quality: more data = better calibration
        quality = min(1.0, len(rows) / 1000)

        ts_start = rows[0]["timestamp"] if rows else cutoff
        ts_end = rows[-1]["timestamp"] if rows else int(time.time())

        return CalibrationResult(
            params=params,
            quality_score=round(quality, 3),
            window_start=ts_start,
            window_end=ts_end,
            samples_used=len(rows),
        )


# ── HRValidator ──

class HRValidator:
    """Validate and score heart rate readings against medical-informed thresholds.

    Thresholds are based on clinical literature:
    - HR 30-100 bpm: AHA resting HR; Circulation (athlete bradycardia, REM tachycardia)
    - HRV 8-100ms: window-level BCG HRV >100 is artifact (see #221)
    - BR 6-22: PMC5027356 (respiratory rate variability in sleeping adults)
    - Dynamic bounds: P10-P90 over 300 samples per PMC6522616 (BCG adaptive thresholds)
    """

    # Hard physiological caps (always enforced)
    HR_HARD_MIN = 30.0    # bpm — athletes can drop this low (Circulation, AHA)
    HR_HARD_MAX = 100.0   # bpm — above = tachycardia per AHA definition
    HRV_HARD_MIN = 8.0    # ms — below = likely artifact
    HRV_HARD_MAX = 100.0  # ms — window-level BCG HRV >100 is artifact (see #221)
    BR_HARD_MIN = 6.0     # breaths/min — below = bradypnea (PMC5027356)
    BR_HARD_MAX = 22.0    # breaths/min — above during sleep = likely artifact

    # Dynamic bounds window
    WINDOW_SIZE = 300     # 5 min at ~1 reading/sec
    LOWER_PERCENTILE = 10  # P10
    UPPER_PERCENTILE = 90  # P90

    def __init__(self, store: Optional["CalibrationStore"] = None, side: str = "left"):
        self._store = store
        self._side = side
        self._recent_hrs: deque = deque(maxlen=self.WINDOW_SIZE)
        self._piezo_profile: Optional[dict] = None
        self._last_profile_check = 0.0

    def _maybe_reload_profile(self) -> None:
        """Reload piezo calibration profile every 60s."""
        now = time.time()
        if self._store and now - self._last_profile_check > 60:
            self._last_profile_check = now
            profile = self._store.get_active(self._side, "piezo")
            if profile:
                self._piezo_profile = json.loads(profile["parameters"]) if isinstance(profile["parameters"], str) else profile["parameters"]

    def _get_dynamic_bounds(self) -> tuple:
        """Compute P10-P90 bounds from recent valid readings."""
        if len(self._recent_hrs) < 30:
            return self.HR_HARD_MIN, self.HR_HARD_MAX

        sorted_hrs = sorted(self._recent_hrs)
        n = len(sorted_hrs)
        lo = sorted_hrs[max(0, int(n * self.LOWER_PERCENTILE / 100))]
        hi = sorted_hrs[min(n - 1, int(n * self.UPPER_PERCENTILE / 100))]

        # Ensure minimum range of 15 bpm to handle stage transitions
        if hi - lo < 15:
            mid = (hi + lo) / 2
            lo = mid - 7.5
            hi = mid + 7.5

        return max(self.HR_HARD_MIN, lo), min(self.HR_HARD_MAX, hi)

    def validate(self, hr: Optional[float], hrv: Optional[float] = None,
                 br: Optional[float] = None,
                 signal_rms: Optional[float] = None) -> HRValidationResult:
        """
        Apply hard caps, dynamic bounds, and signal quality to produce
        a validated reading and quality score.

        Quality score weights (per ADR):
          - Signal quality (SNR vs calibrated noise floor): 0.40
          - HR in-bounds confidence: 0.30
          - Calibration freshness: 0.15
          - HRV/BR plausibility: 0.15
        """
        self._maybe_reload_profile()

        flags = []
        hr_raw = hr
        hr_out = hr
        hrv_out = hrv
        br_out = br

        # ── HR validation ──
        if hr is not None:
            if hr < self.HR_HARD_MIN or hr > self.HR_HARD_MAX:
                flags.append("hr_out_of_bounds")
                hr_out = None
            else:
                lo, hi = self._get_dynamic_bounds()
                if hr < lo or hr > hi:
                    flags.append("hr_dynamic_bounds")
                    # Don't reject — just flag and lower quality
                self._recent_hrs.append(hr)

        # ── HRV validation ──
        if hrv is not None:
            if hrv < self.HRV_HARD_MIN or hrv > self.HRV_HARD_MAX:
                flags.append("hrv_out_of_bounds")
                hrv_out = None

        # ── BR validation ──
        if br is not None:
            if br < self.BR_HARD_MIN or br > self.BR_HARD_MAX:
                flags.append("br_out_of_bounds")
                br_out = None

        # ── Signal quality component (0.40 weight) ──
        signal_component = 0.5  # default if no calibration
        if signal_rms is not None and self._piezo_profile:
            noise_floor = self._piezo_profile.get("noise_floor_rms", 1)
            if noise_floor > 0:
                snr = signal_rms / noise_floor
                signal_component = max(0.0, min(1.0, snr / 10.0))
                if snr < 3.0:
                    flags.append("low_signal")

        # ── HR bounds component (0.30 weight) ──
        bounds_component = 0.0
        if hr_out is not None:
            if "hr_dynamic_bounds" not in flags:
                bounds_component = 1.0
            else:
                bounds_component = 0.5  # in hard bounds but outside dynamic
        elif hr is None:
            bounds_component = 0.0  # no reading at all

        # ── Calibration freshness component (0.15 weight) ──
        freshness_component = 0.3  # default if uncalibrated
        if self._store:
            age = self._store.get_profile_age_hours(self._side, "piezo")
            if age is not None:
                # Full freshness < 12h, linear decay to 0 at 48h
                freshness_component = max(0.0, min(1.0, 1.0 - (age - 12) / 36))

        # ── HRV/BR plausibility component (0.15 weight) ──
        plausibility_component = 0.5
        plausible_count = 0
        total_count = 0
        if hrv is not None:
            total_count += 1
            if hrv_out is not None:
                plausible_count += 1
        if br is not None:
            total_count += 1
            if br_out is not None:
                plausible_count += 1
        if total_count > 0:
            plausibility_component = plausible_count / total_count

        # ── Composite quality score ──
        quality = (
            0.40 * signal_component
            + 0.30 * bounds_component
            + 0.15 * freshness_component
            + 0.15 * plausibility_component
        )

        return HRValidationResult(
            hr_validated=hr_out,
            hrv_validated=hrv_out,
            br_validated=br_out,
            quality_score=round(quality, 3),
            flags=flags,
            hr_raw=hr_raw,
        )


# ── Presence detection helpers ──

def is_present_capsense_calibrated(
    record: dict, side: str, baselines: Optional[dict],
    fallback_threshold: int = 1500,
) -> bool:
    """Z-score based presence detection using calibrated baselines.

    Falls back to simple sum threshold if no calibration available.
    """
    data = record.get(side, {})
    if not data:
        return False

    if baselines is None:
        total = int(data.get("out", 0)) + int(data.get("cen", 0)) + int(data.get("in", 0))
        return total > fallback_threshold

    z_sum = 0.0
    channels = baselines.get("channels", {})
    for ch in ("out", "cen", "in"):
        val = int(data.get(ch, 0))
        ch_cal = channels.get(ch, {})
        std = ch_cal.get("std", 1)
        mean = ch_cal.get("mean", 0)
        if std > 0:
            z_sum += abs((val - mean) / std)

    threshold = baselines.get("threshold", 6.0)
    return z_sum > threshold


def is_present_capsense2_calibrated(
    record: dict, side: str, baselines: Optional[dict],
    fallback_threshold: float = 60.0,
) -> bool:
    """Z-score based presence detection for capSense2 (Pod 5).

    Uses the averaged A/B/C channel pairs against calibrated baselines.
    Falls back to raw sum threshold if no calibration available.
    """
    data = record.get(side, {})
    vals = data.get("values") if data else None
    if not vals or len(vals) < 8:
        return False

    if baselines is None or baselines.get("format") != "capSense2":
        # Uncalibrated or mismatched profile — fall back to raw sum threshold
        total = sum((vals[i] + vals[i + 1]) / 2.0 for i in (0, 2, 4))
        return total > fallback_threshold

    z_sum = 0.0
    channels = baselines.get("channels", {})
    sense_pairs = (("A", 0, 1), ("B", 2, 3), ("C", 4, 5))
    for name, ia, ib in sense_pairs:
        val = (vals[ia] + vals[ib]) / 2.0
        ch_cal = channels.get(name, {})
        std = ch_cal.get("std", 0.05)
        mean = ch_cal.get("mean", 0)
        if std > 0:
            z_sum += abs((val - mean) / std)

    threshold = baselines.get("threshold", 6.0)
    return z_sum > threshold


def is_present_piezo_calibrated(
    signal_range: int, calibration: Optional[dict],
    fallback_threshold: int = 200_000,
) -> bool:
    """Presence detection using calibrated piezo noise floor."""
    if calibration is None:
        return signal_range > fallback_threshold
    return signal_range > calibration.get("presence_threshold", fallback_threshold)


# ── CalibrationWatcher ──

class CalibrationWatcher:
    """Watch for calibration trigger files written by tRPC.

    Trigger files are written atomically (write to .tmp then rename) to
    prevent partial reads. Multiple concurrent triggers are queued as
    separate files (TRIGGER_PATH.{ts}) and processed in order.
    """

    def check_trigger(self) -> Optional[dict]:
        """Return the oldest pending trigger payload, or None."""
        try:
            # Check for queued triggers (*.trigger files)
            trigger_dir = TRIGGER_PATH.parent
            triggers = sorted(trigger_dir.glob(".calibrate-trigger*"))
            triggers = [t for t in triggers if not t.suffix == ".tmp"]
            if not triggers:
                return None
            data = json.loads(triggers[0].read_text())
            return data
        except (json.JSONDecodeError, OSError):
            # Corrupt trigger file — remove it
            try:
                triggers[0].unlink(missing_ok=True)
            except (OSError, UnboundLocalError):
                pass
            return None

    def clear_trigger(self) -> None:
        """Delete the oldest trigger file after calibration completes."""
        try:
            trigger_dir = TRIGGER_PATH.parent
            triggers = sorted(trigger_dir.glob(".calibrate-trigger*"))
            triggers = [t for t in triggers if not t.suffix == ".tmp"]
            if triggers:
                triggers[0].unlink(missing_ok=True)
        except OSError:
            pass


def write_trigger_atomic(payload: dict) -> None:
    """Write a calibration trigger file atomically.

    Uses write-to-tmp-then-rename to prevent partial reads.
    Each trigger gets a unique filename to support queuing.
    """
    ts = int(time.time() * 1000)
    target = TRIGGER_PATH.parent / f".calibrate-trigger.{ts}"
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload))
    tmp.rename(target)
