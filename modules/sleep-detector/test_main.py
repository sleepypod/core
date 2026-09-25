"""
Tests for sleep-detector. Runs on developer Mac without pod-only deps —
cbor2 / common.raw_follower / common.health are stubbed before importing main.
Covers ts sanitization (#327) and DB write resilience (#325).
"""

import importlib.util
import logging
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

# Stub pod-only modules so `import main` works on dev machines.
_stubs = {
    "cbor2": type(sys)("cbor2"),
    "common": type(sys)("common"),
    "common.raw_follower": type(sys)("common.raw_follower"),
    "common.nats_follower": type(sys)("common.nats_follower"),
    "common.dialect": type(sys)("common.dialect"),
    "common.health": type(sys)("common.health"),
}
_stubs["common.raw_follower"].RawFileFollower = None
_stubs["common.nats_follower"].create_follower = None
_stubs["common.dialect"].KNOWN_RECORD_TYPES = frozenset()
_stubs["common.dialect"].warn_unknown_type_once = lambda *a, **kw: None
_stubs["common.dialect"].log_capsense_status_once = lambda *a, **kw: None
# common.calibration and common.side_mode are stdlib-only, so load the real
# modules rather than stubbing them — the baseline and single-sleeper tests
# depend on their behaviour.
for _name in ("calibration", "side_mode"):
    _spec = importlib.util.spec_from_file_location(
        f"common.{_name}", Path(__file__).resolve().parent.parent / "common" / f"{_name}.py")
    _stubs[f"common.{_name}"] = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_stubs[f"common.{_name}"])
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

    def test_captured_nats_nested_health_rpm(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state({
            "type": "frzHealth",
            "left": {"pump": {"mode": "pwm", "rpm": 1868, "water": True}},
            "right": {"pump": {"mode": "pwm", "rpm": 0, "water": True}},
        })
        assert gate.is_gated({}, "left") is True
        assert gate.is_gated({}, "right") is False

    def test_captured_nats_therm_power(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state({
            "type": "frzTherm",
            "left": {"power": 0.024},
            "right": {"power": 0.0},
        })
        assert gate.is_gated({}, "left") is True
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

    def test_consecutive_cap_closes_warn_and_escalate(self, caplog):
        # Trinity field report 2026-08: back-to-back rows of exactly
        # MAX_SESSION_S meant a stuck presence signal, silently. The cap
        # must surface itself, and two in a row must escalate.
        t = _tracker()
        base = 1_777_000_000.0
        samples = [(base, True), (base + 31, True)]
        ts = base + 31
        while ts < base + 2 * main.MAX_SESSION_S + 7200:
            ts += 600
            samples.append((ts, True))
        with caplog.at_level(logging.WARNING):
            _feed(t, samples)

        caps = [r for r in caplog.records if "force-closed" in r.getMessage()]
        assert len(caps) >= 2
        stuck = [r for r in caplog.records if "stuck-occupied" in r.getMessage()]
        assert len(stuck) >= 1

    def test_natural_exit_resets_cap_close_streak(self, caplog):
        t = _tracker()
        base = 1_777_000_000.0
        samples = [(base, True), (base + 31, True)]
        # Close precisely at the cap, then explicitly start a new session.
        ts = base + 31 + main.MAX_SESSION_S
        samples.append((ts, True))
        restart = ts + 600
        samples += [(restart, True), (restart + 31, True)]
        leave = restart + 60
        samples += [(leave, False), (leave + 31, False), (leave + 200, False)]
        # Back in bed and past the cap once more.
        back = leave + 400
        samples += [(back, True), (back + 31, True)]
        ts = back + 31
        while ts < back + main.MAX_SESSION_S + 3600:
            ts += 600
            samples.append((ts, True))
        with caplog.at_level(logging.WARNING):
            _feed(t, samples)

        caps = [r for r in caplog.records if "force-closed" in r.getMessage()]
        assert len(caps) == 2
        assert all("(1 consecutive)" in r.getMessage() for r in caps)
        assert [r for r in caplog.records if "stuck-occupied" in r.getMessage()] == []


def _restart(old, now):
    """Round-trip old's snapshot through JSON into a fresh tracker on the same
    DB — what a service restart or pod reboot does via the state file."""
    import json
    t = main.SessionTracker(side=old.side, db=old.db, calibration=None, pump_gate=None)
    t.restore(json.loads(json.dumps(old.snapshot())), now)
    return t


def _rows_full(t):
    return t.db.conn.execute(
        "SELECT entered_bed_at, left_bed_at, sleep_duration_seconds, times_exited_bed "
        "FROM sleep_records").fetchall()


class TestSessionPersistence:
    """A reboot or restart mid-session used to drop the open session — it
    only lived in memory, so the night never reached sleep_records."""

    BASE = 1_777_000_000.0

    def _asleep(self, hours=6):
        t = _tracker()
        ts = self.BASE
        samples = [(ts, True), (ts + 31, True)]
        while ts < self.BASE + hours * 3600:
            ts += 60
            samples.append((ts, True))
        _feed(t, samples)
        return t, ts

    def test_reboot_mid_sleep_resumes_one_session(self):
        t, ts = self._asleep()
        t = _restart(t, now=ts + 300)          # 5 min reboot, still in bed
        wake = ts + 300 + 2 * 3600
        samples = [(ts + 300 + i * 60, True) for i in range(1, 121)]
        samples += [(wake, False), (wake + 31, False), (wake + 200, False)]
        _feed(t, samples)

        rows = _rows_full(t)
        assert len(rows) == 1
        entered, left_at, duration_s, exits = rows[0]
        assert entered == int(self.BASE)
        assert left_at == int(wake)
        assert exits == 1
        assert duration_s == int(wake - self.BASE)

    def test_left_bed_during_downtime_closes_at_last_presence(self):
        t, ts = self._asleep()
        t = _restart(t, now=ts + 600)          # back up 10 min later, bed empty
        _feed(t, [(ts + 600, False), (ts + 631, False), (ts + 800, False)])

        rows = _rows_full(t)
        assert len(rows) == 1
        _entered, left_at, duration_s, exits = rows[0]
        # Dated at the last pre-restart presence, not the first sample after.
        assert left_at == int(ts)
        assert duration_s == int(ts - self.BASE)
        assert exits == 1

    def test_stale_saved_session_is_closed_not_resumed(self):
        t, ts = self._asleep()
        t = _restart(t, now=ts + main.STATE_MAX_GAP_S + 1)

        rows = _rows_full(t)
        assert len(rows) == 1
        assert rows[0][1] == int(ts)           # closed at last presence
        assert t.snapshot()["session_start"] is None
        assert t.state_dirty is True

    def test_replayed_samples_are_skipped_after_restore(self):
        class _NoCal:
            def get_profile(self, side, force=False):
                return None

        t, ts = self._asleep(hours=1)
        t = _restart(t, now=ts + 60)
        t.calibration = _NoCal()
        t.pump_gate = main.PumpGateCapSense()
        rec = {"type": "capSense", "left": {"out": 1, "cen": 1, "in": 1}}

        t.process(ts - 600, rec)               # replay from the RAW file start
        assert t._last_ts == ts
        t.process(ts, rec)
        assert t._last_ts == ts
        t.process(ts + 1, rec)                 # first genuinely new sample
        assert t._last_ts == ts + 1
        assert t._replay_until_ts is None

    def test_idle_tracker_keeps_cap_close_streak_only(self):
        t = _tracker()
        t._consecutive_cap_closes = 2
        t = _restart(t, now=self.BASE)
        assert t._consecutive_cap_closes == 2
        assert t.snapshot()["session_start"] is None

    def test_corrupt_saved_session_is_ignored(self):
        t = _tracker()
        t.restore({"session_start": "not-a-number"}, now=self.BASE)
        assert t.snapshot()["session_start"] is None
        t.restore(None, now=self.BASE)
        t.restore(["not", "a", "dict"], now=self.BASE)
        assert _rows(t) == []

    def test_session_start_close_and_exit_mark_state_dirty(self):
        t = _tracker()
        _feed(t, [(self.BASE, True), (self.BASE + 31, True)])
        assert t.state_dirty is True
        t.state_dirty = False
        leave = self.BASE + 4000
        _feed(t, [(leave, False), (leave + 31, False)])
        assert t.state_dirty is True            # bed-exit
        t.state_dirty = False
        _feed(t, [(leave + 200, False)])
        assert t.state_dirty is True            # session closed


class TestStateFile:
    def test_round_trip(self, tmp_path):
        t = _tracker()
        _feed(t, [(1_777_000_000.0, True), (1_777_000_031.0, True)])
        path = tmp_path / "state.json"
        assert main.save_state(path, (t,)) is True
        state = main.load_state(path)
        assert state["version"] == main.STATE_VERSION
        assert state["left"]["session_start"] == 1_777_000_000.0
        assert not (tmp_path / "state.json.tmp").exists()

    def test_missing_file_is_empty(self, tmp_path):
        assert main.load_state(tmp_path / "nope.json") == {}

    def test_corrupt_or_foreign_file_is_empty(self, tmp_path):
        path = tmp_path / "state.json"
        path.write_text("{truncated")
        assert main.load_state(path) == {}
        path.write_text('{"version": 999, "left": {}}')
        assert main.load_state(path) == {}
        path.write_text("[1, 2]")
        assert main.load_state(path) == {}

    def test_unwritable_path_reports_failure(self, tmp_path):
        assert main.save_state(tmp_path / "missing-dir" / "state.json", (_tracker(),)) is False


# ---------------------------------------------------------------------------
# Self-adjusting presence baseline
# ---------------------------------------------------------------------------

# Representative empty-bed channel levels of a Pod 4.
EMPTY = {"out": 1142, "cen": 1582, "in": 1673}


def _cap(rise_per_channel=0.0, side="left", ts=None):
    rec = {"type": "capSense",
           side: {ch: int(round(v + rise_per_channel)) for ch, v in EMPTY.items()}}
    if ts is not None:
        rec["ts"] = ts
    return rec


class _Cal:
    """CalibrationCache double: one optional profile, records publishes."""

    def __init__(self, profile=None):
        self.profile = profile
        self.published = []

    def get_profile(self, side, force=False):
        return self.profile

    def publish(self, side, params, window_start, window_end, samples):
        self.published.append(params)
        self.profile = (params, window_end)
        return True


def _live_tracker(cal=None):
    holder = main.DBHolder(_make_db())
    main._db_write_failures = 0
    return main.SessionTracker(side="left", db=holder, calibration=cal or _Cal(),
                               pump_gate=main.PumpGateCapSense())


def _run(t, start, seconds, rise, step=5.0):
    ts = start
    while ts < start + seconds:
        t.process(ts, _cap(rise))
        ts += step
    return ts


def _profile(means, created_at, **extra):
    params = {"format": "capSense", "threshold": 300.0,
              "channels": {ch: {"mean": m, "std": 5.0} for ch, m in means.items()}}
    params.update(extra)
    return (params, created_at)


class TestAdaptiveBaseline:
    T0 = 1_777_000_000.0

    def test_night_in_bed_records_one_session(self):
        t = _live_tracker()
        ts = _run(t, self.T0, 3600, 0)              # empty evening
        ts = _run(t, ts, 8 * 3600, 600)             # asleep: +600/channel
        ts = _run(t, ts, 3600, 0)                   # up
        rows = _rows_full(t)
        assert len(rows) == 1
        entered, left_at, duration_s, exits = rows[0]
        assert abs(entered - (self.T0 + 3600)) <= 10
        assert abs(left_at - (self.T0 + 9 * 3600)) <= 10
        assert exits == 1

    def test_slow_drift_is_absorbed_not_occupied(self):
        # Regression: slow drift and bedding shifts of a few tens of units
        # used to read as occupied, holding sessions open for many hours.
        t = _live_tracker()
        ts = _run(t, self.T0, 600, 0)
        ts = _run(t, ts, 12 * 3600, 33)
        assert _rows(t) == []
        assert t._session_start is None
        assert abs(t.baseline.means["out"] - (EMPTY["out"] + 33)) < 2

    def test_baseline_taken_while_occupied_recovers_on_exit(self):
        # A scheduled calibration captured a sleeper as "empty". Once they get
        # up the reading falls below that level; the fast downward track
        # must find the real empty level so the next night is detected.
        occupied = {ch: v + 600 for ch, v in EMPTY.items()}
        t = _live_tracker(_Cal(_profile(occupied, created_at=self.T0 - 60)))
        ts = _run(t, self.T0, 3 * 3600, 600)        # asleep, reads "empty"
        ts = _run(t, ts, 1800, 0)                   # gets up
        assert abs(t.baseline.means["cen"] - EMPTY["cen"]) < 5
        ts = _run(t, ts, 8 * 3600, 600)             # next night
        ts = _run(t, ts, 600, 0)
        rows = _rows_full(t)
        assert len(rows) == 1
        assert rows[0][2] >= 8 * 3600 - 60

    def test_light_load_below_enter_threshold_is_not_absorbed(self):
        # +80/channel (+240 summed) sits between the exit (150) and enter
        # (300) thresholds: never occupied, and never learned as empty.
        t = _live_tracker()
        ts = _run(t, self.T0, 600, 0)
        ts = _run(t, ts, 4 * 3600, 80)
        assert t._session_start is None
        assert abs(t.baseline.means["out"] - EMPTY["out"]) < 1

    def test_hysteresis_keeps_session_through_partial_dip(self):
        # Once in bed, dipping to +70/channel (+210 summed, above the 150
        # exit) must not end the session.
        t = _live_tracker()
        ts = _run(t, self.T0, 600, 0)
        ts = _run(t, ts, 3600, 600)
        ts = _run(t, ts, 1800, 70)
        ts = _run(t, ts, 3600, 600)
        ts = _run(t, ts, 600, 0)
        rows = _rows_full(t)
        assert len(rows) == 1
        assert rows[0][3] == 1

    def test_object_left_on_bed_resets_after_capped_session(self):
        t = _live_tracker()
        ts = _run(t, self.T0, 600, 0)
        ts = _run(t, ts, main.MAX_SESSION_S + 3600, 400, step=30.0)
        rows = _rows_full(t)
        assert len(rows) == 1
        assert rows[0][2] == main.MAX_SESSION_S
        assert t.baseline.source == "cap-reset"
        assert t._session_start is None             # object is the new empty

    def test_manual_recalibration_is_adopted(self):
        cal = _Cal()
        t = _live_tracker(cal)
        ts = _run(t, self.T0, 600, 0)
        assert t.baseline.source == "bootstrap"
        moved = {ch: v + 40 for ch, v in EMPTY.items()}
        cal.profile = _profile(moved, created_at=ts)
        ts = _run(t, ts, 5, 0)
        assert t.baseline.source == "profile"
        assert t.baseline.means["in"] == EMPTY["in"] + 40

    def test_own_published_profile_is_not_readopted(self):
        cal = _Cal()
        t = _live_tracker(cal)
        ts = _run(t, self.T0, main.BASELINE_PUBLISH_S + 60, 0)
        assert len(cal.published) == 1
        params = cal.published[0]
        assert params["source"] == "adaptive"
        assert params["format"] == "capSense"
        assert set(params["channels"]) == {"out", "cen", "in"}
        _run(t, ts, 60, 0)
        assert t.baseline.source == "bootstrap"

    def test_legacy_profile_seeds_with_raw_unit_threshold(self):
        legacy = ({"threshold": 6.0, "channels": {ch: {"mean": v, "std": 5.0}
                                                   for ch, v in EMPTY.items()}}, self.T0 - 60)
        t = _live_tracker(_Cal(legacy))
        _run(t, self.T0, 60, 0)
        assert t.baseline.threshold == 300.0
        assert t.baseline.source == "profile"

    def test_baseline_survives_restart(self):
        import json
        t = _live_tracker()
        ts = _run(t, self.T0, 3 * 3600, 33)
        t2 = _live_tracker()
        t2.restore(json.loads(json.dumps(t.snapshot())), now=ts)
        assert t2.baseline.source == "state"
        assert t2.baseline.means == t.baseline.means

    def test_gaps_do_not_jump_the_baseline(self):
        t = _live_tracker()
        t.process(self.T0, _cap(0))
        t.process(self.T0 + 7200, _cap(-500))      # 2h gap, one low sample
        # One step is capped at BASELINE_MAX_STEP_S / BASELINE_DOWN_TAU_S.
        moved = EMPTY["out"] - t.baseline.means["out"]
        assert 0 < moved <= 500 * main.BASELINE_MAX_STEP_S / main.BASELINE_DOWN_TAU_S + 1e-6

    def test_unusable_frame_changes_nothing(self):
        t = _live_tracker()
        ts = _run(t, self.T0, 600, 0)
        before = dict(t.baseline.means)
        t.process(ts, {"type": "capSense", "right": {"out": 1}})
        assert t.baseline.means == before
        assert t._session_start is None


class TestAdaptiveBaselineCapSense2:
    T0 = 1_777_000_000.0

    @staticmethod
    def _rec(a, b, c, ref=None, side="left"):
        values = [a, a, b, b, c, c] + ([ref, ref] if ref is not None else [])
        return {"type": "capSense2", side: {"values": values}}

    def test_occupant_detected_and_ref_drift_cancelled(self):
        t = _live_tracker()
        ts = self.T0
        for _ in range(120):                         # empty, ref nominal
            t.process(ts, self._rec(500.0, 600.0, 700.0, ref=1.16)); ts += 5
        for _ in range(360):                         # all channels +10 incl. ref
            t.process(ts, self._rec(510.0, 610.0, 710.0, ref=11.16)); ts += 5
        assert t._session_start is None
        for _ in range(720):                         # occupant +5/pair = +15 > 6
            t.process(ts, self._rec(505.0, 605.0, 705.0, ref=1.16)); ts += 5
        assert t._session_start is not None

    def test_sentinel_frames_do_not_move_baseline(self):
        t = _live_tracker()
        t.process(self.T0, self._rec(500.0, 600.0, 700.0, ref=1.16))
        before = dict(t.baseline.means)
        t.process(self.T0 + 5, self._rec(-1.0, 600.0, 700.0, ref=1.16))
        assert t.baseline.means == before

    def test_published_profile_matches_node_contract(self):
        cal = _Cal()
        t = _live_tracker(cal)
        ts = self.T0
        while ts < self.T0 + main.BASELINE_PUBLISH_S + 60:
            t.process(ts, self._rec(500.0, 600.0, 700.0, ref=1.2)); ts += 5
        params = cal.published[0]
        # src/lib/occupancy.ts requires format, threshold and A/B/C means.
        assert params["format"] == "capSense2"
        assert params["threshold"] == 6.0
        assert {ch: round(v["mean"]) for ch, v in params["channels"].items()} == {"A": 500, "B": 600, "C": 700}
        assert params["ref"]["mean"] == 1.2


class TestSingleSleeper:
    """A solo sleeper on the left who rolls onto the empty right side used
    to open phantom right-side sessions while the left kept reading
    occupied. With the right side in away mode those readings belong to the
    left sleeper's one session."""

    T0 = 1_777_000_000.0

    @staticmethod
    def _pair():
        holder = main.DBHolder(_make_db())
        main._db_write_failures = 0
        mk = lambda side: main.SessionTracker(side=side, db=holder, calibration=_Cal(),
                                              pump_gate=main.PumpGateCapSense(),
                                              # epochs are due relative to sample ts
                                              _last_movement_write=0.0)
        return mk("left"), mk("right")

    @staticmethod
    def _frame(left_rise, right_rise):
        return {"type": "capSense",
                "left": {ch: int(v + left_rise) for ch, v in EMPTY.items()},
                "right": {ch: int(v + right_rise) for ch, v in EMPTY.items()}}

    def _run(self, left, right, start, seconds, lr, rr, merged=True):
        ts = start
        while ts < start + seconds:
            frame = self._frame(lr, rr)
            if merged:
                main.process_single_sleeper(left, right, ts, frame)
            else:
                left.process(ts, frame)
                right.process(ts, frame)
            ts += 5.0
        return ts

    @staticmethod
    def _sessions(t):
        return t.db.conn.execute(
            "SELECT side, entered_bed_at, left_bed_at, times_exited_bed FROM sleep_records"
        ).fetchall()

    def _night(self, merged):
        left, right = self._pair()
        ts = self._run(left, right, self.T0, 600, 0, 0, merged)
        ts = self._run(left, right, ts, 3 * 3600, 600, 0, merged)   # asleep on the left
        ts = self._run(left, right, ts, 3600, 300, 250, merged)     # straddling the middle
        ts = self._run(left, right, ts, 3600, 0, 600, merged)       # fully rolled over
        ts = self._run(left, right, ts, 3600, 600, 0, merged)       # back on the left
        ts = self._run(left, right, ts, 600, 0, 0, merged)          # up
        return left, right, ts

    def test_without_away_mode_the_rollover_opens_a_right_session(self):
        left, _right, _ = self._night(merged=False)
        assert {row[0] for row in self._sessions(left)} == {"left", "right"}

    def test_rollover_merges_into_one_home_session(self):
        left, right, _ = self._night(merged=True)
        rows = self._sessions(left)
        assert len(rows) == 1
        side, entered, left_at, exits = rows[0]
        assert side == "left"
        assert abs(entered - (self.T0 + 600)) <= 10
        assert abs(left_at - (self.T0 + 600 + 6 * 3600)) <= 10
        assert exits == 1                        # only the real morning exit
        assert right._session_start is None

    def test_movement_is_written_to_home_side_only(self):
        left, _right, _ = self._night(merged=True)
        sides = {r[0] for r in left.db.conn.execute("SELECT DISTINCT side FROM movement")}
        assert sides == {"left"}

    def test_session_can_start_on_the_away_side(self):
        left, right = self._pair()
        ts = self._run(left, right, self.T0, 600, 0, 0)
        ts = self._run(left, right, ts, 2 * 3600, 0, 600)            # got in on the right
        ts = self._run(left, right, ts, 600, 0, 0)
        rows = self._sessions(left)
        assert [r[0] for r in rows] == ["left"]

    def test_away_side_baseline_keeps_tracking(self):
        left, right = self._pair()
        self._run(left, right, self.T0, 6 * 3600, 0, 33)             # bedding step on the right
        assert abs(right.baseline.means["out"] - (EMPTY["out"] + 33)) < 2
        assert self._sessions(left) == []

    def test_open_away_side_session_is_closed_when_mode_switches_on(self):
        left, right = self._pair()
        ts = self._run(left, right, self.T0, 600, 0, 0, merged=False)
        ts = self._run(left, right, ts, 3600, 0, 600, merged=False)  # right occupant, per-side
        assert right._session_start is not None
        self._run(left, right, ts, 60, 0, 0, merged=True)             # right set to away
        assert right._session_start is None
        assert [r[0] for r in self._sessions(left)] == ["right"]

    def test_capped_merged_session_resets_both_baselines(self):
        left, right = self._pair()
        ts = self._run(left, right, self.T0, 600, 0, 0)
        ts = self._run(left, right, ts, main.MAX_SESSION_S + 3600, 0, 400)  # load on the away side
        assert right.baseline.source == "cap-reset"
        assert left.baseline.source == "cap-reset"
        assert left._session_start is None


class TestRestartReplay:
    """After a restart the RAW follower replays the current file from offset
    0. Every side must skip what it already processed — including a side
    with no open session, whose frames feed the home session in
    single-sleeper mode."""

    T0 = 1_777_000_000.0

    def _restart_pair(self, left, right, now):
        import json
        holder = left.db
        fresh = []
        for old in (left, right):
            t = main.SessionTracker(side=old.side, db=holder, calibration=_Cal(),
                                    pump_gate=main.PumpGateCapSense(), _last_movement_write=0.0)
            t.restore(json.loads(json.dumps(old.snapshot())), now)
            fresh.append(t)
        return fresh

    def test_single_sleeper_replay_does_not_split_the_night(self):
        s = TestSingleSleeper()
        left, right = s._pair()
        ts = s._run(left, right, self.T0, 600, 0, 0)
        ts = s._run(left, right, ts, 2 * 3600, 600, 0)          # asleep on the home side
        assert right._session_start is None                     # away side: no session
        left, right = self._restart_pair(left, right, now=ts + 60)
        s._run(left, right, ts - 600, 600, 0, 0)                # replay: already-processed timestamps
        ts = s._run(left, right, ts + 60, 3600, 600, 0)         # still asleep
        ts = s._run(left, right, ts, 600, 0, 0)                 # up
        rows = s._sessions(left)
        assert len(rows) == 1
        assert rows[0][3] == 1                                   # only the real morning exit

    def test_sessionless_tracker_skips_replayed_frames(self):
        import json
        t = _live_tracker()
        _run(t, self.T0, 600, 0)
        last = t._last_ts
        t2 = _live_tracker()
        t2.restore(json.loads(json.dumps(t.snapshot())), now=last + 30)
        t2.process(last - 300, _cap(600))
        assert t2._last_ts == last
        assert t2._session_start is None


class TestRestartHysteresis:
    """The per-side occupied latch (exit below half the enter threshold) must
    survive a restart: a reading between the thresholds is occupied only
    because it was already occupied."""

    T0 = 1_777_000_000.0

    def test_between_thresholds_stays_occupied_across_restart(self):
        import json
        t = _live_tracker()
        ts = _run(t, self.T0, 600, 0)
        ts = _run(t, ts, 3600, 600)               # in bed
        ts = _run(t, ts, 1800, 70)                # +210 summed: between exit and enter
        assert t._session_start is not None
        t2 = _live_tracker()
        t2.db = t.db
        t2.restore(json.loads(json.dumps(t.snapshot())), now=ts + 30)
        ts = _run(t2, ts + 30, 3600, 70)          # still there after the restart
        assert t2._session_start is not None
        assert _rows(t2) == []

    def test_latch_restored_for_sessionless_side(self):
        import json
        t = _live_tracker()
        t._level_present = True
        t2 = _live_tracker()
        t2.restore(json.loads(json.dumps(t.snapshot())), now=self.T0)
        assert t2._level_present is True


class TestAdaptiveProfileSeed:
    T0 = 1_777_000_000.0

    def test_own_published_baseline_seeds_when_state_is_lost(self):
        # State file missing, a published adaptive baseline exists, and the
        # first frame is already occupied: seed from the profile, not the frame.
        adaptive = _profile(EMPTY, created_at=self.T0 - 600, source="adaptive")
        t = _live_tracker(_Cal(adaptive))
        ts = _run(t, self.T0, 2 * 3600, 600)
        assert t.baseline.source == "adaptive"
        assert t.baseline.means["out"] == EMPTY["out"]
        assert t._session_start is not None      # the occupant is detected

    def test_own_published_baseline_does_not_override_live_one(self):
        cal = _Cal()
        t = _live_tracker(cal)
        ts = _run(t, self.T0, 600, 0)
        before = dict(t.baseline.means)
        cal.profile = _profile({ch: v + 200 for ch, v in EMPTY.items()},
                               created_at=ts, source="adaptive")
        _run(t, ts, 60, 0)
        assert t.baseline.means == before
