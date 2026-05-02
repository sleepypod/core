"""Tests for cover-buttons press extraction.

Stub out the cbor2 / common.raw_follower imports so main.py loads on a
developer Mac without the on-pod runtime. We only exercise iter_presses.
"""

import sys

_stubs = {
    "cbor2": type(sys)("cbor2"),
    "common": type(sys)("common"),
    "common.raw_follower": type(sys)("common.raw_follower"),
}
_stubs["common.raw_follower"].RawFileFollower = None
sys.modules.update(_stubs)

from main import iter_presses  # noqa: E402


def test_real_sample_two_buttons_left():
    rec = {"type": "buttonEvent", "ts": 1777357840,
           "left": {"top": 1, "bottom": 1}}
    out = sorted(iter_presses(rec))
    assert out == sorted([
        ("left", "top", 1, 1777357840),
        ("left", "bottom", 1, 1777357840),
    ])


def test_real_sample_second_capture():
    rec = {"type": "buttonEvent", "ts": 1777343118,
           "left": {"top": 1, "bottom": 1}}
    out = sorted(iter_presses(rec))
    assert out == sorted([
        ("left", "top", 1, 1777343118),
        ("left", "bottom", 1, 1777343118),
    ])


def test_real_sample_single_button():
    rec = {"type": "buttonEvent", "ts": 1777388681,
           "left": {"top": 1}}
    out = list(iter_presses(rec))
    assert out == [("left", "top", 1, 1777388681)]


def test_non_dict_side_skipped():
    rec = {"type": "buttonEvent", "ts": 0, "left": "garbage"}
    assert list(iter_presses(rec)) == []


def test_unknown_button_key_skipped():
    rec = {"type": "buttonEvent", "ts": 0, "left": {"weird": 1}}
    assert list(iter_presses(rec)) == []


def test_non_buttonevent_filtered_out():
    rec = {"type": "piezo-dual", "ts": 0, "left": {"top": 1}}
    assert list(iter_presses(rec)) == []


def test_non_dict_record_skipped():
    # RawFileFollower yields decoded CBOR — corrupt frames can be lists,
    # strings, ints, None. Service must not crash.
    for bad in [None, [], "buttonEvent", 42, b"buttonEvent"]:
        assert list(iter_presses(bad)) == []


def test_both_sides_yielded():
    rec = {"type": "buttonEvent", "ts": 100,
           "left": {"top": 1}, "right": {"middle": 1, "bottom": 1}}
    out = sorted(iter_presses(rec))
    assert out == sorted([
        ("left", "top", 1, 100),
        ("right", "middle", 1, 100),
        ("right", "bottom", 1, 100),
    ])


def test_zero_count_skipped():
    rec = {"type": "buttonEvent", "ts": 0, "left": {"top": 0}}
    assert list(iter_presses(rec)) == []


def test_count_greater_than_one_preserved():
    rec = {"type": "buttonEvent", "ts": 50, "left": {"top": 3}}
    out = list(iter_presses(rec))
    assert out == [("left", "top", 3, 50)]


def test_missing_side_ok():
    rec = {"type": "buttonEvent", "ts": 0, "right": {"top": 1}}
    out = list(iter_presses(rec))
    assert out == [("right", "top", 1, 0)]
