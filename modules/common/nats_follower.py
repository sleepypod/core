"""
NATS frame source for SleepyPod biometrics modules.

New Pod 5 firmware (~April 2026+) stops writing CBOR ``*.RAW`` spool files and
instead publishes sensor frames to a local NATS server
(``nats://127.0.0.1:4222``, JetStream-enabled, no auth on loopback). The
records on the wire are the same CBOR dialects the module parsers already
handle — the only new thing is the transport.

This module adds a NATS source *alongside* the existing
``common.raw_follower.RawFileFollower``; it never replaces it. Which source a
module uses is decided once at startup by ``create_follower`` via a cheap
reachability probe (see the design spec, ``docs/nats-frame-readers.md``):

  - ``nats_reachable`` — layer-2 TCP probe: a real NATS server greets with an
    ``INFO {...}`` line before the client sends anything.
  - ``wait_for_nats`` — retries the probe over a 60 s boot-ordering grace
    window (covers the module-up-before-nats-server race on new firmware).
  - ``NatsFollower`` — interface-compatible with ``RawFileFollower``: a
    blocking ``read_records()`` generator yielding decoded record dicts, so a
    module's dispatch loop is unchanged.
  - ``NatsRecordBuffer`` — a bounded live accumulator for the calibrator,
    which does batch scans rather than tailing (core NATS has no backfill).

Python 3.9 constraint applies (Pod 5 ships 3.9.9): no PEP 604 ``int | None``
annotations — ``Optional[...]`` only.
"""

import asyncio
import logging
import queue
import socket
import threading
import time
from collections import deque
from pathlib import Path
from typing import Iterable, Optional

import cbor2

from common.raw_follower import RawFileFollower

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

NATS_DEFAULT_SERVER = "nats://127.0.0.1:4222"
NATS_DEFAULT_HOST = "127.0.0.1"
NATS_DEFAULT_PORT = 4222
NATS_INFO_MAX_BYTES = 4096

# Subjects consumed by the biometrics modules. raw.log lives outside these
# prefixes on purpose — it is a firmware log channel surfaced by sp-status,
# not a sensor stream, so the modules never subscribe to it.
NATS_SENSOR_SUBJECTS = ("raw.sens.>", "raw.frz.>")

# Bounded hand-off queue. Full ⇒ drop-oldest (live data beats backlog, exactly
# like the file tailer jumping to EOF). 256 ≈ 2 min of capSense at 2 Hz.
NATS_QUEUE_MAXSIZE = 256

# Boot-ordering grace window: keep probing this long before falling back to the
# file tailer, so a module that starts before nats-server still selects NATS.
NATS_GRACE_SECONDS = 60.0
NATS_PROBE_INTERVAL = 5.0

# nats-py auto-reconnect: this many consecutive failed reconnects ⇒ the client
# gives up, read_records() raises, the process exits, systemd restarts it, and
# the whole source selection re-runs (mirrors RawFileFollower on dead files).
MAX_RECONNECT_FAILURES = 10
RECONNECT_TIME_WAIT = 2.0

# Data-layer health signal: on live firmware capSense ticks at 2 Hz, so a
# silent subscription past this many seconds is worth one log line. It does
# NOT change the source choice — reachability already decided that.
SILENCE_WARN_SECONDS = 60.0

# Sentinel pushed onto the queue when the connection is unrecoverable.
_FATAL = object()


class NatsFollowerError(RuntimeError):
    """Raised out of NatsFollower.read_records() when the NATS connection is
    permanently lost, so the module exits and systemd restarts + re-probes."""


def nats_reachable(host: str = NATS_DEFAULT_HOST, port: int = NATS_DEFAULT_PORT,
                   timeout: float = 2.0) -> bool:
    """Layer-2 reachability probe.

    A real NATS server sends an ``INFO {...}`` protocol line immediately on
    connect, before the client writes anything. That distinguishes it from a
    random open port at ~zero cost and with no client dependency.
    """
    try:
        with socket.create_connection((host, port), timeout=timeout) as s:
            deadline = time.monotonic() + timeout
            greeting = bytearray()
            while len(greeting) < NATS_INFO_MAX_BYTES:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                s.settimeout(remaining)
                chunk = s.recv(min(512, NATS_INFO_MAX_BYTES - len(greeting)))
                if not chunk:
                    return False
                greeting.extend(chunk)
                if b"\n" in chunk:
                    first_line = bytes(greeting).split(b"\n", 1)[0]
                    return first_line.startswith(b"INFO ")
            return False
    except OSError:
        return False


def wait_for_nats(shutdown_event, grace_seconds: float = NATS_GRACE_SECONDS,
                  probe_interval: float = NATS_PROBE_INTERVAL,
                  host: str = NATS_DEFAULT_HOST, port: int = NATS_DEFAULT_PORT,
                  timeout: float = 2.0) -> bool:
    """Return True if NATS becomes reachable within the grace window.

    Retries ``nats_reachable`` every ``probe_interval`` seconds until it
    succeeds, the window elapses, or shutdown is signalled. Reachability alone
    selects NATS: the follower is patient and simply waits for frames, so we
    never lose a boot race to the file tailer (see the source-selection
    rationale in the design spec).
    """
    deadline = time.monotonic() + grace_seconds
    while not shutdown_event.is_set():
        if nats_reachable(host, port, timeout):
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        # shutdown-aware sleep, bounded by the remaining window so we never
        # overshoot the deadline waiting on a full probe interval.
        shutdown_event.wait(min(probe_interval, remaining))
    return False


class NatsFollower:
    """Follow a local NATS server, yielding decoded CBOR records.

    Interface-compatible with :class:`~common.raw_follower.RawFileFollower`:
    ``read_records()`` is a blocking generator of decoded record dicts. A
    daemon thread owns the asyncio event loop and nats-py client; decoded
    records are pushed onto a bounded queue that the generator drains.

    Args:
        shutdown_event: A threading.Event that signals shutdown.
        servers: NATS server URL(s).
        subjects: Core-subscribe subject filters.
        queue_maxsize: Bounded hand-off queue size (drop-oldest when full).
        max_reconnect_failures: Consecutive reconnect failures before the
            client gives up and read_records() raises NatsFollowerError.
    """

    def __init__(self, shutdown_event, servers=NATS_DEFAULT_SERVER,
                 subjects: Iterable[str] = NATS_SENSOR_SUBJECTS,
                 queue_maxsize: int = NATS_QUEUE_MAXSIZE,
                 max_reconnect_failures: int = MAX_RECONNECT_FAILURES):
        self._shutdown = shutdown_event
        self._servers = servers
        self._subjects = tuple(subjects)
        self._queue: "queue.Queue" = queue.Queue(maxsize=queue_maxsize)
        self._max_reconnect_failures = max_reconnect_failures
        self._thread: Optional[threading.Thread] = None
        self._started = False
        self._closed_evt = threading.Event()
        # Diagnostics
        self._msg_count = 0
        self._decode_failures = 0
        self._dropped = 0
        self._decode_logged = False
        self._start_monotonic = 0.0
        self._silence_logged = False

    # -- queue plumbing ----------------------------------------------------

    def _offer(self, item) -> None:
        """Enqueue, dropping the oldest item when the queue is full.

        Live data beats backlog: the same trade-off the file tailer makes by
        jumping to EOF. A dropped-record counter surfaces sustained overrun.
        """
        try:
            self._queue.put_nowait(item)
            return
        except queue.Full:
            pass
        try:
            self._queue.get_nowait()
            self._dropped += 1
        except queue.Empty:
            pass
        try:
            self._queue.put_nowait(item)
        except queue.Full:
            pass

    def _handle_payload(self, data: bytes) -> Optional[dict]:
        """Decode one CBOR message payload and enqueue it.

        The transport guarantees message boundaries, so there is no framing,
        magic-byte scan, or corruption recovery — just decode. A malformed
        payload is logged (first occurrence) and dropped against a failure
        counter. Returns the decoded record, or None on a bad payload.
        """
        try:
            record = cbor2.loads(data)
        except Exception as e:  # cbor2.CBORDecodeError + defensive catch-all
            self._decode_failures += 1
            if not self._decode_logged:
                self._decode_logged = True
                log.warning("Dropping undecodable NATS payload (%d bytes): %s",
                            len(data) if data else 0, e)
            return None
        if not isinstance(record, dict):
            self._decode_failures += 1
            if not self._decode_logged:
                self._decode_logged = True
                log.warning("Dropping non-dict NATS payload (decoded type=%s)",
                            type(record).__name__)
            return None
        self._msg_count += 1
        self._offer(record)
        return record

    # -- lifecycle ---------------------------------------------------------

    def _ensure_started(self) -> None:
        if self._started:
            return
        self._started = True
        self._start_monotonic = time.monotonic()
        self._thread = threading.Thread(
            target=self._run, name="nats-follower", daemon=True)
        self._thread.start()

    def read_records(self):
        """Yield decoded CBOR records as they arrive from NATS.

        Blocks on the internal queue. Raises NatsFollowerError if the client
        exhausts its reconnect budget, so the caller exits and systemd
        restarts the module (re-running source selection).
        """
        self._ensure_started()
        while not self._shutdown.is_set():
            try:
                item = self._queue.get(timeout=0.5)
            except queue.Empty:
                self._maybe_log_silence()
                continue
            if item is _FATAL:
                raise NatsFollowerError(
                    "NATS connection lost after %d reconnect attempts"
                    % self._max_reconnect_failures)
            yield item

    def _maybe_log_silence(self) -> None:
        if self._silence_logged or self._msg_count > 0:
            return
        if time.monotonic() - self._start_monotonic >= SILENCE_WARN_SECONDS:
            self._silence_logged = True
            log.warning("No NATS frames on %s after %.0fs — server reachable "
                        "but silent (firmware publisher not started?)",
                        list(self._subjects), SILENCE_WARN_SECONDS)

    # -- background thread -------------------------------------------------

    def _run(self) -> None:
        try:
            import nats  # lazy: keeps module import free of the nats-py dep
        except Exception as e:
            log.error("nats-py unavailable, cannot follow NATS: %s", e)
            self._offer(_FATAL)
            return

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._connect_and_run(nats))
        except Exception as e:
            log.error("NATS follower thread crashed: %s", e)
        finally:
            try:
                loop.close()
            except Exception:
                pass
            # Only unrecoverable failures should wake read_records() with a
            # fatal sentinel. Graceful shutdown exits through its event.
            if not self._shutdown.is_set():
                self._offer(_FATAL)

    async def _connect_and_run(self, nats) -> None:
        async def on_error(e):
            log.warning("NATS error: %s", e)

        async def on_disconnected():
            log.warning("NATS disconnected — reconnecting")

        async def on_reconnected():
            log.info("NATS reconnected")

        async def on_closed():
            self._closed_evt.set()

        try:
            nc = await nats.connect(
                self._servers,
                max_reconnect_attempts=self._max_reconnect_failures,
                reconnect_time_wait=RECONNECT_TIME_WAIT,
                error_cb=on_error,
                disconnected_cb=on_disconnected,
                reconnected_cb=on_reconnected,
                closed_cb=on_closed,
            )
        except Exception as e:
            log.error("NATS connect failed: %s", e)
            return

        async def on_msg(msg):
            self._handle_payload(msg.data)

        for subject in self._subjects:
            await nc.subscribe(subject, cb=on_msg)
        log.info("NatsFollower subscribed to %s on %s",
                 list(self._subjects), self._servers)

        while not self._shutdown.is_set() and not self._closed_evt.is_set():
            await asyncio.sleep(0.25)
            self._maybe_log_silence()

        try:
            await nc.close()
        except Exception:
            pass


def create_follower(raw_data_dir: Path, shutdown_event,
                    poll_interval: float = 0.5,
                    grace_seconds: float = NATS_GRACE_SECONDS,
                    servers=NATS_DEFAULT_SERVER):
    """Select the record source once, at startup.

    Reachability decides; traffic does not (robustness over startup latency).
    A NATS server on loopback means new firmware, so we follow it and let the
    follower wait for frames. Otherwise we fall back to the untouched file
    tailer. The two sources never run concurrently in one process.

    Returns an object exposing ``read_records()`` — either a NatsFollower or a
    RawFileFollower.
    """
    if wait_for_nats(shutdown_event, grace_seconds=grace_seconds):
        log.info("NATS reachable — using NatsFollower (new-firmware source)")
        return NatsFollower(shutdown_event, servers=servers)
    log.info("NATS not reachable — tailing %s (.RAW source)", raw_data_dir)
    return RawFileFollower(raw_data_dir, shutdown_event, poll_interval=poll_interval)


class NatsRecordBuffer:
    """Bounded live accumulator of recent records for the calibrator.

    The calibrator does batch scans (``load_recent_records``), not tailing, and
    core NATS has no backfill — so on a NATS-only pod there is nothing to scan.
    This runs a NatsFollower on a background thread and keeps a per-type
    ring buffer of recent records. ``snapshot()`` hands the calibrators a dict
    of record lists in the same shape ``load_recent_records`` returns from
    ``*.RAW``. Buffers are bounded per type (``maxlen``) so memory stays capped
    while the newest data is always retained.
    """

    #: Record types the calibrators consume, and how many of each to retain.
    #: capSense/capSense2 at ~2 Hz: ~1 h. piezo-dual at 1/s (~4 KB each): ~15
    #: min bounds RAM. bedTemp is DB-backed (TempCalibrator reads bed_temp),
    #: buffered only for completeness.
    DEFAULT_MAXLEN = {
        "capSense": 7200,
        "capSense2": 7200,
        "piezo-dual": 900,
        "bedTemp": 360,
        "bedTemp2": 360,
    }

    def __init__(self, shutdown_event, servers=NATS_DEFAULT_SERVER,
                 subjects: Iterable[str] = NATS_SENSOR_SUBJECTS,
                 maxlen: Optional[dict] = None):
        self._shutdown = shutdown_event
        self._follower = NatsFollower(shutdown_event, servers=servers,
                                      subjects=subjects)
        limits = maxlen or self.DEFAULT_MAXLEN
        self._buffers = {t: deque(maxlen=n) for t, n in limits.items()}
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._started = False
        # Set when the follower exhausts its reconnect budget. The calibrator
        # polls raise_if_fatal() so it exits (systemd restart → re-probe)
        # rather than serving a stale buffer forever.
        self._fatal: Optional[BaseException] = None

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._thread = threading.Thread(
            target=self._drain, name="nats-cal-buffer", daemon=True)
        self._thread.start()

    def _drain(self) -> None:
        try:
            for record in self._follower.read_records():
                if not isinstance(record, dict):
                    continue
                buf = self._buffers.get(record.get("type"))
                if buf is None:
                    continue
                with self._lock:
                    buf.append(record)
        except NatsFollowerError as e:
            log.warning("Calibrator NATS collector stopped: %s", e)
            self._fatal = e

    def raise_if_fatal(self) -> None:
        """Re-raise the collector's fatal error (if any) on the caller's thread.

        The background drain can only flag the failure; the calibrator main
        loop calls this each tick so an unrecoverable NATS connection exits the
        process and lets systemd restart + re-probe, instead of quietly
        calibrating against a frozen buffer.
        """
        if self._fatal is not None:
            raise NatsFollowerError(str(self._fatal))

    def snapshot(self) -> dict:
        """Return a shallow copy of the current per-type record lists."""
        with self._lock:
            return {t: list(buf) for t, buf in self._buffers.items()}

    def total(self) -> int:
        with self._lock:
            return sum(len(buf) for buf in self._buffers.values())
