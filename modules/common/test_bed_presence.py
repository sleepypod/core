import json
import os
import time
import pytest

from common.bed_presence import BED_PRESENCE_STALE_S, BedPresence


def _write(path, left=True, right=False, version=1):
    path.write_text(json.dumps({
        "version": version,
        "left": {"debounced_present": left, "vitals_presence": left, "vitals_evidence_ts": time.time(), "session_start": None},
        "right": {"debounced_present": right, "vitals_presence": right, "vitals_evidence_ts": time.time(), "session_start": None},
    }))


class Clock:
    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t


def _presence(path, mono=None, wall=None, **kw):
    return BedPresence(path, clock=mono or Clock(), wall=wall or (lambda: os.stat(path).st_mtime if path.exists() else 0.0), **kw)


def test_reads_each_side(tmp_path):
    path = tmp_path / "state.json"
    _write(path, left=True, right=False)
    bed = _presence(path)
    assert bed.occupied("left") is True
    assert bed.occupied("right") is False


def test_unknown_without_a_state_file(tmp_path):
    bed = _presence(tmp_path / "missing.json")
    assert bed.occupied("left") is None


def test_unknown_for_a_corrupt_or_foreign_file(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{not json")
    assert _presence(path).occupied("left") is None
    _write(path, version=2)
    assert _presence(path).occupied("left") is None
    path.write_text(json.dumps({"version": 1, "left": "odd"}))
    assert _presence(path).occupied("left") is None
    path.write_text(json.dumps({"version": 1, "left": {"session_start": None}}))
    assert _presence(path).occupied("left") is None


def test_unknown_when_the_detector_has_stopped_writing(tmp_path):
    path = tmp_path / "state.json"
    _write(path)
    mtime = os.stat(path).st_mtime
    assert _presence(path, wall=lambda: mtime + BED_PRESENCE_STALE_S - 1).occupied("left") is True
    assert _presence(path, wall=lambda: mtime + BED_PRESENCE_STALE_S + 1).occupied("left") is None


def test_rereads_only_after_the_reload_interval(tmp_path):
    path = tmp_path / "state.json"
    _write(path, left=False)
    mono = Clock()
    bed = _presence(path, mono=mono, reload_s=5.0)
    assert bed.occupied("left") is False
    _write(path, left=True)
    mono.t = 4.9
    assert bed.occupied("left") is False
    mono.t = 5.0
    assert bed.occupied("left") is True


def test_recovers_when_the_file_comes_back(tmp_path):
    path = tmp_path / "state.json"
    mono = Clock()
    bed = _presence(path, mono=mono, reload_s=1.0)
    assert bed.occupied("left") is None
    _write(path, left=True)
    mono.t = 1.0
    assert bed.occupied("left") is True


@pytest.mark.parametrize("value", [None, 0, 1, "false", [], {}])
def test_rejects_non_boolean_presence(tmp_path, value):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"version": 1, "left": {
        "vitals_presence": value, "vitals_evidence_ts": 1000}}))
    assert _presence(path, wall=lambda: 1000).occupied("left") is None


@pytest.mark.parametrize("stamp", [None, True, "1000", float("nan"), float("inf"), 1001, 699])
def test_rejects_invalid_or_stale_per_side_evidence(tmp_path, stamp):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"version": 1, "left": {
        "vitals_presence": False, "vitals_evidence_ts": stamp}}))
    assert _presence(path, wall=lambda: 1000).occupied("left") is None


def test_checks_evidence_age_even_before_next_file_reload(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"version": 1, "left": {
        "vitals_presence": False, "vitals_evidence_ts": 1000}}))
    wall = Clock(1299)
    bed = _presence(path, wall=wall)
    assert bed.occupied("left") is False
    wall.t = 1301
    assert bed.occupied("left") is None


def test_legacy_checkpoint_does_not_claim_trustworthy_absence(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"version": 1, "left": {"debounced_present": False}}))
    assert _presence(path).occupied("left") is None
