"""Single-sleeper mode: exactly one side in away mode → the other side is home."""
import sqlite3

import pytest

from common.side_mode import SingleSleeperMode, home_side_for, other_side


@pytest.mark.parametrize("away,home", [
    ({"left": False, "right": True}, "left"),
    ({"left": True, "right": False}, "right"),
    ({"left": False, "right": False}, None),
    ({"left": True, "right": True}, None),   # nobody home: plain per-side
    ({}, None),
    ({"right": 1}, "left"),                  # SQLite booleans are ints
])
def test_home_side_for(away, home):
    assert home_side_for(away) == home


def test_other_side():
    assert other_side("left") == "right"
    assert other_side("right") == "left"


def _db(tmp_path, left_away, right_away):
    path = tmp_path / "sleepypod.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE side_settings (side TEXT PRIMARY KEY, away_mode INTEGER)")
    conn.executemany("INSERT INTO side_settings VALUES (?, ?)",
                     [("left", int(left_away)), ("right", int(right_away))])
    conn.commit()
    conn.close()
    return path


def _set_away(path, side, away):
    conn = sqlite3.connect(path)
    conn.execute("UPDATE side_settings SET away_mode=? WHERE side=?", (int(away), side))
    conn.commit()
    conn.close()


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_reads_away_mode_and_reloads_on_interval(tmp_path):
    path = _db(tmp_path, left_away=False, right_away=True)
    clock = Clock()
    mode = SingleSleeperMode(path, reload_s=60, clock=clock)
    assert mode.home_side() == "left"

    _set_away(path, "right", False)
    clock.t += 30
    assert mode.home_side() == "left"        # cached until the interval passes
    clock.t += 30
    assert mode.home_side() is None


def test_unreadable_db_keeps_last_mode(tmp_path):
    path = _db(tmp_path, left_away=True, right_away=False)
    clock = Clock()
    mode = SingleSleeperMode(path, reload_s=60, clock=clock)
    assert mode.home_side() == "right"
    path.unlink()
    clock.t += 60
    assert mode.home_side() == "right"


def test_missing_db_is_per_side(tmp_path):
    mode = SingleSleeperMode(tmp_path / "absent.db")
    assert mode.home_side() is None


def test_read_only_access_never_creates_the_db(tmp_path):
    SingleSleeperMode(tmp_path / "absent.db").home_side()
    assert not (tmp_path / "absent.db").exists()
