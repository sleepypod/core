"""Observed mechanical context and bounded, immutable vital-output quarantine.

Vibration evidence is command-derived, not a physical vibration measurement.
No hardware control and no inference that an absent base is stationary.
"""
from copy import deepcopy
from dataclasses import replace
import json
import math
import sqlite3
from uuid import UUID

VERSION = 'mechanical-context-v1'
FRESH_MS = 10_000
MAX_PENDING = 16
MAX_WAIT_MS = 120_000
REASONS = {'priming', 'vibration_command', 'base_motion', 'device_unavailable',
           'base_unavailable', 'alarm_state_unavailable', 'settling',
           'controller_restart', 'controller_stopped', 'clock_regression', 'observation_gap'}


def _time(value):
    if type(value) is not int or not 0 <= value <= 9_007_199_254_740_991:
        raise ValueError('Invalid mechanical timestamp')
    return value


def _uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError('Invalid mechanical identity')


def validate_snapshot(value):
    """Validate independently of TypeScript: worker inputs are not trusted."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'state', 'spans'}:
        raise ValueError('Invalid mechanical snapshot')
    state = value['state']
    fields = {'version', 'epoch', 'publishedAtMs', 'confirmedThroughMs', 'validUntilMs',
              'blockedUntilMs', 'cleanSinceMs', 'spanId', 'reasons', 'commandAtMs', 'commandUntilMs'}
    if not isinstance(state, dict) or set(state) != fields or state['version'] != VERSION:
        raise ValueError('Invalid mechanical state')
    _uuid(state['epoch'])
    for key in ('publishedAtMs', 'validUntilMs', 'blockedUntilMs', 'commandUntilMs'):
        _time(state[key])
    for key in ('confirmedThroughMs', 'cleanSinceMs', 'commandAtMs'):
        if state[key] is not None:
            _time(state[key])
    if (state['cleanSinceMs'] is None) != (state['spanId'] is None):
        raise ValueError('Mechanical span identity mismatch')
    if state['spanId'] is not None:
        _uuid(state['spanId'])
    if (not isinstance(state['reasons'], list) or len(state['reasons']) > 12
            or any(not isinstance(reason, str) or reason not in REASONS for reason in state['reasons'])):
        raise ValueError('Invalid mechanical reasons')
    confirmed = state['confirmedThroughMs']
    if confirmed is not None and confirmed > state['publishedAtMs']:
        raise ValueError('Future mechanical observation')
    if state['cleanSinceMs'] is None:
        if not state['reasons']:
            raise ValueError('Missing mechanical reason')
    elif (state['reasons'] or confirmed is None
          or not state['blockedUntilMs'] <= state['cleanSinceMs'] <= confirmed
          or state['validUntilMs'] != confirmed + FRESH_MS):
        raise ValueError('Invalid quiet evidence')
    spans = value['spans']
    if not isinstance(spans, list) or len(spans) > 64:
        raise ValueError('Mechanical history exceeds bound')
    for span in spans:
        if not isinstance(span, dict) or set(span) != {'id', 'epoch', 'startMs', 'endMs'}:
            raise ValueError('Invalid mechanical span')
        _uuid(span['id'])
        _uuid(span['epoch'])
        if _time(span['startMs']) > _time(span['endMs']):
            raise ValueError('Reversed mechanical span')
    return deepcopy(value)


def read_snapshot(connection, now_ms):
    """Read a coherent bounded SQLite snapshot; never create a missing schema."""
    try:
        _time(now_ms)
        # SAVEPOINT works whether the caller already owns a transaction or not.
        connection.execute('SAVEPOINT mechanical_read')
        try:
            row = connection.execute('SELECT CASE WHEN length(CAST(payload AS BLOB)) <= 8192 '
                                     'THEN payload END FROM biometric_mechanical_state WHERE id=1').fetchone()
            if row is None:
                return None
            state = json.loads(row[0])
            rows = connection.execute('SELECT id, epoch, start_ms, end_ms FROM biometric_mechanical_spans '
                'WHERE end_ms >= ? AND end_ms <= ? ORDER BY end_ms DESC, id DESC LIMIT 64',
                (now_ms - 600_000, now_ms)).fetchall()
            return validate_snapshot({'state': state, 'spans': [dict(zip(('id', 'epoch', 'startMs', 'endMs'), row)) for row in rows]})
        finally:
            connection.execute('RELEASE mechanical_read')
    except (sqlite3.Error, ValueError, TypeError, KeyError):
        return None


class MechanicalGate:
    """Hold source-time evidence; processing a cached status cannot extend it."""
    def __init__(self):
        self.snapshot = None
        self.now_ms = 0
        self.generation = None
        self.changed = True
        self.problem = 'Mechanical context unavailable'

    def update(self, snapshot, now_ms):
        try:
            _time(now_ms)
            snapshot = validate_snapshot(snapshot)
        except ValueError:
            self.snapshot = None
            self.generation = None
            raise
        if snapshot is not None:
            state = snapshot['state']
            previous = self.snapshot['state'] if self.snapshot else None
            if (now_ms < self.now_ms or state['publishedAtMs'] > now_ms
                    or now_ms - state['publishedAtMs'] >= FRESH_MS
                    or (previous and state['publishedAtMs'] < previous['publishedAtMs'])
                    or any(span['endMs'] > now_ms for span in snapshot['spans'])):
                snapshot = None
        self.snapshot, self.now_ms = snapshot, now_ms

    def admit(self, timestamp):
        state = self.snapshot['state'] if self.snapshot else None
        generation = None
        if (state and state['cleanSinceMs'] is not None and not state['reasons']
                and state['confirmedThroughMs'] is not None
                and state['confirmedThroughMs'] <= self.now_ms < state['validUntilMs']
                and state['validUntilMs'] <= state['confirmedThroughMs'] + FRESH_MS
                and state['blockedUntilMs'] <= state['cleanSinceMs'] <= state['confirmedThroughMs']
                and any(span['id'] == state['spanId'] and span['epoch'] == state['epoch']
                        and span['startMs'] == state['cleanSinceMs'] and span['endMs'] == state['confirmedThroughMs']
                        for span in self.snapshot['spans'])
                and type(timestamp) in (int, float) and math.isfinite(timestamp)
                and timestamp * 1000 - 1000 >= state['cleanSinceMs']):
            generation = state['epoch'], state['spanId']
        self.changed = generation != self.generation
        self.generation = generation
        self.problem = None if generation else 'Mechanical context unavailable or interference window active'
        return generation is not None

    def proof(self, candidate):
        if not self.snapshot:
            return None
        duration = max(30 if candidate.heart_rate is not None else 0,
                       60 if candidate.breathing_rate is not None else 0,
                       300 if candidate.hrv is not None else 0)
        if not duration:
            return None
        # Firmware frame boundary convention is not independently qualified.
        # Include one second on both edges, never shift its event timestamp.
        start = math.floor(candidate.ts.timestamp() * 1000) - duration * 1000 - 1000
        end = math.ceil(candidate.ts.timestamp() * 1000) + 1000
        for span in self.snapshot['spans']:
            if span['startMs'] <= start and span['endMs'] >= end:
                return f'mechanical_context_v1:{span["epoch"]}:{span["id"]}:{start}:{end}'
        return None


class MechanicalWriter:
    """Hold completed candidates until observations cover their entire window.

    At most 16 candidates for at most two minutes. A DB retry retains values,
    event timestamp, logical destination, configuration and source channel.
    Expiry is a counted exclusion, never a later timestamp or replacement value.
    """
    def __init__(self, gate, writer):
        self.gate, self.writer = gate, writer
        self.pending = []
        self.excluded = 0

    def submit(self, candidate, destination=None):
        self.tick()
        if len(self.pending) >= MAX_PENDING:
            return False
        self.pending.append((deepcopy(candidate), destination, self.gate.now_ms))
        self.tick()
        return True

    def tick(self):
        remaining = []
        for candidate, destination, queued_at in self.pending:
            if not 0 <= self.gate.now_ms - queued_at < MAX_WAIT_MS:
                self.excluded += 1
                continue
            proof = self.gate.proof(candidate)
            proven = replace(candidate, flags=tuple(candidate.flags or ()) + (proof,)) if proof else None
            if proven is None or not self.writer(proven, destination):
                remaining.append((candidate, destination, queued_at))
        self.pending = remaining
