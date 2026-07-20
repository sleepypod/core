"""Tests for the NATS frame source (common.nats_follower).

These run on a developer machine / CI without nats-py installed: NatsFollower
lazy-imports nats only inside its background thread, so the probe, decode,
queue, and source-selection paths are all exercised without a live server.

The decode tests run the real captured payloads (common.nats_capture_fixtures)
through NatsFollower's decode path and assert the yielded dicts satisfy the
existing parsers — exactly the contract the .RAW path already relies on.
"""

import base64
import socket
import struct
import threading
import time

import pytest

from common.nats_follower import (
    NatsFollower,
    NatsFollowerError,
    NatsRecordBuffer,
    create_follower,
    nats_reachable,
    wait_for_nats,
)
from common.raw_follower import RawFileFollower
from common.dialect import normalize_bed_temp
from common.nats_capture_fixtures import CAPTURE_FIXTURES


def _payload(subject: str) -> bytes:
    return base64.b64decode(CAPTURE_FIXTURES[subject]["payload_b64"])


# Every committed fixture is a single-map sensor subject. raw.log is outside
# the raw.sens.>/raw.frz.> subscription and intentionally not committed.
SENSOR_SUBJECTS = list(CAPTURE_FIXTURES)


# ---------------------------------------------------------------------------
# Layer-2 reachability probe
# ---------------------------------------------------------------------------

class _FakeServer:
    """Minimal TCP server; optionally greets like NATS with an INFO line."""

    def __init__(self, greeting):
        self._greeting = greeting
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(1)
        self.port = self._sock.getsockname()[1]
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        try:
            conn, _ = self._sock.accept()
            chunks = self._greeting if isinstance(self._greeting, list) else [self._greeting]
            for chunk in chunks:
                if chunk:
                    conn.sendall(chunk)
                    time.sleep(0.01)
            time.sleep(0.2)
            conn.close()
        except OSError:
            pass

    def close(self):
        try:
            self._sock.close()
        except OSError:
            pass


class TestNatsReachable:
    def test_info_greeting_is_reachable(self):
        srv = _FakeServer(b"INFO {\"server_id\":\"x\"}\r\n")
        try:
            assert nats_reachable("127.0.0.1", srv.port, timeout=1.0) is True
        finally:
            srv.close()

    def test_fragmented_info_greeting_is_reachable(self):
        srv = _FakeServer([b"IN", b"FO ", b'{"server_id":"x"}', b"\r\n"])
        try:
            assert nats_reachable("127.0.0.1", srv.port, timeout=1.0) is True
        finally:
            srv.close()

    def test_silent_socket_is_not_reachable(self):
        # Accepts the connection but never sends INFO — recv times out.
        srv = _FakeServer(b"")
        try:
            assert nats_reachable("127.0.0.1", srv.port, timeout=0.3) is False
        finally:
            srv.close()

    def test_connection_refused_is_not_reachable(self):
        # Bind then close to get a definitely-free port.
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        assert nats_reachable("127.0.0.1", port, timeout=0.3) is False


class TestWaitForNats:
    def test_returns_true_when_reachable(self, monkeypatch):
        monkeypatch.setattr("common.nats_follower.nats_reachable",
                            lambda *a, **k: True)
        ev = threading.Event()
        assert wait_for_nats(ev, grace_seconds=5.0) is True

    def test_returns_false_after_grace_window(self, monkeypatch):
        monkeypatch.setattr("common.nats_follower.nats_reachable",
                            lambda *a, **k: False)
        ev = threading.Event()
        assert wait_for_nats(ev, grace_seconds=0.0) is False

    def test_returns_false_on_shutdown(self, monkeypatch):
        monkeypatch.setattr("common.nats_follower.nats_reachable",
                            lambda *a, **k: False)
        ev = threading.Event()
        ev.set()
        assert wait_for_nats(ev, grace_seconds=60.0) is False


# ---------------------------------------------------------------------------
# CBOR decode path
# ---------------------------------------------------------------------------

class TestDecodePath:
    def _follower(self):
        return NatsFollower(threading.Event())

    @pytest.mark.parametrize("subject", SENSOR_SUBJECTS)
    def test_every_sensor_fixture_decodes_to_its_type(self, subject):
        f = self._follower()
        rec = f._handle_payload(_payload(subject))
        assert isinstance(rec, dict)
        assert rec["type"] == CAPTURE_FIXTURES[subject]["type"]
        # Decoded record was enqueued for the generator to hand out.
        assert f._queue.qsize() == 1

    def test_raw_log_is_excluded_from_sensor_fixtures(self):
        assert "raw.log" not in SENSOR_SUBJECTS

    def test_malformed_payload_is_dropped_and_counted(self):
        f = self._follower()
        assert f._handle_payload(b"\xff\xff not cbor \x00") is None
        assert f._decode_failures == 1
        assert f._queue.qsize() == 0

    def test_capsense_fixture_has_pod3_channel_dialect(self):
        rec = self._follower()._handle_payload(_payload("raw.sens.capsense"))
        for side in ("left", "right"):
            data = rec[side]
            # Pod 3 dialect: flat int channels the sleep-detector reads directly.
            assert all(isinstance(data[ch], int) for ch in ("out", "cen", "in"))
            assert data["status"] == "good"

    def test_piezo_fixture_yields_500_int32_samples_per_channel(self):
        rec = self._follower()._handle_payload(_payload("raw.sens.piezo"))
        assert rec["freq"] == 500
        for ch in ("left1", "right1"):
            buf = rec[ch]
            assert isinstance(buf, (bytes, bytearray))
            assert len(buf) == 2000  # 500 little-endian int32 = 1 s at 500 Hz
            samples = struct.unpack("<500i", bytes(buf))
            assert len(samples) == 500

    def test_bedtemp_fixture_normalizes_through_dialect(self):
        rec = self._follower()._handle_payload(_payload("raw.sens.bedtemp"))
        canonical = normalize_bed_temp(rec)
        assert canonical is not None
        # v1 integer centidegrees pass straight through the normalizer.
        assert isinstance(canonical["ambient_temp"], int)
        assert isinstance(canonical["left_outer_temp"], int)

    def test_frztemp_fixture_matches_freezer_writer_shape(self):
        rec = self._follower()._handle_payload(_payload("raw.frz.temp"))
        assert rec["type"] == "frzTemp"
        for key in ("left", "right", "amb", "hs"):
            assert isinstance(rec[key], int)


# ---------------------------------------------------------------------------
# Bounded queue — drop-oldest semantics
# ---------------------------------------------------------------------------

class TestOfferDropOldest:
    def test_full_queue_drops_oldest(self):
        f = NatsFollower(threading.Event(), queue_maxsize=2)
        f._offer({"n": 1})
        f._offer({"n": 2})
        f._offer({"n": 3})  # overflows — oldest ({"n": 1}) is dropped
        assert f._dropped == 1
        assert f._queue.get_nowait() == {"n": 2}
        assert f._queue.get_nowait() == {"n": 3}


# ---------------------------------------------------------------------------
# Generator lifecycle
# ---------------------------------------------------------------------------

class TestReadRecords:
    def test_yields_records_then_raises_on_fatal(self):
        from common.nats_follower import _FATAL
        f = NatsFollower(threading.Event())
        f._started = True  # skip the background thread; feed the queue directly
        f._offer({"type": "capSense", "n": 1})
        f._offer({"type": "capSense", "n": 2})
        f._offer(_FATAL)

        gen = f.read_records()
        assert next(gen)["n"] == 1
        assert next(gen)["n"] == 2
        with pytest.raises(NatsFollowerError):
            next(gen)

    def test_shutdown_stops_the_generator(self):
        ev = threading.Event()
        f = NatsFollower(ev)
        f._started = True
        ev.set()
        assert list(f.read_records()) == []


# ---------------------------------------------------------------------------
# Source selection
# ---------------------------------------------------------------------------

class TestCreateFollower:
    def test_selects_nats_when_reachable(self, monkeypatch, tmp_path):
        monkeypatch.setattr("common.nats_follower.nats_reachable",
                            lambda *a, **k: True)
        src = create_follower(tmp_path, threading.Event(), poll_interval=0.01)
        assert isinstance(src, NatsFollower)

    def test_falls_back_to_raw_when_unreachable(self, monkeypatch, tmp_path):
        monkeypatch.setattr("common.nats_follower.nats_reachable",
                            lambda *a, **k: False)
        src = create_follower(tmp_path, threading.Event(),
                              poll_interval=0.01, grace_seconds=0.0)
        assert isinstance(src, RawFileFollower)


# ---------------------------------------------------------------------------
# Calibrator live buffer
# ---------------------------------------------------------------------------

class TestNatsRecordBuffer:
    def test_accumulates_by_type_and_snapshots(self):
        buf = NatsRecordBuffer(threading.Event())
        # Drive the drain body directly by appending as _drain would.
        for _ in range(3):
            buf._buffers["capSense"].append({"type": "capSense"})
        buf._buffers["piezo-dual"].append({"type": "piezo-dual"})
        snap = buf.snapshot()
        assert len(snap["capSense"]) == 3
        assert len(snap["piezo-dual"]) == 1
        assert buf.total() == 4

    def test_maxlen_bounds_retention_to_newest(self):
        buf = NatsRecordBuffer(threading.Event(),
                               maxlen={"capSense": 2})
        for i in range(5):
            buf._buffers["capSense"].append({"type": "capSense", "i": i})
        snap = buf.snapshot()
        assert [r["i"] for r in snap["capSense"]] == [3, 4]
