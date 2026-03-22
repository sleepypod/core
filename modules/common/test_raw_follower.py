"""Tests for RawFileFollower._find_latest() SEQNO.RAW exclusion."""

import os
import threading
import time

import pytest

# Stub out cbor2 and common.cbor_raw so we can import raw_follower
# without the full pod runtime.
import sys

_cbor2_stub = type(sys)("cbor2")
_cbor_raw_stub = type(sys)("common.cbor_raw")
_cbor_raw_stub.read_raw_record = None
sys.modules.setdefault("cbor2", _cbor2_stub)
sys.modules.setdefault("common.cbor_raw", _cbor_raw_stub)

from common.raw_follower import RawFileFollower  # noqa: E402


def _make_follower(data_dir):
    """Create a RawFileFollower pointed at *data_dir*."""
    return RawFileFollower(data_dir, threading.Event())


def _touch(path, mtime_offset=0):
    """Create a file and optionally shift its mtime by *mtime_offset* seconds."""
    path.write_bytes(b"\x00")
    if mtime_offset:
        t = time.time() + mtime_offset
        os.utime(path, (t, t))


class TestFindLatest:
    def test_empty_directory(self, tmp_path):
        follower = _make_follower(tmp_path)
        assert follower._find_latest() is None

    def test_only_seqno_raw(self, tmp_path):
        _touch(tmp_path / "SEQNO.RAW")
        follower = _make_follower(tmp_path)
        assert follower._find_latest() is None

    def test_seqno_newer_than_data_file(self, tmp_path):
        _touch(tmp_path / "DATA.RAW", mtime_offset=-10)
        _touch(tmp_path / "SEQNO.RAW", mtime_offset=0)
        follower = _make_follower(tmp_path)
        result = follower._find_latest()
        assert result is not None
        assert result.name == "DATA.RAW"

    def test_multiple_data_files_returns_newest(self, tmp_path):
        _touch(tmp_path / "OLD.RAW", mtime_offset=-20)
        _touch(tmp_path / "MID.RAW", mtime_offset=-10)
        _touch(tmp_path / "NEW.RAW", mtime_offset=0)
        follower = _make_follower(tmp_path)
        result = follower._find_latest()
        assert result is not None
        assert result.name == "NEW.RAW"
