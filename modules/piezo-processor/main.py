#!/usr/bin/env python3
"""
SleepyPod piezo-processor module (v2).

Reads raw piezoelectric sensor data from /persistent/*.RAW (CBOR-encoded),
computes heart rate, HRV, and breathing rate, and writes results to biometrics.db.

One row is written to the `vitals` table approximately every 60 seconds per side
while a user is detected on the pod.

Signal processing pipeline (per side):
  1. PumpGate: dual-channel energy spike detection with 5s guard period
     (Shin et al. IEEE TBME 2009) — records arriving during pump activity
     are dropped before entering side buffers
  2. Buffer incoming 500 Hz piezo samples into rolling windows
  3. Presence detection: hysteresis state machine on median std of 1-10 Hz
     filtered signal in 5s sub-windows, with autocorrelation quality as
     secondary feature (Paalasmaa et al. 2012)
  4. Heart rate: 0.8-8.5 Hz SOS bandpass → subharmonic summation
     autocorrelation (Hermes 1988; Bruser et al. 2011) with inter-window
     Gaussian consistency tracking (max 15 BPM delta)
  5. Breathing rate: Hilbert envelope of 0.8-10 Hz cardiac band →
     0.1-0.7 Hz respiratory extraction → peak counting (PMC9354426)
  6. HR variability index: 10s sub-window autocorrelation IBI with 50%
     overlap → harmonic gate → Hampel filter → gap-aware successive
     differences (NOT clinical RMSSD — see #221)
"""

import os
import sys
import json
import time
import signal
import logging
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cbor2
from common.nats_follower import create_follower
from common.dialect import KNOWN_RECORD_TYPES, warn_unknown_type_once
from common.side_mode import SingleSleeperMode
from common.bed_presence import BedPresence
from beats import STEP_S, BeatHistory, BeatTracker, Chunk
import numpy as np
from runtime_adapter import RuntimeCoordinator, RunContext
from common.biometrics.frames import decode_int32_samples as _int32_samples, LOST_SAMPLE
from common.biometrics.processing import (
    StatefulSideProcessor, HR_WINDOW_S, BREATHING_WINDOW_S, HRV_WINDOW_S,
)
from common.biometrics.routing import SingleSleeperRouter, VITALS_INTERVAL_S
from common.biometrics.gates import (
    FrzHealthPumpState as _FrzHealthPumpState, PumpGate as _PumpGate,
    PresenceDetector, PUMP_ENERGY_MULTIPLIER, PUMP_CORRELATION_MIN,
    PUMP_GUARD_S, PUMP_ACTIVE_RPM_MIN, PUMP_OFF_GUARD_S,
    PUMP_COUPLING_STD_FACTOR, PUMP_COUPLING_ACR_THRESHOLD,
)
from common.biometrics.signal import (
    _bandpass, _autocorr_quality, _compute_autocorr, subharmonic_summation_hr,
    HRTracker, compute_breathing_rate, compute_hrv,
    ProcessingParameters, DEFAULT_PARAMETERS, WindowEstimator,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RAW_DATA_DIR = Path(os.environ.get("RAW_DATA_DIR", "/persistent"))
BIOMETRICS_DB = Path(os.environ.get("BIOMETRICS_DATABASE_URL", "file:/persistent/sleepypod-data/biometrics.db").replace("file:", ""))
SLEEPYPOD_DB = Path(os.environ.get("DATABASE_URL", "file:/persistent/sleepypod-data/sleepypod.db").replace("file:", ""))
# The sleep-detector's saved state: its committed per-side presence.
SLEEP_DETECTOR_STATE = Path(os.environ.get(
    "SLEEP_DETECTOR_STATE_PATH", str(BIOMETRICS_DB.parent / "sleep-detector-state.json")))

SAMPLE_RATE = 500          # Hz — piezo sensor sample rate

# HR band: 0.8 Hz preserves fundamental of 48+ BPM; 8.5 Hz per PMC7582983
HR_BAND = (0.8, 8.5)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [piezo-processor] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
from common.recording_policy import install_logging_policy
install_logging_policy()
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shutdown handling
# ---------------------------------------------------------------------------

_shutdown = threading.Event()

def _on_signal(signum, frame):
    log.info("Received signal %d, shutting down...", signum)
    _shutdown.set()

signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def open_biometrics_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(BIOMETRICS_DB), timeout=5.0, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


# After this many consecutive write failures, discard the connection and
# reopen on the next write attempt (#325).
_DB_RECONNECT_THRESHOLD = 5


class DBHolder:
    """Shared mutable reference to the biometrics connection.

    Both SideProcessor instances point at the same DBHolder so that when one
    side triggers a reconnect, the other automatically observes the new
    connection on its next write. Holding raw sqlite3.Connection refs on each
    processor orphaned the sibling after a reconnect — it kept writing to the
    closed handle (the exact bug sleep-detector's DBHolder docstring warns
    about).

    The consecutive-failure counter lives on the holder, making it
    per-connection: failures observed against a stale handle can no longer
    discard a healthy replacement.
    """
    __slots__ = ("conn", "write_failures")

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.write_failures = 0


def _reconnect_db(holder: "DBHolder") -> None:
    """Open a fresh connection, swap into *holder*, then close the old one.
    Open-first-then-swap means an open failure leaves the live handle in
    place; the close happens after the swap so writers always see a valid
    handle. Never raises."""
    old = holder.conn
    try:
        new = open_biometrics_db()
    except sqlite3.Error as e:
        log.error("Failed to reopen biometrics DB: %s", e)
        return
    holder.conn = new
    log.info("Reopened biometrics DB connection after write failures")
    try:
        old.close()
    except sqlite3.Error:
        pass


def write_vitals(holder: "DBHolder", side: str, ts: datetime,
                 heart_rate: Optional[float], hrv: Optional[float],
                 breathing_rate: Optional[float],
                 quality_score: float,
                 flags: Optional[list] = None,
                 hr_raw: Optional[float] = None,
                 run_context: Optional[RunContext] = None) -> bool:
    """Insert one vitals row + paired vitals_quality row. Logs and swallows
    sqlite3 errors so the main loop survives transient WAL/disk issues (#325).
    After _DB_RECONNECT_THRESHOLD consecutive failures, the holder's
    connection is replaced in place.

    Returns True only when both inserts committed so callers don't advance
    their downsample cursor on a failed write.
    """
    conn = holder.conn
    ts_unix = int(ts.timestamp())
    now_unix = int(time.time())
    flags_json = json.dumps(flags) if flags else None
    try:
        with conn:
            if run_context is not None:
                # Keep the profile and source channel that computed the value,
                # even if single-sleeper mode changed while this row was held.
                if side != run_context.side:
                    raise sqlite3.IntegrityError("Vitals routing disagrees with processing provenance")
                run_context.ensure(conn)
                cur = conn.execute(
                    "INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate, processing_run_id) VALUES (?, ?, ?, ?, ?, ?)",
                    (side, ts_unix, heart_rate, hrv, breathing_rate, run_context.id),
                )
            else:
                cur = conn.execute(
                    "INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES (?, ?, ?, ?, ?)",
                    (side, ts_unix, heart_rate, hrv, breathing_rate),
                )
            conn.execute(
                "INSERT INTO vitals_quality (vitals_id, side, timestamp, quality_score, flags, hr_raw, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (cur.lastrowid, side, ts_unix, quality_score, flags_json, hr_raw, now_unix),
            )
        holder.write_failures = 0
        return True
    except sqlite3.Error as e:
        holder.write_failures += 1
        log.warning("write_vitals failed (%d consecutive): %s",
                    holder.write_failures, e)
        if holder.write_failures >= _DB_RECONNECT_THRESHOLD:
            _reconnect_db(holder)
            holder.write_failures = 0
        return False


@dataclass
class VitalsCandidate:
    """One side's computed vitals for one VITALS_INTERVAL_S cycle."""
    side: str
    ts: datetime
    heart_rate: Optional[float]
    hrv: Optional[float]
    breathing_rate: Optional[float]
    quality_score: float
    flags: Optional[list]
    hr_raw: Optional[float]
    run_context: Optional[RunContext] = None

    def write(self, holder: "DBHolder", side: Optional[str] = None) -> bool:
        # Provenance captures the logical side at computation, not at retry.
        destination = self.run_context.side if self.run_context else side or self.side
        kwargs = {"run_context": self.run_context} if self.run_context else {}
        return write_vitals(holder, destination, self.ts, self.heart_rate,
                            self.hrv, self.breathing_rate,
                            quality_score=self.quality_score, flags=self.flags,
                            hr_raw=self.hr_raw, **kwargs)


class SingleSleeperVitals(SingleSleeperRouter[VitalsCandidate]):
    """Bind shared arbitration to the live database/provenance writer."""
    def __init__(self, holder: "DBHolder", mode: SingleSleeperMode,
                 clock: Callable[[], float] = time.monotonic):
        self._holder = holder
        super().__init__(mode, lambda candidate, side: candidate.write(holder, side=side),
                         clock=clock)


def write_heartbeats(holder: "DBHolder", side: str, chunk: Chunk) -> bool:
    """Insert one minute of detected beats. Replays after a restart produce
    the same rows again, so conflicts are ignored. Failures count towards
    the connection reset like write_vitals."""
    try:
        with holder.conn:
            holder.conn.execute(
                "INSERT OR IGNORE INTO heartbeats (side, timestamp, beats, quality) "
                "VALUES (?, ?, ?, ?)",
                (side, int(chunk.start), json.dumps(chunk.beats, separators=(",", ":")),
                 round(chunk.quality, 3)),
            )
        holder.write_failures = 0
        return True
    except sqlite3.Error as e:
        holder.write_failures += 1
        log.warning("write_heartbeats failed (%d consecutive): %s",
                    holder.write_failures, e)
        if holder.write_failures >= _DB_RECONNECT_THRESHOLD:
            _reconnect_db(holder)
            holder.write_failures = 0
        return False


# Minutes held for a retry after a failed write; older ones are dropped.
HEARTBEAT_RETRY_MAX = 30
HEARTBEAT_RETRY_INTERVAL_S = 5.0
# A single-sleeper minute waits for the other side's tracker to finish it, but
# no longer than this past the minute's end (s) — a stuck tracker can't hold
# the stream back.
HEARTBEAT_HOLD_MAX_S = 180.0


class BeatFront:
    """Beat detection for both sides. Each side's tracker gets its own two
    piezo channels plus the other side's as the noise reference. Finished
    minutes go to the heartbeats table; with one side in away mode (single
    sleeper), each minute keeps whichever side saw the sleeper's beats best,
    stored under the home side. The two trackers finish a minute at
    different times, so it is held until both are done with it; when the
    stored minutes switch sensor, the new one starts with a break, since
    the two trackers' beat anchors differ.

    A side's tracker only runs while `present(side)` holds. An empty bed
    still carries regular vibration from the pod itself, which the detector
    can mistake for a heartbeat; the vitals presence detector already tells
    the two apart, so beats follow it. Leaving the bed is a gap, so no
    interval spans an absence, and stores the minute in progress."""

    def __init__(self, holder: "DBHolder", mode: SingleSleeperMode,
                 present: Callable[[str], bool] = lambda side: True,
                 clock: Callable[[], float] = time.monotonic):
        self._holder = holder
        self._mode = mode
        self._present = present
        self._clock = clock
        self._retry_after = 0.0
        self._was_present = {"left": False, "right": False}
        self.trackers = {"left": BeatTracker("left"), "right": BeatTracker("right")}
        self._latest_ts: Optional[float] = None
        # Single sleeper: minute start -> (home side when it was queued,
        # {sensor side: chunk}) awaiting the other side. The home side is
        # kept so a mode change while it waits doesn't reroute it.
        self._pending: Dict[int, Tuple[str, Dict[str, Chunk]]] = {}
        # Storage side -> sensor side of the last minute stored there. Never
        # reset: a mode change can switch sensors too.
        self._last_source: Dict[str, str] = {}
        # (storage side, chunk) whose write failed, oldest first.
        self._retry: List[Tuple[str, Chunk]] = []

    def history(self, side: str) -> BeatHistory:
        return self.trackers[side].history

    def set_rate_hint(self, side: str, period: float) -> None:
        # Record time, as the tracker ages the hint against its windows.
        at = self._latest_ts if self._latest_ts is not None else time.time()
        self.trackers[side].set_rate_hint(period, at)

    def push(self, ts: float, l1: np.ndarray, l2: Optional[np.ndarray],
             r1: np.ndarray, r2: Optional[np.ndarray], masked: bool = False) -> None:
        self._latest_ts = float(ts)
        signals = {"left": (l1, l2, r1, r2), "right": (r1, r2, l1, l2)}
        chunks = {}
        for side, tracker in self.trackers.items():
            present = self._present(side)
            if present:
                tracker.push(ts, *signals[side], masked=masked)
                chunks[side] = tracker.take_chunks()
            elif self._was_present[side]:
                tracker.gap()
                # Nothing more is coming for the open minute until they're back.
                chunks[side] = tracker.take_chunks(flush_before=float("inf"))
            else:
                chunks[side] = tracker.take_chunks()
            self._was_present[side] = present
        self._write(chunks)

    def gap(self) -> None:
        for t in self.trackers.values():
            t.gap()

    def tick(self) -> None:
        """Retry on the reader thread even when no piezo records arrive."""
        self._drain()

    def flush(self, *, shutdown: bool = False) -> None:
        # Shutdown gets one final bounded attempt even inside the backoff.
        # _drain still stops at the first failure; ingestion never bypasses it.
        if shutdown:
            self._retry_after = 0.0
        self._write({s: t.take_chunks(flush_before=float("inf"))
                     for s, t in self.trackers.items()}, force=True)

    def _store_from(self, side: str, source: str, chunk: Chunk) -> None:
        """Store `source` sensor's chunk under `side`. A minute from another
        sensor than the last one stored there starts with a break: the two
        trackers' beat anchors differ, so no interval may span them."""
        last = self._last_source.get(side)
        if last is not None and last != source and chunk.beats and chunk.beats[0] is not None:
            chunk = Chunk(chunk.start, [None] + chunk.beats, chunk.quality)
        self._last_source[side] = source
        self._store(side, chunk)

    def _store(self, side: str, chunk: Chunk) -> None:
        self._retry.append((side, chunk))

    def _drain(self) -> None:
        # One failed transaction per call, even when new minutes arrive during
        # an outage. Back off from completion (busy_timeout may itself take 5s).
        if self._clock() >= self._retry_after:
            while self._retry:
                side, chunk = self._retry[0]
                if not write_heartbeats(self._holder, side, chunk):
                    self._retry_after = self._clock() + HEARTBEAT_RETRY_INTERVAL_S
                    break
                self._retry.pop(0)
        while len(self._retry) > HEARTBEAT_RETRY_MAX:
            dropped = self._retry.pop(0)
            log.warning("Dropping unwritten heartbeat minute %s/%d", dropped[0], dropped[1].start)

    def _side_done(self, side: str, start: int) -> bool:
        """True once `side`'s tracker can no longer produce minute `start`."""
        if not self._was_present[side]:
            return True
        tracker = self.trackers[side]
        if tracker._chunk_start is not None:
            return tracker._chunk_start > start
        end = tracker._last_committed_end
        return end is not None and end >= start + 60 + STEP_S

    def _write(self, chunks: dict, force: bool = False) -> None:
        home = self._mode.home_side()
        if home is None:
            # Leaving single-sleeper mode: held minutes go out as they were
            # queued, before any per-side minute.
            self._release(force=True)
            for side, c in sorted(((side, c) for side, cs in chunks.items() for c in cs),
                                  key=lambda item: item[1].start):
                self._store_from(side, side, c)
            self._drain()
            return
        for side, cs in chunks.items():
            for c in cs:
                self._pending.setdefault(c.start, (home, {}))[1][side] = c
        self._release(force)
        self._drain()

    def _release(self, force: bool) -> None:
        """Store held minutes, oldest first, once neither tracker can still
        add to them: the better side's chunk, under the home side the minute
        was queued for."""
        for start in sorted(self._pending):
            home, got = self._pending[start]
            stale = self._latest_ts is not None and self._latest_ts > start + 60 + HEARTBEAT_HOLD_MAX_S
            if not (force or stale or all(self._side_done(s, start)
                                          for s in self.trackers if s not in got)):
                break
            del self._pending[start]
            source, best = max(got.items(), key=lambda kv: kv[1].coverage * kv[1].quality)
            self._store_from(home, source, best)


def report_health(status: str, message: str) -> None:
    """Write module health to sleepypod.db system_health table."""
    try:
        conn = sqlite3.connect(str(SLEEPYPOD_DB), timeout=2.0)
        try:
            with conn:
                conn.execute(
                    """INSERT INTO system_health (component, status, message, last_checked)
                       VALUES ('piezo-processor', ?, ?, ?)
                       ON CONFLICT(component) DO UPDATE SET
                         status=excluded.status,
                         message=excluded.message,
                         last_checked=excluded.last_checked""",
                    (status, message, int(time.time())),
                )
        finally:
            conn.close()
    except Exception as e:
        log.warning("Could not write health status: %s", e)

# ---------------------------------------------------------------------------
# Pump gating — streaming adaptation (Shin et al. IEEE TBME 2009)
# ---------------------------------------------------------------------------

class FrzHealthPumpState(_FrzHealthPumpState):
    """Live adapter; replay imports the shared gate with its event clock."""
    def __init__(self, *, clock=None):
        super().__init__(clock=clock if clock is not None else lambda: time.monotonic())


class PumpGate(_PumpGate):
    """Live adapter retaining the historical no-argument constructor."""
    def __init__(self, fs: float = SAMPLE_RATE, *, clock=None):
        super().__init__(fs, clock=clock if clock is not None else lambda: time.monotonic())


# ---------------------------------------------------------------------------
# Per-side processor
# ---------------------------------------------------------------------------

class SideProcessor(StatefulSideProcessor):
    """Live adapter binds shared state to wall time and canonical DB writes."""
    def __init__(self, side: str, db_holder: DBHolder,
                 pump_state: Optional[FrzHealthPumpState] = None,
                 parameters: ProcessingParameters = DEFAULT_PARAMETERS):
        self.db_holder = db_holder
        super().__init__(side, clock=lambda: time.time(),
                         writer=lambda candidate: candidate.write(db_holder),
                         candidate_factory=VitalsCandidate, pump_state=pump_state,
                         parameters=parameters,
                         autocorr_quality=lambda samples: _autocorr_quality(samples))

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

# frankenfirmware writes INT32_MAX in place of a sample it lost ("[sensor]
# sample lost" in its log): one sample, on all four piezo channels at once,
# in a few percent of records. Taken as data it is a spike ~450x any real
# signal: the pump gate drops the record (and 5 s after it), and the beat
# tracker restarts.

def main() -> None:
    log.info("Starting piezo-processor v2 (biometrics.db=%s)", BIOMETRICS_DB)

    if not BIOMETRICS_DB.parent.exists():
        log.error("Biometrics DB directory does not exist: %s", BIOMETRICS_DB.parent)
        sys.exit(1)

    db_holder = DBHolder(open_biometrics_db())
    pump_gate = PumpGate()
    pump_state = FrzHealthPumpState()
    left = SideProcessor("left", db_holder, pump_state=pump_state)
    right = SideProcessor("right", db_holder, pump_state=pump_state)
    left._other = right
    right._other = left
    # One side in away mode: a single sleeper — the away side's readings
    # (rolled over, leg across) are merged into the home side's series.
    bed_mode = SingleSleeperMode(SLEEPYPOD_DB)
    vitals_router = SingleSleeperVitals(db_holder, bed_mode)
    left.sink = right.sink = vitals_router.submit
    # Vitals only while the bed reads occupied — on the side they're stored
    # under, which is the home side with one side away.
    bed = BedPresence(SLEEP_DETECTOR_STATE)
    left.bed_occupied = lambda: bed.occupied(bed_mode.home_side() or "left")
    right.bed_occupied = lambda: bed.occupied(bed_mode.home_side() or "right")
    left.home_side = right.home_side = bed_mode.home_side
    runtime = RuntimeCoordinator(db_holder, {"left": left, "right": right})
    runtime_problem = None
    sides = {"left": left, "right": right}
    # Beats only while the side is occupied: the piezo says someone is there
    # and the bed's capacitance presence doesn't say it's empty.
    beat_front = BeatFront(
        db_holder, bed_mode,
        present=lambda s: (sides[s]._presence.state == PresenceDetector.PRESENT
                           and bed.occupied(bed_mode.home_side() or s) is not False))
    # Each side's window heart rate guides its beat tracker (see beats.py
    # HINT_MAX_AGE_S): envelope periodicity alone can take half-beats for beats.
    left.rate_hint = lambda period: beat_front.set_rate_hint("left", period)
    right.rate_hint = lambda period: beat_front.set_rate_hint("right", period)
    # Source selected once at startup: NatsFollower on new-firmware pods (NATS
    # reachable), else the unchanged .RAW tailer. Same decoded-record contract.
    follower = create_follower(RAW_DATA_DIR, _shutdown, poll_interval=0.01)

    report_health("healthy", "piezo-processor v2 started")

    def poll() -> None:
        vitals_router.tick()
        beat_front.tick()

    try:
        for record in follower.read_records(on_poll=poll):
            rtype = record.get("type")

            # Surface genuinely-new firmware types once (blanketReadings, log,
            # …) instead of dropping them silently; known types this module
            # doesn't consume fall through to the checks below.
            if not isinstance(rtype, str):
                continue
            if rtype not in KNOWN_RECORD_TYPES:
                warn_unknown_type_once(record, "piezo-processor")
                continue

            # Track per-side pump state for the asymmetric pump-coupling guard
            if rtype == "frzHealth":
                pump_state.update(record)
                continue

            if rtype != "piezo-dual":
                continue

            # Each record contains ~500 int32 samples per channel
            l_samples = _int32_samples(record.get("left1", b""))
            r_samples = _int32_samples(record.get("right1", b""))

            if l_samples.size == 0 or r_samples.size == 0:
                continue

            ts = record.get("ts")
            ts = float(ts) if isinstance(ts, (int, float)) else time.time()
            l2 = _int32_samples(record.get("left2", b""))
            r2 = _int32_samples(record.get("right2", b""))

            # Pump gating — drop entire record if pump detected or guard active.
            # Beat tracking blanks it instead: a restart would cost a window.
            if pump_gate.check(l_samples, r_samples):
                beat_front.push(ts, l_samples, l2, r_samples, r2, masked=True)
                continue

            # Beat detection uses both piezo channels of each side, and the
            # other side as a noise reference.
            beat_front.push(ts, l_samples, l2, r_samples, r2)
            frame_time_ms = int(time.time() * 1000)
            runtime.before_frame(bed_mode.home_side(), bed.occupied, frame_time_ms)
            left.ingest(l_samples)
            right.ingest(r_samples)
            runtime.after_frame(frame_time_ms)
            if runtime.problem != runtime_problem:
                runtime_problem = runtime.problem
                report_health("degraded" if runtime_problem else "healthy",
                              "Biometric configuration fallback: " + runtime_problem if runtime_problem
                              else "Biometric runtime configuration available")

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        beat_front.flush(shutdown=True)
        vitals_router.flush()
        db_holder.conn.close()
        log.info("Shutdown complete")

    # Only reached on clean shutdown (not via sys.exit)
    report_health("down", "piezo-processor stopped")


if __name__ == "__main__":
    main()
