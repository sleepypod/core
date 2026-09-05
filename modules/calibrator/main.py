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
    CapCalibrator, CapSense2Calibrator, PiezoCalibrator, TempCalibrator,
)
from common.cbor_raw import read_raw_record
from common.dialect import log_capsense_status_once
from common.nats_follower import NatsFollowerError, NatsRecordBuffer, wait_for_nats
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

CAL_SIDES = ("left", "right")
CAL_SENSOR_TYPES = ("capacitance", "piezo", "temperature")
# How often to re-attempt still-missing/failed profiles. On a NATS-only pod
# the live buffer starts empty, so the first capacitance/piezo attempt fails
# ("No capSense records available"); it must retry as samples accrue rather
# than persist that one-shot failure until the next process restart.
CAL_RETRY_INTERVAL_S = 60

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


def load_recent_records(hours: int = 6, buffer=None) -> dict:
    """Load recent CBOR records for calibration.

    On a NATS-only pod (``buffer`` is a live ``NatsRecordBuffer``) there are no
    ``.RAW`` files to scan and core NATS has no backfill, so we return a
    snapshot of the bounded live buffer instead. Otherwise we scan ``.RAW``
    files (sorted newest first), stopping when records are older than the
    cutoff. Does NOT use RawFileFollower (which tails live data and would
    hang/spin on stale files).
    """
    if buffer is not None:
        snap = buffer.snapshot()
        records = {"capSense": [], "capSense2": [], "piezo-dual": [], "bedTemp": [], "bedTemp2": []}
        for rtype in records:
            records[rtype] = list(snap.get(rtype, []))
        return records

    cutoff = time.time() - hours * 3600
    records: dict = {"capSense": [], "capSense2": [], "piezo-dual": [], "bedTemp": [], "bedTemp2": []}

    # Find all RAW files, newest first
    raw_files = sorted(RAW_DATA_DIR.glob("*.RAW"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not raw_files:
        return records

    for raw_path in raw_files:
        if _shutdown.is_set():
            break
        # Skip files older than our window (mtime is a rough filter)
        if raw_path.stat().st_mtime < cutoff - 3600:
            break

        try:
            with open(raw_path, "rb") as f:
                while not _shutdown.is_set():
                    try:
                        data_bytes = read_raw_record(f)
                        if data_bytes is None:
                            continue
                        inner = cbor2.loads(data_bytes)
                        ts = float(inner.get("ts", 0))
                        if ts < cutoff:
                            continue
                        rtype = inner.get("type", "")
                        if rtype in records:
                            records[rtype].append(inner)
                    except EOFError:
                        break
                    except (ValueError, cbor2.CBORDecodeError) as e:
                        log.debug("Skipping corrupt record in %s: %s", raw_path.name, e)
                        continue
        except OSError as e:
            log.warning("Failed to read %s: %s", raw_path.name, e)

    return records


# ---------------------------------------------------------------------------
# Calibration runner
# ---------------------------------------------------------------------------


def run_calibration(store: CalibrationStore, side: str, sensor_type: str,
                    triggered_by: str, buffer=None) -> bool:
    """Run calibration for a specific sensor type and side.

    ``buffer`` (a live ``NatsRecordBuffer``) selects the NATS record source on
    new-firmware pods; None keeps the ``.RAW`` scan path.
    """
    log.info("Starting %s calibration for %s (triggered: %s)",
             sensor_type, side, triggered_by)

    store.mark_running(side, sensor_type)
    start_ms = int(time.time() * 1000)

    try:
        if sensor_type == "capacitance":
            records = load_recent_records(hours=6, buffer=buffer)
            # Record (do not gate on) new-firmware capSense per-side status —
            # the future quiet-window suppression gate needs this evidence.
            for rec in records["capSense"]:
                log_capsense_status_once(rec, "calibrator")
            # Auto-detect hardware: prefer capSense2 (Pod 5) over capSense (Pod 3)
            if records["capSense2"]:
                calibrator = CapSense2Calibrator()
                result = calibrator.calibrate(records["capSense2"], side)
            else:
                calibrator = CapCalibrator()
                result = calibrator.calibrate(records["capSense"], side)

        elif sensor_type == "piezo":
            records = load_recent_records(hours=6, buffer=buffer)
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


def compute_pending(store: CalibrationStore, now: float) -> set:
    """Return the set of (side, sensor_type) whose profile is missing or
    expired and therefore still needs (re)calibration."""
    pending = set()
    for side in CAL_SIDES:
        for sensor_type in CAL_SENSOR_TYPES:
            profile = store.get_active(side, sensor_type)
            needs = profile is None
            if profile and profile.get("expires_at"):
                needs = profile["expires_at"] < now
            if needs:
                pending.add((side, sensor_type))
    return pending


def run_pending_calibrations(store: CalibrationStore, now: float,
                             triggered_by: str, buffer=None) -> set:
    """Attempt every missing/expired profile once, then report what remains.

    A failed attempt (e.g. an empty live buffer right after boot) leaves the
    profile missing, so it stays in the returned set and the caller retries it
    on the next tick — the one-shot startup failure never persists until the
    next process restart.
    """
    pending = compute_pending(store, now)
    for side, sensor_type in sorted(pending):
        run_calibration(store, side, sensor_type, triggered_by, buffer=buffer)
    return compute_pending(store, time.time())


def should_run_daily(store: CalibrationStore, now: float, last_run: float) -> bool:
    """Fallback daily calibration if scheduler trigger didn't fire.

    The primary trigger is the jobManager's pre-prime-calibration job
    (30min before pod priming). This fallback only fires if no calibration
    has run in the last 25 hours — covers the case where priming is disabled.

    Gated on PERSISTED profile age, not just the in-memory last_run:
    last_run starts at 0 on every process start, so without the persisted
    check every restart re-ran a full recalibration. Also restricted to the
    DAILY_HOUR UTC window so the fallback fires at the configured quiet hour
    instead of whenever the process happens to (re)start.
    """
    if now - last_run < 25 * 3600:
        return False
    if time.gmtime(now).tm_hour != DAILY_HOUR:
        return False
    for side in ("left", "right"):
        for sensor_type in ("capacitance", "piezo", "temperature"):
            age = store.get_profile_age_hours(side, sensor_type)
            if age is None or age >= 25:
                return True
    return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    log.info("Starting calibrator (db=%s, raw=%s)", BIOMETRICS_DB, RAW_DATA_DIR)

    store = CalibrationStore(BIOMETRICS_DB)
    watcher = CalibrationWatcher()

    # Select the record source once at startup (no mid-flight switching). On a
    # new-firmware pod NATS is reachable, so start a bounded live collector the
    # batch calibrators read from; otherwise stay on the .RAW scan path.
    nats_buffer = None
    if wait_for_nats(_shutdown):
        log.info("NATS reachable — collecting live sensor records for calibration")
        nats_buffer = NatsRecordBuffer(_shutdown)
        nats_buffer.start()
    else:
        log.info("NATS not reachable — calibrating from .RAW scans (%s)", RAW_DATA_DIR)

    # Attempt startup calibration for missing/expired profiles. `remaining` is
    # what still needs a profile; on a fresh NATS buffer that is everything,
    # and the retry loop below fills them in as samples accrue.
    now = time.time()
    remaining = run_pending_calibrations(store, now, "startup", buffer=nats_buffer)
    last_retry = time.time()
    daily_last_run = 0.0

    try:
        while not _shutdown.is_set():
            # A dead NATS collector must not leave us calibrating a stale
            # buffer forever — exit so systemd restarts and re-probes.
            if nats_buffer is not None:
                nats_buffer.raise_if_fatal()

            # Check on-demand trigger
            trigger = watcher.check_trigger()
            if trigger:
                t_side = trigger.get("side", "all")
                t_type = trigger.get("sensor_type", "all")

                sides = CAL_SIDES if t_side == "all" else (t_side,)
                types = CAL_SENSOR_TYPES if t_type == "all" else (t_type,)

                for s in sides:
                    for st in types:
                        run_calibration(store, s, st, triggered_by="manual",
                                        buffer=nats_buffer)

                watcher.clear_trigger()
                remaining = compute_pending(store, time.time())

            # Check daily schedule
            now = time.time()
            if should_run_daily(store, now, daily_last_run):
                log.info("Running daily calibration")
                for side in CAL_SIDES:
                    for st in CAL_SENSOR_TYPES:
                        run_calibration(store, side, st, triggered_by="daily",
                                        buffer=nats_buffer)
                daily_last_run = now
                remaining = compute_pending(store, time.time())

            # Retry any still-missing/failed profiles as samples accrue.
            now = time.time()
            if remaining and now - last_retry >= CAL_RETRY_INTERVAL_S:
                last_retry = now
                remaining = run_pending_calibrations(store, now, "retry",
                                                     buffer=nats_buffer)
                if not remaining:
                    log.info("All calibration profiles now present")

            _shutdown.wait(timeout=10)  # poll every 10s

    except NatsFollowerError as e:
        log.error("NATS collector lost (%s) — exiting for systemd restart/re-probe", e)
        sys.exit(1)
    except Exception as e:
        log.exception("Fatal error: %s", e)
        sys.exit(1)
    finally:
        store.close()
        log.info("Shutdown complete")


if __name__ == "__main__":
    main()
