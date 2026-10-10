"""
Tests for scripts/repair-capped-sessions.py, the one-off repair of
sleep_records the detector force-closed at MAX_SESSION_S. Each test builds a
synthetic biometrics.db in a temp dir.
"""

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest
import session_limits

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "repair-capped-sessions.py"
_spec = importlib.util.spec_from_file_location("repair_capped_sessions", SCRIPT)
repair = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(repair)

CAP = session_limits.MAX_SESSION_S
T0 = 1_791_500_000
MIN = 60


def _db(path):
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE sleep_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            side TEXT, entered_bed_at INTEGER, left_bed_at INTEGER,
            sleep_duration_seconds INTEGER, times_exited_bed INTEGER,
            present_intervals TEXT, not_present_intervals TEXT,
            created_at INTEGER
        )"""
    )
    conn.execute("CREATE TABLE vitals (side TEXT, timestamp INTEGER, heart_rate REAL)")
    return conn


def _record(conn, entered=T0, side="left", exits=0, present=None, absent=None):
    present = json.dumps([[entered, entered + CAP]]) if present is None else present
    absent = json.dumps([]) if absent is None else absent
    cur = conn.execute(
        """INSERT INTO sleep_records (side, entered_bed_at, left_bed_at, sleep_duration_seconds,
               times_exited_bed, present_intervals, not_present_intervals, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (side, entered, entered + CAP, CAP, exits, present, absent, entered + CAP))
    conn.commit()
    return cur.lastrowid


def _vitals(conn, start, minutes, side="left"):
    """One vitals row a minute for `minutes` minutes from `start`; returns the last ts."""
    rows = [(side, start + i * MIN, 60.0) for i in range(minutes + 1)]
    conn.executemany("INSERT INTO vitals VALUES (?, ?, ?)", rows)
    conn.commit()
    return rows[-1][1]


def _one(conn):
    items = repair.plan(conn)
    assert len(items) == 1
    return items[0]


@pytest.fixture
def conn(tmp_path):
    c = _db(str(tmp_path / "biometrics.db"))
    yield c
    c.close()


def test_constants_are_the_detectors():
    import main
    assert (repair.MAX_SESSION_S, repair.ABSENCE_TIMEOUT_S, repair.MIN_SESSION_S) == (
        main.MAX_SESSION_S, main.ABSENCE_TIMEOUT_S, main.MIN_SESSION_S)


def test_repair_ends_at_the_last_long_vitals_run(conn):
    _record(conn)
    end = _vitals(conn, T0 + 10 * MIN, 7 * 60)
    it = _one(conn)
    assert it["action"] == "repair"
    assert it["new_left"] == end + session_limits.ABSENCE_TIMEOUT_S
    assert it["new_duration"] == it["new_left"] - T0
    assert json.loads(it["present"]) == [[T0, it["new_left"]]]
    assert it["new_exits"] == 1
    assert it["dropped_runs"] == []


def test_vitals_to_the_cap_are_kept(conn):
    _record(conn)
    _vitals(conn, T0, CAP // MIN)
    assert _one(conn)["action"] == "keep"


def test_new_end_is_never_later_than_the_original(conn):
    # The last run ends 60 s before the cap: +120 s would pass it.
    _record(conn)
    _vitals(conn, T0 + CAP - 61 * MIN, 60)
    assert _one(conn)["action"] == "keep"


def test_no_long_run_is_no_evidence(conn):
    _record(conn)
    _vitals(conn, T0 + 60 * MIN, 20)
    _vitals(conn, T0 + 120 * MIN, 29)
    assert _one(conn)["action"] == "no-evidence"


def test_no_vitals_is_no_evidence(conn):
    _record(conn)
    assert _one(conn)["action"] == "no-evidence"


def test_gap_over_five_minutes_splits_a_run(conn):
    _record(conn)
    _vitals(conn, T0, 20)
    _vitals(conn, T0 + 20 * MIN + repair.VITALS_GAP_S + 1, 20)
    assert _one(conn)["action"] == "no-evidence"


def test_occupancy_under_min_session_is_too_short(conn, monkeypatch):
    # Unreachable while MIN_RUN_S (30 min) exceeds MIN_SESSION_S; guards a
    # shorter MIN_RUN_S.
    monkeypatch.setattr(repair, "MIN_RUN_S", 60)
    _record(conn)
    _vitals(conn, T0, 1)
    it = _one(conn)
    assert it["action"] == "too-short"
    assert it["new_left"] == T0 + MIN + session_limits.ABSENCE_TIMEOUT_S


@pytest.mark.parametrize("present, absent", [
    ("null", "[]"),
    ("not json", "[]"),
    ("[[1, 2, 3]]", "[]"),
    ('[["a", 2]]', "[]"),
    ("[]", "{}"),
])
def test_malformed_intervals_are_listed_and_left_alone(conn, tmp_path, present, absent):
    rid = _record(conn, present=present, absent=absent)
    _vitals(conn, T0 + 10 * MIN, 7 * 60)
    items = repair.plan(conn)
    assert items[0]["action"] == "malformed"
    repair.apply(str(tmp_path / "biometrics.db"), conn, items)
    row = conn.execute("SELECT left_bed_at, present_intervals FROM sleep_records WHERE id = ?",
                       (rid,)).fetchone()
    assert row == (T0 + CAP, present)


def test_exits_are_recounted_from_kept_intervals(conn):
    # Two exits before the real end and one inside the padding: the later
    # present interval is clipped away, so its exit goes with it.
    present = [[T0, T0 + 3600], [T0 + 3700, T0 + 7200], [T0 + 9 * 3600, T0 + CAP]]
    absent = [[T0 + 3600, T0 + 3700], [T0 + 7200, T0 + 9 * 3600]]
    _record(conn, exits=2, present=json.dumps(present), absent=json.dumps(absent))
    _vitals(conn, T0, 115)
    it = _one(conn)
    assert it["action"] == "repair"
    kept = json.loads(it["present"])
    assert kept == [[T0, T0 + 3600], [T0 + 3700, it["new_left"]]]
    assert it["new_exits"] == 2
    assert json.loads(it["absent"]) == [[T0 + 3600, T0 + 3700]]


def test_record_without_intervals_counts_the_final_exit(conn):
    _record(conn, exits=0, present="[]", absent="")
    _vitals(conn, T0, 6 * 60)
    it = _one(conn)
    assert it["action"] == "repair" and it["new_exits"] == 1


def test_short_final_run_is_repaired_and_listed(conn, capsys):
    # 60 min, a 10-min gap, then 20 min: the tradeoff ends at the first run
    # (the 20 min may be a genuine return to bed), so it's listed for review.
    _record(conn)
    end = _vitals(conn, T0, 60)
    later = end + 10 * MIN
    _vitals(conn, later, 20)
    items = repair.plan(conn)
    it = items[0]
    assert it["action"] == "repair"
    assert it["new_left"] == end + session_limits.ABSENCE_TIMEOUT_S
    assert it["dropped_runs"] == [[later, later + 20 * MIN]]
    repair.report(items, verbose=False)
    out = capsys.readouterr().out
    assert "short-final-run: 1" in out
    assert "(20 min)" in out


def test_apply_writes_a_backup_first_and_is_idempotent(tmp_path, monkeypatch, capsys):
    path = tmp_path / "biometrics.db"
    c = _db(str(path))
    rid = _record(c)
    _vitals(c, T0, 6 * 60)
    c.close()
    monkeypatch.setattr(repair.time, "time", lambda: 1_791_600_000)

    monkeypatch.setattr(sys, "argv", ["repair", "--db", str(path), "--apply"])
    repair.main()
    assert "applied: 1 records updated" in capsys.readouterr().out
    backup = tmp_path / "biometrics.db.bak.1791600000"
    with sqlite3.connect(backup) as b:
        assert b.execute("SELECT left_bed_at FROM sleep_records").fetchone() == (T0 + CAP,)
    with sqlite3.connect(path) as c:
        repaired = c.execute("SELECT * FROM sleep_records WHERE id = ?", (rid,)).fetchone()
    assert repaired[3] < T0 + CAP

    repair.main()
    assert "nothing to apply" in capsys.readouterr().out
    with sqlite3.connect(path) as c:
        assert c.execute("SELECT * FROM sleep_records WHERE id = ?", (rid,)).fetchone() == repaired
    assert sorted(p.name for p in tmp_path.glob("*.bak.*")) == ["biometrics.db.bak.1791600000"]


def test_dry_run_writes_nothing(tmp_path, monkeypatch, capsys):
    path = tmp_path / "biometrics.db"
    c = _db(str(path))
    _record(c)
    _vitals(c, T0, 6 * 60)
    c.close()
    monkeypatch.setattr(sys, "argv", ["repair", "--db", str(path)])
    repair.main()
    assert "dry run" in capsys.readouterr().out
    with sqlite3.connect(path) as c:
        assert c.execute("SELECT left_bed_at FROM sleep_records").fetchone() == (T0 + CAP,)
    assert list(tmp_path.glob("*.bak.*")) == []


def test_backups_in_the_same_second_do_not_overwrite(tmp_path, monkeypatch):
    monkeypatch.setattr(repair.time, "time", lambda: 1_791_600_000)
    db = str(tmp_path / "biometrics.db")
    first = repair.reserve_backup_path(db)
    Path(first).write_text("first run's backup")
    second = repair.reserve_backup_path(db)
    assert first != second
    assert Path(first).read_text() == "first run's backup"
    assert second.endswith(".bak.1791600000.1")


def test_a_record_changed_underneath_rolls_back_every_update(conn, tmp_path):
    a = _record(conn)
    b = _record(conn, entered=T0 + CAP + 3600)
    _vitals(conn, T0, 6 * 60)
    _vitals(conn, T0 + CAP + 3600, 6 * 60)
    items = repair.plan(conn)
    assert [it["action"] for it in items] == ["repair", "repair"]
    conn.execute("UPDATE sleep_records SET left_bed_at = left_bed_at - 1 WHERE id = ?", (b,))
    conn.commit()
    with pytest.raises(RuntimeError, match=f"record {b} changed"):
        repair.apply(str(tmp_path / "biometrics.db"), conn, items)
    assert conn.execute("SELECT sleep_duration_seconds FROM sleep_records WHERE id = ?",
                        (a,)).fetchone() == (CAP,)
