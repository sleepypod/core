"""Tests for the calibrator's daily-run gate.

Regression: should_run_daily used only the in-memory last_run (0.0 at process
start) and ignored DAILY_HOUR, so every process restart triggered a full
recalibration regardless of how fresh the persisted profiles were.
"""

import calendar
import sys
import time

# Stub pod-only imports so this test runs on a developer machine.
_cbor2_stub = type(sys)("cbor2")
sys.modules.setdefault("cbor2", _cbor2_stub)

import main  # noqa: E402
from main import DAILY_HOUR, should_run_daily  # noqa: E402


def _ts_at_hour(hour: int) -> float:
    """Epoch seconds for today at the given UTC hour."""
    t = time.gmtime()
    return calendar.timegm((t.tm_year, t.tm_mon, t.tm_mday, hour, 30, 0, 0, 0, 0))


class FakeStore:
    def __init__(self, ages):
        # ages: dict of (side, sensor_type) -> Optional[float]
        self.ages = ages

    def get_profile_age_hours(self, side, sensor_type):
        return self.ages.get((side, sensor_type), None)


def _fresh_ages(hours=1.0):
    return {
        (side, st): hours
        for side in ("left", "right")
        for st in ("capacitance", "piezo", "temperature")
    }


class TestShouldRunDaily:
    def test_fresh_profiles_do_not_rerun_on_restart(self):
        """The core regression: last_run=0 (fresh process) + fresh persisted
        profiles must NOT trigger a recalibration."""
        now = _ts_at_hour(DAILY_HOUR)
        store = FakeStore(_fresh_ages(hours=2.0))
        assert should_run_daily(store, now, last_run=0.0) is False

    def test_stale_profiles_run_within_daily_hour(self):
        now = _ts_at_hour(DAILY_HOUR)
        store = FakeStore(_fresh_ages(hours=30.0))
        assert should_run_daily(store, now, last_run=0.0) is True

    def test_missing_profile_counts_as_stale(self):
        now = _ts_at_hour(DAILY_HOUR)
        ages = _fresh_ages(hours=1.0)
        del ages[("right", "piezo")]
        store = FakeStore(ages)
        assert should_run_daily(store, now, last_run=0.0) is True

    def test_stale_profiles_wait_for_daily_hour(self):
        """Outside the DAILY_HOUR window the fallback must not fire, even
        with stale profiles — restarts at arbitrary times stay quiet."""
        other_hour = (DAILY_HOUR + 3) % 24
        now = _ts_at_hour(other_hour)
        store = FakeStore(_fresh_ages(hours=30.0))
        assert should_run_daily(store, now, last_run=0.0) is False

    def test_recent_in_process_run_short_circuits(self):
        """A run in the last 25h suppresses the fallback without consulting
        the store."""
        now = _ts_at_hour(DAILY_HOUR)

        class ExplodingStore:
            def get_profile_age_hours(self, side, sensor_type):
                raise AssertionError("store must not be queried")

        assert should_run_daily(ExplodingStore(), now, last_run=now - 3600) is False

    def test_single_stale_sensor_triggers_run(self):
        now = _ts_at_hour(DAILY_HOUR)
        ages = _fresh_ages(hours=1.0)
        ages[("left", "temperature")] = 26.0
        store = FakeStore(ages)
        assert should_run_daily(store, now, last_run=0.0) is True


from main import (  # noqa: E402
    CAL_SIDES,
    CAL_SENSOR_TYPES,
    compute_pending,
    load_recent_records,
    run_pending_calibrations,
)


class ProfileStore:
    """Minimal calibration store exposing get_active for pending computation."""

    def __init__(self, now):
        self._now = now
        self.profiles = {}  # (side, sensor_type) -> profile dict

    def get_active(self, side, sensor_type):
        return self.profiles.get((side, sensor_type))

    def complete(self, side, sensor_type):
        self.profiles[(side, sensor_type)] = {"expires_at": self._now + 100000}

    def expire(self, side, sensor_type):
        self.profiles[(side, sensor_type)] = {"expires_at": self._now - 1}


_ALL = {(s, st) for s in CAL_SIDES for st in CAL_SENSOR_TYPES}


class TestComputePending:
    def test_empty_store_marks_everything_pending(self):
        now = time.time()
        assert compute_pending(ProfileStore(now), now) == _ALL

    def test_completed_profile_is_not_pending(self):
        now = time.time()
        store = ProfileStore(now)
        store.complete("left", "capacitance")
        pending = compute_pending(store, now)
        assert ("left", "capacitance") not in pending
        assert len(pending) == len(_ALL) - 1

    def test_expired_profile_is_pending(self):
        now = time.time()
        store = ProfileStore(now)
        store.expire("right", "piezo")
        assert ("right", "piezo") in compute_pending(store, now)


class TestRunPendingCalibrations:
    def test_startup_failure_persists_then_clears_on_retry(self, monkeypatch):
        """A one-shot empty-buffer failure at startup must NOT stick until the
        next process restart — the item stays pending and later succeeds."""
        now = time.time()
        store = ProfileStore(now)
        samples = {"ready": False}

        def fake_run(store_, side, st, triggered_by, buffer=None):
            if not samples["ready"]:
                return False  # buffer empty — calibration raises/fails
            store_.complete(side, st)
            return True

        monkeypatch.setattr(main, "run_calibration", fake_run)

        # Startup: nothing calibratable yet → everything still pending.
        remaining = run_pending_calibrations(store, now, "startup")
        assert remaining == _ALL

        # Samples accrue → the retry clears all pending profiles.
        samples["ready"] = True
        remaining = run_pending_calibrations(store, time.time(), "retry")
        assert remaining == set()

    def test_only_unfilled_profiles_remain_pending(self, monkeypatch):
        now = time.time()
        store = ProfileStore(now)
        # Temperature succeeds (DB-backed); capacitance/piezo still starved.
        ok = {("left", "temperature"), ("right", "temperature")}

        def fake_run(store_, side, st, triggered_by, buffer=None):
            if (side, st) in ok:
                store_.complete(side, st)
                return True
            return False

        monkeypatch.setattr(main, "run_calibration", fake_run)
        remaining = run_pending_calibrations(store, now, "startup")
        assert remaining == _ALL - ok


class TestLoadRecentRecordsBuffer:
    def test_buffer_snapshot_drives_records(self):
        class FakeBuffer:
            def snapshot(self):
                return {"capSense": [{"type": "capSense"}, {"type": "capSense"}],
                        "piezo-dual": [{"type": "piezo-dual"}]}

        recs = load_recent_records(hours=6, buffer=FakeBuffer())
        assert len(recs["capSense"]) == 2
        assert len(recs["piezo-dual"]) == 1
        # Missing types default to empty lists (never KeyError downstream).
        assert recs["capSense2"] == []
        assert recs["bedTemp"] == []
