"""Calibration trigger queue contracts using a real temporary directory."""
import json
from itertools import count
import pytest
from common import calibration


@pytest.fixture
def trigger_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(calibration, "TRIGGER_PATH", tmp_path / ".calibrate-trigger")
    return tmp_path


def test_empty_queue_and_clear_are_idempotent(trigger_dir):
    watcher = calibration.CalibrationWatcher()
    assert watcher.check_trigger() is None
    watcher.clear_trigger()
    watcher.clear_trigger()
    assert list(trigger_dir.iterdir()) == []


def test_reads_oldest_without_consuming_and_ignores_incomplete_tmp_files(trigger_dir):
    older = trigger_dir / ".calibrate-trigger.9"
    newer = trigger_dir / ".calibrate-trigger.10"
    incomplete = trigger_dir / ".calibrate-trigger.000.tmp"
    older.write_text(json.dumps({"side": "left", "sensor": "cap"}))
    newer.write_text(json.dumps({"side": "right", "sensor": "piezo"}))
    incomplete.write_text('{"side":')
    watcher = calibration.CalibrationWatcher()
    assert watcher.check_trigger() == {"side": "left", "sensor": "cap"}
    assert watcher.check_trigger() == {"side": "left", "sensor": "cap"}
    assert older.exists()
    watcher.clear_trigger()
    assert watcher.check_trigger() == {"side": "right", "sensor": "piezo"}
    watcher.clear_trigger()
    assert watcher.check_trigger() is None
    assert incomplete.exists()


@pytest.mark.parametrize("invalid", ['{"side":', '[]', 'null', '42', '"left"'])
def test_discards_bad_trigger_then_allows_next_request(trigger_dir, invalid):
    bad = trigger_dir / ".calibrate-trigger.9"
    good = trigger_dir / ".calibrate-trigger.10"
    bad.write_text(invalid)
    good.write_text('{"side":"right"}')
    watcher = calibration.CalibrationWatcher()
    assert watcher.check_trigger() is None
    assert not bad.exists()
    assert good.exists()
    assert watcher.check_trigger() == {"side": "right"}


def test_same_millisecond_writes_remain_distinct_and_leave_no_tmp_files(trigger_dir, monkeypatch):
    monkeypatch.setattr(calibration.time, "time", lambda: 1_000.125)
    monkeypatch.setattr(calibration, "_trigger_seq", count(8))
    payloads = [{"side": "left", "request": n} for n in range(3)]
    for payload in payloads:
        calibration.write_trigger_atomic(payload)
    files = sorted(trigger_dir.iterdir())
    assert len(files) == len(payloads)
    assert all(path.suffix != ".tmp" for path in files)
    assert sorted(json.loads(path.read_text())["request"] for path in files) == [0, 1, 2]
    watcher = calibration.CalibrationWatcher()
    received = []
    while (payload := watcher.check_trigger()) is not None:
        received.append(payload)
        watcher.clear_trigger()
    assert received == payloads
    assert list(trigger_dir.iterdir()) == []


def test_failed_rename_is_never_visible_as_a_complete_request(trigger_dir, monkeypatch):
    def fail_rename(*args):
        raise OSError("rename failed")
    monkeypatch.setattr(calibration.Path, "rename", fail_rename)
    with pytest.raises(OSError, match="rename failed"):
        calibration.write_trigger_atomic({"side": "left"})
    assert calibration.CalibrationWatcher().check_trigger() is None
    assert all(path.suffix == ".tmp" for path in trigger_dir.iterdir())


def test_mixed_legacy_and_sequenced_filenames_are_read_and_cleared_in_order(trigger_dir):
    names = [
        ".calibrate-trigger",
        ".calibrate-trigger.9",
        ".calibrate-trigger.10.1.000000008",
        ".calibrate-trigger.10.1.9",
        ".calibrate-trigger.10.1.10",
    ]
    for index, name in reversed(list(enumerate(names))):
        (trigger_dir / name).write_text(json.dumps({"request": index}))
    watcher = calibration.CalibrationWatcher()
    for index, name in enumerate(names):
        assert watcher.check_trigger() == {"request": index}
        watcher.clear_trigger()
        assert not (trigger_dir / name).exists()
    assert watcher.check_trigger() is None
