#!/usr/bin/env python3
"""
SleepyPod piezo-processor module.

Reads raw piezoelectric sensor data from /persistent/*.RAW (CBOR-encoded),
computes heart rate, HRV, and breathing rate, and writes results to biometrics.db.

One row is written to the `vitals` table approximately every 60 seconds per side
while a user is detected on the pod.

Signal processing pipeline (per side):
  1. Buffer incoming 500 Hz piezo samples into a rolling window
  2. Outlier removal → baseline removal (< 0.05 Hz) → bandpass filter (0.5–20 Hz)
  3. HeartPy peak detection → heart rate (bpm) + HRV (RMSSD, ms)
  4. FFT of low-frequency component (0.15–0.5 Hz) → breathing rate (breaths/min)
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

import cbor2
import numpy as np
from scipy.signal import butter, filtfilt, welch
import heartpy as hp

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RAW_DATA_DIR = Path(os.environ.get("RAW_DATA_DIR", "/persistent"))
BIOMETRICS_DB = Path(os.environ.get("BIOMETRICS_DATABASE_URL", "file:/persistent/sleepypod-data/biometrics.db").replace("file:", ""))
SLEEPYPOD_DB = Path(os.environ.get("DATABASE_URL", "file:/persistent/sleepypod-data/sleepypod.db").replace("file:", ""))

SAMPLE_RATE = 500          # Hz — piezo sensor sample rate
PRESENCE_THRESHOLD = 200_000  # peak-to-peak signal range indicating user presence
VITALS_INTERVAL_S = 60     # write a vitals row every N seconds
HR_WINDOW_S = 30           # seconds of data for heart rate calculation
BREATHING_WINDOW_S = 60    # seconds of data for breathing rate calculation
HRV_WINDOW_S = 300         # seconds of data for HRV (5-minute RMSSD)

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
        conn.close()
    except Exception as e:
        log.warning("Could not write health status: %s", e)

# ---------------------------------------------------------------------------
# Signal processing
# ---------------------------------------------------------------------------

def _bandpass(signal: np.ndarray, lo: float, hi: float, fs: float) -> np.ndarray:
    nyq = fs / 2
    b, a = butter(4, [lo / nyq, hi / nyq], btype="band")
    return filtfilt(b, a, signal)


def _remove_baseline(signal: np.ndarray, fs: float) -> np.ndarray:
    """Remove low-frequency wander (< 0.05 Hz)."""
    b, a = butter(4, 0.05 / (fs / 2), btype="high")
    return filtfilt(b, a, signal)


def _remove_outliers(signal: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(signal, [0.2, 99.8])
    clipped = np.clip(signal, lo, hi)
    return clipped


def _normalize(signal: np.ndarray) -> np.ndarray:
    s_min, s_max = signal.min(), signal.max()
    if s_max == s_min:
        return np.zeros_like(signal, dtype=float)
    return (signal - s_min) / (s_max - s_min) * 1024


def is_present(signal: np.ndarray) -> bool:
    return float(np.ptp(signal)) > PRESENCE_THRESHOLD


def compute_heart_rate_hrv(samples: np.ndarray, fs: float = SAMPLE_RATE):
    """Return (heart_rate_bpm, hrv_rmssd_ms) or (None, None) on failure."""
    try:
        cleaned = _normalize(_remove_baseline(_bandpass(_remove_outliers(samples), 0.5, 20.0, fs), fs))
        wd, m = hp.process(cleaned, sample_rate=fs)
        hr = float(m["bpm"]) if np.isfinite(m["bpm"]) else None
        hrv = float(m["rmssd"]) if np.isfinite(m["rmssd"]) else None
        return hr, hrv
    except Exception as e:
        log.debug("HR/HRV computation failed: %s", e)
        return None, None


def compute_breathing_rate(samples: np.ndarray, fs: float = SAMPLE_RATE) -> Optional[float]:
    """Breathing rate via FFT of the 0.15–0.5 Hz band."""
    try:
        cleaned = _bandpass(samples, 0.15, 0.5, fs)
        freqs, psd = welch(cleaned, fs=fs, nperseg=min(len(cleaned), fs * 10))
        mask = (freqs >= 0.15) & (freqs <= 0.5)
        if not np.any(mask):
            return None
        dominant_freq = freqs[mask][np.argmax(psd[mask])]
        return float(dominant_freq * 60)  # Hz → breaths/min
    except Exception as e:
        log.debug("Breathing rate computation failed: %s", e)
        return None

# ---------------------------------------------------------------------------
# RAW file follower
# ---------------------------------------------------------------------------

class RawFileFollower:
    """
    Follows the newest .RAW file in RAW_DATA_DIR, tailing it as new CBOR
    records are appended by the hardware daemon.
    """

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self._file = None
        self._path = None

    def _find_latest(self) -> Optional[Path]:
        candidates = sorted(self.data_dir.glob("*.RAW"), key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates[0] if candidates else None

    def read_records(self):
        """Yield decoded CBOR records as they arrive. Blocks between records."""
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
                # No new data yet — poll
                time.sleep(0.01)
            except Exception as e:
                log.warning("Error reading RAW record: %s", e)
                time.sleep(1)

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
        if not is_present(hr_arr):
            return  # No user detected — skip

        hr, _ = compute_heart_rate_hrv(hr_arr)
        _, hrv = compute_heart_rate_hrv(np.array(self._hrv_buf))
        br = compute_breathing_rate(np.array(self._br_buf))

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
    log.info("Starting piezo-processor (biometrics.db=%s)", BIOMETRICS_DB)

    if not BIOMETRICS_DB.parent.exists():
        log.error("Biometrics DB directory does not exist: %s", BIOMETRICS_DB.parent)
        sys.exit(1)

    db_conn = open_biometrics_db()
    left = SideProcessor("left", db_conn)
    right = SideProcessor("right", db_conn)
    follower = RawFileFollower(RAW_DATA_DIR)

    report_health("healthy", "piezo-processor started")

    try:
        for record in follower.read_records():
            if record.get("type") != "piezo-dual":
                continue

            # Each record contains ~500 int32 samples per channel
            # Use the primary channel (left1, right1) for processing
            l_samples = np.frombuffer(record.get("left1", b""), dtype=np.int32)
            r_samples = np.frombuffer(record.get("right1", b""), dtype=np.int32)

            if l_samples.size > 0:
                left.ingest(l_samples)
            if r_samples.size > 0:
                right.ingest(r_samples)

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        db_conn.close()
        report_health("down", "piezo-processor stopped")
        log.info("Shutdown complete")


if __name__ == "__main__":
    main()
