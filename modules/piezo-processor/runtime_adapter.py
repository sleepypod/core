"""Live configuration adoption; no hardware control or desired-state writes."""
from dataclasses import dataclass
import json
import logging
import sqlite3
import time
from uuid import uuid4
from typing import Optional

from common.biometrics.config import config_hash, manifest
from common.biometrics.runtime import BoundarySelection, RuntimeSnapshot, read_latest_snapshot
from common.biometrics.signal import ProcessingParameters
from common.biometrics.mechanical import VERSION as MECHANICAL_VERSION

log = logging.getLogger(__name__)
COMPONENTS = ("heart_rate", "breathing_rate", "hrv_index")


@dataclass(frozen=True)
class RunContext:
    id: str
    side: str
    source_side: str
    bundle_json: str
    config_hash: str
    started_at_ms: int
    timestamp_basis: str = "processing_clock"
    mechanical_context: Optional[str] = None

    def ensure(self, connection):
        """Called inside the observation transaction, including after DB reset."""
        identity = {"sourceSide": self.source_side, "timestampBasis": self.timestamp_basis,
                    "rawIdentity": "not_retained", "sensorCalibration": "not_consumed"}
        if self.mechanical_context is not None:
            if self.mechanical_context != MECHANICAL_VERSION:
                raise ValueError('Unsupported mechanical context')
            identity['mechanicalContext'] = self.mechanical_context
        connection.execute(
            "INSERT OR IGNORE INTO biometric_processing_runs "
            "(id, side, kind, bundle, config_hash, calibration_hash, input_identity, started_at_ms) "
            "VALUES (?, ?, 'live', ?, ?, NULL, ?, ?)",
            (self.id, self.side, self.bundle_json, self.config_hash,
             json.dumps(identity),
             self.started_at_ms))


def make_context(side, source_side, snapshot, now_ms, timestamp_basis="processing_clock", mechanical_context=None):
    shipped = manifest()
    resolved = snapshot.resolved if snapshot else shipped["defaults"]
    bundle = {"schemaVersion": 1, "manifestHash": config_hash(shipped),
              "resolved": resolved, "generation": snapshot.generation if snapshot else 0,
              "revisionId": snapshot.revision_id if snapshot else None,
              "components": shipped["components"], "sourceHashes": shipped["sourceHashes"]}
    return RunContext(str(uuid4()), side, source_side, json.dumps(bundle),
                      config_hash(resolved), now_ms, timestamp_basis, mechanical_context)


def restore_applied(connection, side):
    """Only restore a projection acknowledged by all three numerical consumers."""
    rows = connection.execute(
        "SELECT generation, applied_hash FROM biometric_runtime_receipts "
        "WHERE side = ? AND state = 'applied' AND effective_sample_time_ms IS NOT NULL "
        "AND component IN ('heart_rate', 'breathing_rate', 'hrv_index') "
        "GROUP BY generation, applied_hash HAVING COUNT(DISTINCT component) = 3 "
        "ORDER BY generation DESC LIMIT 1", (side,)).fetchone()
    if rows is None:
        return None
    row = connection.execute(
        "SELECT side, generation, resolved_hash, boundary, "
        "CASE WHEN length(CAST(payload AS BLOB)) <= 65536 THEN payload ELSE NULL END "
        "FROM biometric_runtime_configs WHERE side = ? AND generation = ?",
        (side, rows[0])).fetchone()
    if row is None:
        raise ValueError("Applied runtime projection is missing")
    snapshot = RuntimeSnapshot.parse(row[4])
    if (snapshot.side, snapshot.generation, snapshot.resolved_hash, snapshot.boundary) != tuple(row[:4]):
        raise ValueError("Applied runtime projection envelope mismatch")
    if (snapshot.side, snapshot.generation, snapshot.resolved_hash) != (side, rows[0], rows[1]):
        raise ValueError("Applied runtime projection disagrees with receipts")
    return snapshot


class RuntimeCoordinator:
    def __init__(self, holder, processors, clock=time.monotonic, wall=time.time,
                 timestamp_basis="processing_clock", mechanical_context=None):
        self.holder = holder
        self.processors = processors
        self.clock, self.wall = clock, wall
        self.timestamp_basis = timestamp_basis
        self.mechanical_context = mechanical_context
        self.selections = {side: BoundarySelection(side) for side in ("left", "right")}
        self.initialized = False
        self.enabled = False
        self.last_poll = float("-inf")
        self.problem = None
        self.effective_times = {}
        self._frame_sides = set()
        self._receipted = {}

    def _problem(self, error):
        problem = str(error)
        if problem != self.problem:
            log.warning("Biometric runtime configuration unavailable; retaining actual compatible configuration: %s", problem)
        self.problem = problem

    def _poll(self):
        if self.clock() - self.last_poll < 5:
            return
        self.last_poll = self.clock()
        try:
            conn = self.holder.conn
            # Activation requires both acknowledgment and provenance schema.
            conn.execute("SELECT processing_run_id FROM vitals LIMIT 0")
            conn.execute("SELECT id FROM biometric_processing_runs LIMIT 0")
            conn.execute("SELECT component FROM biometric_runtime_receipts LIMIT 0")
            problems = []
            for side, selection in self.selections.items():
                try:
                    if not self.initialized:
                        restored = restore_applied(conn, side)
                        selection = BoundarySelection(side, restored)
                        self.selections[side] = selection
                    snapshot = read_latest_snapshot(conn, side)
                    if snapshot:
                        selection.offer(snapshot)
                except ValueError as error:
                    selection.pending = None
                    problems.append(f"{side}: {error}")
            self.initialized = True
            self.enabled = True
            if problems:
                self._problem("; ".join(problems))
            else:
                self.problem = None
        except sqlite3.Error as error:
            for selection in self.selections.values():
                selection.pending = None
            self._problem(error)

    def before_frame(self, home, occupied, now_ms):
        """Install before accepting either physical channel's first new sample."""
        self._poll()
        self._frame_sides = set()
        if not self.enabled:
            return
        for side, selection in self.selections.items():
            if home is not None and side != home:
                continue
            ready = selection.ready(occupied(side))
            snapshot = ready or selection.applied
            for source_side, processor in self.processors.items():
                logical_side = home or source_side
                if logical_side != side:
                    continue
                key = (side, snapshot)
                if getattr(processor, "runtime_key", None) != key:
                    parameters = ProcessingParameters.from_config(snapshot.resolved if snapshot else manifest()["defaults"])
                    processor.install_runtime(parameters, make_context(side, source_side, snapshot, now_ms, self.timestamp_basis, self.mechanical_context),
                                              reset_side=getattr(processor, "runtime_key", (None,))[0] != side)
                    processor.runtime_key = key
            if ready:
                selection.commit(ready)
                self.effective_times[side] = now_ms
            elif side not in self.effective_times:
                # Restored config starts a new warmup after daemon restart.
                self.effective_times[side] = now_ms
            self._frame_sides.add(side)

    def after_frame(self, now_ms):
        """Receipt only after both channels have accepted this frame successfully."""
        if not self.enabled:
            return
        try:
            completed = {}
            with self.holder.conn:
                for side in self._frame_sides:
                    snapshot = self.selections[side].applied
                    if snapshot is None:
                        continue
                    prior = self._receipted.get(side)
                    identity = (snapshot.generation, snapshot.resolved_hash, self.effective_times[side])
                    if prior and prior[0] == identity and self.clock() - prior[1] < 30:
                        continue
                    for component in COMPONENTS:
                        self.holder.conn.execute(
                            "INSERT INTO biometric_runtime_receipts "
                            "(side, component, generation, applied_hash, effective_sample_time_ms, state, error, heartbeat_at_ms) "
                            "VALUES (?, ?, ?, ?, ?, 'applied', NULL, ?) "
                            "ON CONFLICT(side, component, generation) DO UPDATE SET "
                            "applied_hash=excluded.applied_hash, effective_sample_time_ms=excluded.effective_sample_time_ms, "
                            "state='applied', error=NULL, heartbeat_at_ms=excluded.heartbeat_at_ms",
                            (side, component, snapshot.generation, snapshot.resolved_hash,
                             self.effective_times[side], now_ms))
                    completed[side] = (identity, self.clock())
            self._receipted.update(completed)
        except sqlite3.Error as error:
            self._problem(error)
