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
