#!/usr/bin/env python3
"""
SleepyPod calibrator module.

Runs sensor calibration either on a daily schedule or on-demand (triggered
by the iOS app via tRPC → trigger file IPC). Computes baselines for:
  - Capacitance sensors (per-channel mean+std for presence detection)
  - Piezo sensors (noise floor RMS for presence threshold)
  - Temperature sensors (per-thermistor offsets vs ambient reference)

Writes results to calibration_profiles and calibration_runs tables in
biometrics.db. Processing modules (piezo-processor, sleep-detector,
environment-monitor) read these profiles to apply calibrated thresholds.

See docs/adr/0014-sensor-calibration.md for architecture rationale.
"""

import os
import sys
import time
import signal
import logging
import sqlite3
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.calibration import (
    CalibrationStore, CalibrationWatcher,
    CapCalibrator, PiezoCalibrator, TempCalibrator,
)
from common.raw_follower import RawFileFollower
import cbor2

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RAW_DATA_DIR = Path(os.environ.get("RAW_DATA_DIR", "/persistent"))
BIOMETRICS_DB = Path(os.environ.get(
    "BIOMETRICS_DATABASE_URL",
    "file:/persistent/sleepypod-data/biometrics.db",
).replace("file:", ""))
DAILY_HOUR = int(os.environ.get("CALIBRATION_HOUR", "6"))  # 06:00 UTC

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [calibrator] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------

_shutdown = threading.Event()


def _on_signal(signum, _frame):
    log.info("Received signal %d, shutting down...", signum)
    _shutdown.set()


signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)

# ---------------------------------------------------------------------------
# RAW data loading
# ---------------------------------------------------------------------------


def load_recent_records(hours: int = 6) -> dict:
    """Load recent CBOR records from RAW files, grouped by type."""
    cutoff = time.time() - hours * 3600
    records = {"capSense": [], "piezo-dual": [], "bedTemp": []}

    follower = RawFileFollower(RAW_DATA_DIR, _shutdown, poll_interval=0)

    for record in follower.read_records():
        if _shutdown.is_set():
            break
        ts = float(record.get("ts", 0))
        if ts < cutoff:
            continue
        rtype = record.get("type", "")
        if rtype in records:
            records[rtype].append(record)

        # Stop after processing all available data (follower would block waiting for new)
        # We only want historical data, not to tail the file
        if ts > time.time() - 5:
            break

    return records


# ---------------------------------------------------------------------------
# Calibration runner
# ---------------------------------------------------------------------------


def run_calibration(store: CalibrationStore, side: str, sensor_type: str,
                    triggered_by: str) -> bool:
    """Run calibration for a specific sensor type and side."""
    log.info("Starting %s calibration for %s (triggered: %s)",
             sensor_type, side, triggered_by)

    store.mark_running(side, sensor_type)
    start_ms = int(time.time() * 1000)

    try:
        if sensor_type == "capacitance":
            records = load_recent_records(hours=6)
            calibrator = CapCalibrator()
            result = calibrator.calibrate(records["capSense"], side)

        elif sensor_type == "piezo":
            records = load_recent_records(hours=6)
            calibrator = PiezoCalibrator()
            result = calibrator.calibrate(records["piezo-dual"], side)

        elif sensor_type == "temperature":
            db_conn = sqlite3.connect(str(BIOMETRICS_DB), timeout=5.0)
            db_conn.row_factory = sqlite3.Row
            try:
                calibrator = TempCalibrator()
                result = calibrator.calibrate(db_conn, side)
            finally:
                db_conn.close()
        else:
            raise ValueError(f"Unknown sensor type: {sensor_type}")

        duration_ms = int(time.time() * 1000) - start_ms

        store.upsert_profile(
            side, sensor_type, result.params, result.quality_score,
            result.window_start, result.window_end, result.samples_used,
        )
        store.record_run(
            side, sensor_type, "completed", result.params,
            result.quality_score, result.window_start, result.window_end,
            result.samples_used, duration_ms, triggered_by,
        )

        log.info("✓ %s/%s calibration complete (quality=%.2f, samples=%d, %dms)",
                 side, sensor_type, result.quality_score, result.samples_used, duration_ms)
        return True

    except Exception as e:
        duration_ms = int(time.time() * 1000) - start_ms
        store.mark_failed(side, sensor_type, str(e))
        store.record_run(
            side, sensor_type, "failed", None, None,
            0, 0, 0, duration_ms, triggered_by, str(e),
        )
        log.warning("✗ %s/%s calibration failed: %s", side, sensor_type, e)
        return False


def should_run_daily(now: float, last_run: float) -> bool:
    """Check if daily calibration should run (once per day at DAILY_HOUR UTC)."""
    if now - last_run < 3600:  # at most once per hour
        return False
    import datetime
    hour = datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc).hour
    return hour == DAILY_HOUR


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    log.info("Starting calibrator (db=%s, raw=%s)", BIOMETRICS_DB, RAW_DATA_DIR)

    store = CalibrationStore(BIOMETRICS_DB)
    watcher = CalibrationWatcher()

    # Run startup calibration for any sensor type that has no active profile
    for side in ("left", "right"):
        for sensor_type in ("capacitance", "piezo", "temperature"):
            if store.get_active(side, sensor_type) is None:
                run_calibration(store, side, sensor_type, triggered_by="startup")

    daily_last_run = 0.0

    try:
        while not _shutdown.is_set():
            # Check on-demand trigger
            trigger = watcher.check_trigger()
            if trigger:
                t_side = trigger.get("side", "all")
                t_type = trigger.get("sensor_type", "all")

                sides = ("left", "right") if t_side == "all" else (t_side,)
                types = ("capacitance", "piezo", "temperature") if t_type == "all" else (t_type,)

                for s in sides:
                    for st in types:
                        run_calibration(store, s, st, triggered_by="manual")

                watcher.clear_trigger()

            # Check daily schedule
            now = time.time()
            if should_run_daily(now, daily_last_run):
                log.info("Running daily calibration")
                for side in ("left", "right"):
                    for st in ("capacitance", "piezo", "temperature"):
                        run_calibration(store, side, st, triggered_by="daily")
                daily_last_run = now

            _shutdown.wait(timeout=10)  # poll every 10s

    except Exception as e:
        log.exception("Fatal error: %s", e)
        sys.exit(1)
    finally:
        store.close()
        log.info("Shutdown complete")


if __name__ == "__main__":
    main()
