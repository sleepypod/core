"""Acknowledge actual fresh-frame adoption, never an assumed daemon restart.

The controller owns the immutable intent. Consumers reset their own sessions or
windows before acknowledging it; this module cannot reopen hardware admission.
Legacy solo installations have no intent and retain their existing processing.
"""
import json
import math
import re
import sqlite3
import time
from uuid import UUID, uuid4

from common.biometrics.config import config_hash

COMPONENTS = ("sleep-detector", "piezo-processor")
MAX_INTENT_BYTES = 16384
MAX_AGE_MS = 10000


def _integer(value, minimum=1):
    return type(value) is int and minimum <= value <= 9007199254740991


def _uuid(value):
    try:
        if not isinstance(value, str):
            return False
        identifier = UUID(value)
        # Swift UUID.uuidString is uppercase; retain its spelling in the receipt hash.
        return (str(identifier) == value.lower()
                and (identifier.version in range(1, 9) or identifier.int in (0, (1 << 128) - 1)))
    except ValueError:
        return False


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate arrangement field")
        result[key] = value
    return result


def parse_intent(payload):
    """Bound and validate the same small contract as arrangementProcessing.ts."""
    if not isinstance(payload, str) or len(payload.encode("utf-8")) > MAX_INTENT_BYTES:
        raise ValueError("Arrangement intent missing or oversized")
    try:
        value = json.loads(payload, object_pairs_hook=_unique_object)
    except (RecursionError, json.JSONDecodeError) as error:
        raise ValueError("Invalid arrangement intent") from error
    fields = {"version", "operationId", "householdId", "datasetId", "assignmentRevision", "committedAt", "mode", "profiles"}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("Invalid arrangement fields")
    if type(value["version"]) is not int or value["version"] != 1 or value["mode"] != "two":
        raise ValueError("Unsupported arrangement version or mode")
    if not all(_uuid(value[key]) for key in ("operationId", "householdId", "datasetId")):
        raise ValueError("Invalid arrangement identity")
    if not _integer(value["assignmentRevision"]) or not _integer(value["committedAt"]) or value["committedAt"] > 8640000000000000:
        raise ValueError("Invalid arrangement revision or time")
    profiles = value["profiles"]
    if not isinstance(profiles, dict) or set(profiles) != {"left", "right"}:
        raise ValueError("Both arrangement profiles are required")
    for profile in profiles.values():
        if (not isinstance(profile, dict) or set(profile) != {"generation", "hash"}
                or not _integer(profile["generation"]) or not isinstance(profile["hash"], str)
                or re.fullmatch(r"[a-f0-9]{64}", profile["hash"]) is None):
            raise ValueError("Invalid arrangement profile")
    return value


def read_intent(path):
    """One read-only configuration snapshot. Missing/corrupt assigned intent is never legacy mode."""
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2.0)
    try:
        connection.execute("BEGIN")
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='households'").fetchone():
            return None
        households = connection.execute("SELECT id, assignment_revision, effective_at FROM households WHERE mode='assigned' LIMIT 2").fetchall()
        if not households:
            return None
        if len(households) != 1:
            raise ValueError("Ambiguous assigned household")
        household_id, revision, effective_at = households[0]
        row = connection.execute(
            "SELECT id, committed_at, CASE WHEN length(CAST(processing AS BLOB)) <= ? THEN processing ELSE NULL END "
            "FROM household_arrangement_transitions WHERE household_id=? AND state='committed' "
            "ORDER BY committed_at DESC LIMIT 1", (MAX_INTENT_BYTES, household_id)).fetchone()
        if row is None:
            raise ValueError("Assigned arrangement has no processing intent")
        intent = parse_intent(row[2])
        if (intent["operationId"], intent["committedAt"], intent["householdId"], intent["assignmentRevision"]) != (row[0], row[1], household_id, revision) or effective_at != row[1]:
            raise ValueError("Arrangement intent disagrees with current assignment")
        device = connection.execute("SELECT id, bed_mode FROM device_settings LIMIT 2").fetchall()
        sides = connection.execute("SELECT side, away_mode FROM side_settings ORDER BY side").fetchall()
        if device != [(1, "two")] or sides != [("left", 0), ("right", 0)]:
            raise ValueError("Arrangement routing differs from the reviewed mode")
        for side, expected in intent["profiles"].items():
            binding = connection.execute("SELECT generation, desired_revision_id FROM biometric_profile_bindings WHERE side=?", (side,)).fetchone()
            if binding != (expected["generation"], None):
                raise ValueError("Arrangement profile was changed")
        return intent
    finally:
        connection.close()


class ArrangementProcessing:
    """A two-phase consumer: before_frame resets; after_frame confirms actual processing.

    SQLite failures stop assigned processing and acknowledgments. No timer can
    turn a reset attempt or a cached configuration into a successful adoption.
    """
    def __init__(self, config_path, connection, component, reset, clock=time.monotonic, wall=time.time):
        if component not in COMPONENTS:
            raise ValueError("Unknown arrangement consumer")
        self.config_path, self.connection, self.component, self.reset = config_path, connection, component, reset
        self.clock, self.wall = clock, wall
        self.process_id = str(uuid4())
        self.problem = None
        self.intent = None
        self.required = False
        self._last_poll = None
        self._adopted_hash = None
        self._first_sample = None
        self._latest_sample = None
        self._frame_sample = None
        self._last_receipt = None

    def _poll(self):
        now = self.clock()
        if self._last_poll is not None and 0 <= now - self._last_poll < 1:
            return
        self._last_poll = now
        try:
            intent = read_intent(self.config_path)
            if intent is None and self.required:
                raise ValueError("Assigned processing intent disappeared")
            if intent is not None:
                self.required = True
                source = self.connection().execute("SELECT id, dataset_id, created_at_ms FROM biometric_history_identity LIMIT 2").fetchall()
                now_ms = int(self.wall() * 1000)
                if (len(source) != 1 or source[0][0:2] != (1, intent["datasetId"])
                        or not _integer(source[0][2]) or source[0][2] > now_ms or intent["committedAt"] > now_ms):
                    raise ValueError("Arrangement recording source or clock changed")
            self.intent, self.problem = intent, None
        except (sqlite3.Error, ValueError, OSError) as error:
            self.problem = str(error)

    def before_frame(self, sample_ms):
        self._frame_sample = None
        self._poll()
        if self.problem:
            return False
        if self.intent is None:
            return True
        now_ms = self.wall() * 1000
        if (type(sample_ms) not in (int, float) or not 0 < sample_ms <= 8640000000000000 or not math.isfinite(sample_ms)
                or not self.intent["committedAt"] <= sample_ms <= now_ms
                or now_ms - sample_ms > MAX_AGE_MS
                or (self._latest_sample is not None and int(sample_ms) <= self._latest_sample)):
            return False
        identity = config_hash(self.intent)
        if identity != self._adopted_hash:
            if not self.reset(self.intent):
                return False
            self._adopted_hash = identity
            self._first_sample = self._latest_sample = self._last_receipt = None
        self._frame_sample = int(sample_ms)
        return True

    def after_frame(self, sample_ms):
        """Call only after the consumer accepted usable sensor data under the requested mode."""
        if self.intent is None or self._frame_sample != sample_ms:
            return
        self._frame_sample = None
        self._latest_sample = int(sample_ms)
        if self._first_sample is None:
            self._first_sample = int(sample_ms)
        now = self.clock()
        if self._last_receipt is not None and 0 <= now - self._last_receipt < 1:
            return
        try:
            connection = self.connection()
            with connection:
                connection.execute(
                    "INSERT INTO household_processing_receipts (operation_id, component, process_id, intent_hash, "
                    "first_sample_ms, latest_sample_ms, heartbeat_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(operation_id, component) DO UPDATE SET process_id=excluded.process_id, "
                    "intent_hash=excluded.intent_hash, first_sample_ms=excluded.first_sample_ms, "
                    "latest_sample_ms=excluded.latest_sample_ms, heartbeat_at_ms=excluded.heartbeat_at_ms",
                    (self.intent["operationId"], self.component, self.process_id, self._adopted_hash,
                     self._first_sample, self._latest_sample, int(self.wall() * 1000)))
            self._last_receipt = now
        except sqlite3.Error as error:
            self.problem = str(error)
