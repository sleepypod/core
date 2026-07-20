"""Tests for environment-monitor sentinel filtering (#325).

Verifies that freezer temperature records with disconnected-sensor sentinel
values are not inserted into the freezer_temp table as valid readings.
"""

import sqlite3
import sys

# Stub pod-only imports so this test runs on a developer machine.
_cbor2_stub = type(sys)("cbor2")
_common_stub = type(sys)("common")
_raw_follower_stub = type(sys)("common.raw_follower")
_raw_follower_stub.RawFileFollower = None
_nats_follower_stub = type(sys)("common.nats_follower")
_nats_follower_stub.create_follower = None
_dialect_stub = type(sys)("common.dialect")
# Pass-through stub: tests use already-normalized records, so identity is fine.
_dialect_stub.normalize_bed_temp = lambda record, *a, **kw: record
_dialect_stub.KNOWN_RECORD_TYPES = frozenset()
_dialect_stub.warn_unknown_type_once = lambda *a, **kw: None
sys.modules.setdefault("cbor2", _cbor2_stub)
sys.modules.setdefault("common", _common_stub)
sys.modules.setdefault("common.raw_follower", _raw_follower_stub)
sys.modules.setdefault("common.nats_follower", _nats_follower_stub)
sys.modules.setdefault("common.dialect", _dialect_stub)

from main import (  # noqa: E402
    _safe_freezer_centidegrees,
    sanitize_ts,
    write_freezer_temp,
    write_bed_temp,
    MAX_FUTURE_SKEW_S,
    MIN_VALID_WALL_CLOCK_TS,
    NO_SENSOR,
)


def _make_db():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """CREATE TABLE freezer_temp (
            timestamp INTEGER PRIMARY KEY,
            ambient_temp INTEGER,
            heatsink_temp INTEGER,
            left_water_temp INTEGER,
            right_water_temp INTEGER
        )"""
    )
    conn.execute(
        """CREATE TABLE bed_temp (
            timestamp INTEGER PRIMARY KEY,
            ambient_temp INTEGER,
            mcu_temp INTEGER,
            humidity INTEGER,
            left_outer_temp INTEGER,
            left_center_temp INTEGER,
            left_inner_temp INTEGER,
            right_outer_temp INTEGER,
            right_center_temp INTEGER,
            right_inner_temp INTEGER
        )"""
    )
    return conn


class TestSafeFreezerCentidegrees:
    """Sentinel + range filter for raw u16 centidegree values."""

    def test_none_returns_none(self):
        assert _safe_freezer_centidegrees(None) is None

    def test_sentinel_32768_rejected(self):
        """0x8000 interpreted as u16 — disconnected sensor."""
        assert _safe_freezer_centidegrees(32768) is None

    def test_sentinel_65535_rejected(self):
        """0xffff — firmware read error."""
        assert _safe_freezer_centidegrees(65535) is None

    def test_sentinel_negative_32768_rejected(self):
        """Two's-complement view of 0x8000."""
        assert _safe_freezer_centidegrees(-32768) is None

    def test_sentinel_minus_one_rejected(self):
        assert _safe_freezer_centidegrees(-1) is None

    def test_valid_room_temp(self):
        assert _safe_freezer_centidegrees(2500) == 2500  # 25 °C

    def test_valid_cold_water(self):
        assert _safe_freezer_centidegrees(1500) == 1500  # 15 °C

    def test_out_of_range_high_rejected(self):
        assert _safe_freezer_centidegrees(15000) is None  # 150 °C

    def test_out_of_range_low_rejected(self):
        assert _safe_freezer_centidegrees(-6000) is None  # -60 °C

    def test_non_numeric_rejected(self):
        assert _safe_freezer_centidegrees("oops") is None
        assert _safe_freezer_centidegrees([1, 2]) is None


class TestWriteFreezerTempFiltering:
    """write_freezer_temp must drop sentinel values before insertion (#325)."""

    def test_all_valid_inserts_row(self):
        conn = _make_db()
        record = {"amb": 2500, "hs": 3500, "left": 1200, "right": 1300}
        write_freezer_temp(conn, 1_700_000_000, record)
        rows = conn.execute("SELECT * FROM freezer_temp").fetchall()
        assert len(rows) == 1
        assert rows[0][1:] == (2500, 3500, 1200, 1300)

    def test_all_sentinel_skips_row(self):
        conn = _make_db()
        record = {"amb": 32768, "hs": 32768, "left": 32768, "right": 32768}
        write_freezer_temp(conn, 1_700_000_000, record)
        rows = conn.execute("SELECT * FROM freezer_temp").fetchall()
        assert len(rows) == 0, "row with all-sentinel values must be skipped"

    def test_mixed_sentinel_inserts_nulls(self):
        conn = _make_db()
        record = {"amb": 2500, "hs": 32768, "left": 1200, "right": 65535}
        write_freezer_temp(conn, 1_700_000_000, record)
        rows = conn.execute("SELECT * FROM freezer_temp").fetchall()
        assert len(rows) == 1
        # amb=2500, hs=None (sentinel), left=1200, right=None (sentinel)
        assert rows[0][1:] == (2500, None, 1200, None)

    def test_out_of_range_inserts_null(self):
        conn = _make_db()
        record = {"amb": 2500, "hs": 99999, "left": 1200, "right": 1300}
        write_freezer_temp(conn, 1_700_000_000, record)
        rows = conn.execute("SELECT * FROM freezer_temp").fetchall()
        assert len(rows) == 1
        assert rows[0][2] is None, "out-of-range heatsink must be NULL"


class TestSanitizeTs:
    """Timestamp sanity gate: one far-future ts must not be able to poison
    the MAX(timestamp)-seeded downsample cursors and block all writes."""

    def test_valid_recent_ts_passes_through(self):
        import time
        ts = time.time() - 5
        assert sanitize_ts(ts) == ts

    def test_slight_future_within_skew_passes_through(self):
        import time
        ts = time.time() + MAX_FUTURE_SKEW_S / 2
        assert sanitize_ts(ts) == ts

    def test_far_future_falls_back_to_now(self):
        import time
        before = time.time()
        result = sanitize_ts(before + 10 * 365 * 86400)
        assert before <= result <= time.time() + 1

    def test_pre_2020_falls_back_to_now(self):
        import time
        before = time.time()
        result = sanitize_ts(MIN_VALID_WALL_CLOCK_TS - 1)
        assert before <= result <= time.time() + 1

    def test_missing_falls_back_to_now(self):
        import time
        before = time.time()
        result = sanitize_ts(None)
        assert before <= result <= time.time() + 1

    def test_nan_and_inf_fall_back_to_now(self):
        import time
        for bad in (float("nan"), float("inf"), float("-inf")):
            before = time.time()
            result = sanitize_ts(bad)
            assert before <= result <= time.time() + 1

    def test_non_numeric_falls_back_to_now(self):
        import time
        before = time.time()
        result = sanitize_ts("not-a-timestamp")
        assert before <= result <= time.time() + 1


# NOTE: bed_temp sentinel filtering moved into common.dialect.normalize_bed_temp
# (PR #486) — write_bed_temp now expects canonical centidegrees, not raw
# firmware records. The pre-normalization sentinel test that lived here is no
# longer meaningful at this layer; equivalent coverage belongs in
# common/test_dialect.py.
