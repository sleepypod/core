"""
Tests for sleep-detector. Runs on developer Mac without pod-only deps —
cbor2 / common.raw_follower / common.health are stubbed before importing main.
Covers ts sanitization (#327) and DB write resilience (#325).
"""

import sqlite3
import sys
from datetime import datetime, timezone
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

import main  # noqa: E402
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


def _make_db():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """CREATE TABLE sleep_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            side TEXT, entered_bed_at INTEGER, left_bed_at INTEGER,
            sleep_duration_seconds INTEGER, times_exited_bed INTEGER,
            present_intervals TEXT, not_present_intervals TEXT,
            created_at INTEGER
        )"""
    )
    conn.execute(
        """CREATE TABLE movement (
            side TEXT, timestamp INTEGER, total_movement INTEGER,
            PRIMARY KEY (side, timestamp)
        )"""
    )
    return conn


class _FailingConn:
    """Connection that always raises OperationalError on execute."""

    def __init__(self):
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, *a, **k):
        raise sqlite3.OperationalError("disk I/O error")

    def close(self):
        self.closed = True


class TestWriteMovementResilience:
    def test_happy_path_inserts_row(self):
        holder = main.DBHolder(_make_db())
        main._db_write_failures = 0
        wrote = main.write_movement(holder, "left",
                                    datetime.now(timezone.utc), 42)
        assert wrote is True
        rows = holder.conn.execute("SELECT * FROM movement").fetchall()
        assert len(rows) == 1

    def test_sqlite_error_swallowed(self):
        main._db_write_failures = 0
        holder = main.DBHolder(_FailingConn())
        # Should not raise
        wrote = main.write_movement(holder, "left",
                                    datetime.now(timezone.utc), 42)
        assert wrote is False

    def test_reconnect_after_threshold(self, monkeypatch):
        replaced = []

        def fake_open():
            replaced.append(1)
            return _make_db()

        main._db_write_failures = 0
        monkeypatch.setattr(main, "open_biometrics_db", fake_open)
        holder = main.DBHolder(_FailingConn())
        for _ in range(main._DB_RECONNECT_THRESHOLD):
            main.write_movement(holder, "left",
                                datetime.now(timezone.utc), 42)
        assert len(replaced) == 1
        assert main._db_write_failures == 0
        # Both trackers would now see the swapped connection.
        assert holder.conn is not None


class TestWriteSleepRecordResilience:
    def test_happy_path_inserts_row(self):
        holder = main.DBHolder(_make_db())
        main._db_write_failures = 0
        entered = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
        left = datetime.fromtimestamp(1_700_028_800, tz=timezone.utc)
        wrote = main.write_sleep_record(
            holder, "left", entered, left, 28_800, 2, [[1, 2]], [[3, 4]],
        )
        assert wrote is True
        rows = holder.conn.execute("SELECT * FROM sleep_records").fetchall()
        assert len(rows) == 1

    def test_sqlite_error_swallowed(self):
        main._db_write_failures = 0
        entered = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
        left = datetime.fromtimestamp(1_700_028_800, tz=timezone.utc)
        # Should not raise
        wrote = main.write_sleep_record(
            main.DBHolder(_FailingConn()), "left", entered, left, 28_800, 0, [], [],
        )
        assert wrote is False

    def test_reconnect_after_threshold(self, monkeypatch):
        replaced = []

        def fake_open():
            replaced.append(1)
            return _make_db()

        main._db_write_failures = 0
        monkeypatch.setattr(main, "open_biometrics_db", fake_open)
        entered = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
        left = datetime.fromtimestamp(1_700_028_800, tz=timezone.utc)

        holder = main.DBHolder(_FailingConn())
        for _ in range(main._DB_RECONNECT_THRESHOLD):
            main.write_sleep_record(
                holder, "left", entered, left, 28_800, 0, [], [],
            )
        assert len(replaced) == 1
        assert main._db_write_failures == 0


class TestSharedConnectionHolder:
    """Both SessionTrackers read connections from one DBHolder so reconnect
    on either side automatically updates the other's view (no orphaned
    handles after a reconnect)."""

    def test_reconnect_swaps_holder_observed_by_both_trackers(self, monkeypatch):
        original = _make_db()
        replacement = _make_db()
        opens = iter([replacement])
        monkeypatch.setattr(main, "open_biometrics_db", lambda: next(opens))

        holder = main.DBHolder(original)
        main._reconnect_db(holder)

        assert holder.conn is replacement
        # The original closed-handle is no longer referenced by the holder, so
        # any tracker reading from holder.conn observes the live connection.


class TestPumpGatePerSide:
    """Gating both beds whenever EITHER pump ran zeroed real movement on the
    idle side for the whole pump runtime, under-counting the movement table.
    Signal 1 (RPM) and Signal 3 (guard period) are now per-side; cross-side
    mechanical coupling remains covered by Signal 2 (correlated ref-anomaly)."""

    def _frz(self, left_rpm, right_rpm):
        return {
            "type": "frzHealth",
            "left": {"pumpRpm": left_rpm},
            "right": {"pumpRpm": right_rpm},
        }

    def test_only_running_side_is_gated(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state(self._frz(left_rpm=3000, right_rpm=0))

        assert gate.is_gated({}, "left") is True
        assert gate.is_gated({}, "right") is False

    def test_both_sides_gated_when_both_pumps_run(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state(self._frz(left_rpm=3000, right_rpm=2800))

        assert gate.is_gated({}, "left") is True
        assert gate.is_gated({}, "right") is True

    def test_guard_period_applies_per_side(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state(self._frz(left_rpm=3000, right_rpm=0))
        # Left pump turns off → left enters its guard period; right never ran.
        gate.update_pump_state(self._frz(left_rpm=0, right_rpm=0))

        assert gate.is_gated({}, "left") is True, "guard period must gate the side that ran"
        assert gate.is_gated({}, "right") is False, "idle side must not inherit the guard"

    def test_no_pumps_no_gate(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state(self._frz(left_rpm=0, right_rpm=0))

        assert gate.is_gated({}, "left") is False
        assert gate.is_gated({}, "right") is False


def _tracker():
    """A SessionTracker wired to an in-memory DB. calibration/pump_gate are
    unused by _update, so None is sufficient for presence/session tests."""
    holder = main.DBHolder(_make_db())
    main._db_write_failures = 0
    return main.SessionTracker(side="left", db=holder,
                               calibration=None, pump_gate=None)


def _feed(t, samples):
    """Feed (ts, present) pairs through _update with zero movement."""
    for ts, present in samples:
        t._update(ts, present, 0.0)


def _rows(t):
    return t.db.conn.execute(
        "SELECT sleep_duration_seconds, times_exited_bed FROM sleep_records"
    ).fetchall()


class TestPresenceDebounce:
    """Pod 88 field debug 2026-06-10: brief capSense dropouts fragmented one
    overnight presence span into dozens of <15min sleep_records with 66-109
    bogus bed-exits and runaway durations. Presence is now debounced."""

    def test_brief_dropout_does_not_increment_exit_or_split_session(self):
        t = _tracker()
        base = 1_777_000_000.0
        samples = []
        # Establish committed presence (sustain past PRESENCE_DEBOUNCE_S).
        samples += [(base, True), (base + 31, True)]
        # 8h in bed at 2 Hz would be huge; sample sparsely but inject many
        # sub-debounce dropouts — each a single absent sample immediately
        # followed by present. None should commit a flip.
        ts = base + 31
        for _ in range(50):
            ts += 60
            samples.append((ts, False))   # brief dropout
            samples.append((ts + 1, True))  # back within 1s — under debounce
        # Real morning exit: sustained absence past debounce + absence timeout.
        exit_ts = ts + 3600
        samples.append((exit_ts, False))
        samples.append((exit_ts + 31, False))   # commits absent flip → 1 exit
        samples.append((exit_ts + 200, False))  # > ABSENCE_TIMEOUT_S → close
        _feed(t, samples)

        rows = _rows(t)
        assert len(rows) == 1
        duration_s, exits = rows[0]
        assert exits == 1
        # One continuous span: duration ~ (exit_ts - base), well over an hour.
        assert duration_s >= 3600

    def test_sustained_absence_counts_single_exit(self):
        t = _tracker()
        base = 1_777_000_000.0
        samples = [(base, True), (base + 31, True)]
        # Genuine bed-exit: absence sustained past debounce, then past the
        # absence timeout so the session closes on that one exit.
        leave = base + 4000
        samples += [(leave, False), (leave + 31, False), (leave + 200, False)]
        _feed(t, samples)

        rows = _rows(t)
        assert len(rows) == 1
        _duration, exits = rows[0]
        assert exits == 1

    def test_runaway_session_is_capped(self):
        t = _tracker()
        base = 1_777_000_000.0
        samples = [(base, True), (base + 31, True)]
        # Presence that never goes absent for > MAX_SESSION_S of wall-clock.
        ts = base + 31
        while ts < base + main.MAX_SESSION_S + 7200:
            ts += 600
            samples.append((ts, True))
        _feed(t, samples)

        rows = _rows(t)
        assert len(rows) >= 1
        # No row exceeds the hard cap.
        for duration_s, _exits in rows:
            assert duration_s <= main.MAX_SESSION_S
