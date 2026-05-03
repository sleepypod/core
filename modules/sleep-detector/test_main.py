"""
Tests for sleep-detector. Runs on developer Mac without pod-only deps —
cbor2 / common.raw_follower / common.health are stubbed before importing main.
"""

import sys
from unittest.mock import patch

# Stub pod-only modules so `import main` works on dev machines.
_stubs = {
    "cbor2": type(sys)("cbor2"),
    "common": type(sys)("common"),
    "common.raw_follower": type(sys)("common.raw_follower"),
    "common.calibration": type(sys)("common.calibration"),
    "common.health": type(sys)("common.health"),
}
_stubs["common.raw_follower"].RawFileFollower = None
_stubs["common.calibration"].CalibrationStore = None
_stubs["common.calibration"].is_present_capsense_calibrated = lambda *a, **kw: False
_stubs["common.calibration"].is_present_capsense2_calibrated = lambda *a, **kw: False
_stubs["common.health"].report_health = lambda *a, **kw: None
sys.modules.update(_stubs)

from main import sanitize_ts, MIN_VALID_WALL_CLOCK_TS  # noqa: E402


class TestSanitizeTs:
    """sleep_records id=30 had entered_bed_at=3 (1970-01-01 00:00:03 UTC).
    Root cause: a fresh RAW file post-restart can carry tiny relative ts
    values; the prior code passed them straight through to
    datetime.fromtimestamp() and persisted them as entered_bed_at."""

    def test_passes_through_valid_wall_clock(self):
        valid = 1777731963.0  # 2026-05-02 14:26 UTC
        assert sanitize_ts(valid) == valid

    def test_substitutes_wall_clock_when_ts_is_pre_2020_sentinel(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(3.0) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_zero(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(0) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_negative(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(-100) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_missing(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(None) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_not_a_number(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts("notanumber") == 1777731963.0

    def test_threshold_boundary(self):
        # Exactly at 2020-01-01 should be considered valid (>=).
        assert sanitize_ts(MIN_VALID_WALL_CLOCK_TS) == MIN_VALID_WALL_CLOCK_TS

    def test_just_below_threshold_is_replaced(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(MIN_VALID_WALL_CLOCK_TS - 1) == 1777731963.0

    def test_real_observed_bug_value(self):
        """The exact value (ts=3) found in sleep_records id=30 on the pod
        on 2026-03-21 — must be sanitized."""
        sentinel_now = 1700000000.0  # arbitrary post-2020 wall-clock
        with patch("main.time.time", return_value=sentinel_now):
            result = sanitize_ts(3.0)
            assert result == sentinel_now
            # Sanity: result is a real wall-clock value, not 1970-era.
            assert result >= MIN_VALID_WALL_CLOCK_TS

    def test_handles_int_input(self):
        valid_int = 1777731963
        assert sanitize_ts(valid_int) == float(valid_int)

    def test_substitutes_wall_clock_when_ts_is_nan(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(float("nan")) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_positive_inf(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(float("inf")) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_negative_inf(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(float("-inf")) == 1777731963.0
