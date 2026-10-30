"""Whole-window exclusion, immutable retries and bounded failure recovery."""
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace

import pytest

from common.biometrics.mechanical import (
    MechanicalGate, MechanicalWriter, read_snapshot, validate_snapshot, MAX_PENDING,
)
from common.biometrics.live_input import LiveFrameClock, prepare_live_frame
from common.tests_support.mechanical import quiet_snapshot, SPAN

NOW = 1_700_000_000_000


@dataclass
class Reading:
    ts: datetime
    heart_rate: float = 60
    breathing_rate: float = 12
    hrv: float = 30
    flags: tuple = ()
    run_context: tuple = ('original_config', 'right', 'left')


def candidate(at=NOW):
    return Reading(datetime.fromtimestamp(at / 1000, timezone.utc))


def test_full_window_delays_output_preserving_values_time_and_destination_across_retry():
    gate, outputs = MechanicalGate(), []
    writable = [False]
    writer = MechanicalWriter(gate, lambda row, side: outputs.append((row, side)) or writable[0])
    gate.update(quiet_snapshot(NOW), NOW)
    reading = candidate()
    assert writer.submit(reading, 'left')
    assert not outputs  # Latest telemetry ends at t; candidate includes the t+1 frame edge.
    reading.heart_rate = 199  # Caller mutations cannot rewrite a held observation.
    gate.update(quiet_snapshot(NOW + 2000), NOW + 2000)
    writer.tick()
    assert len(writer.pending) == 1
    writable[0] = True
    gate.update(quiet_snapshot(NOW + 3000), NOW + 3000)
    writer.tick()
    assert not writer.pending
    assert len(outputs) == 2 and outputs[0] == outputs[1]
    saved, side = outputs[1]
    assert saved.heart_rate == 60 and saved.ts == candidate().ts and side == 'left'
    assert saved.run_context == reading.run_context
    assert saved.flags[0].endswith(f':{NOW - 301000}:{NOW + 1000}')


def test_current_quiet_does_not_qualify_a_window_that_crossed_interference():
    gate = MechanicalGate()
    writer = MechanicalWriter(gate, lambda *_: pytest.fail('Contaminated interval was written'))
    gate.update(quiet_snapshot(NOW, start=NOW - 10000), NOW)
    assert writer.submit(candidate())
    for offset in (5000, 30000, 119000):
        gate.update(quiet_snapshot(NOW + offset, start=NOW - 10000), NOW + offset)
        writer.tick()
    gate.update(quiet_snapshot(NOW + 120000), NOW + 120000)
    writer.tick()
    assert writer.pending == [] and writer.excluded == 1


def test_closed_span_can_complete_an_older_clean_candidate_without_accepting_new_frames():
    gate, output = MechanicalGate(), []
    writer = MechanicalWriter(gate, lambda row, _: output.append(row) or True)
    gate.update(quiet_snapshot(NOW), NOW)
    writer.submit(candidate())
    snapshot = quiet_snapshot(NOW + 3000, end=NOW + 2000)
    snapshot['state'].update(cleanSinceMs=None, spanId=None, reasons=['base_motion'])
    gate.update(snapshot, NOW + 3000)
    assert not gate.admit((NOW + 3000) / 1000)
    writer.tick()
    assert len(output) == 1


@pytest.mark.parametrize('change', [None, 'future', 'stale', 'unknown', 'blocked', 'reversed', 'missing_span'])
def test_missing_or_unavailable_mechanical_context_never_admits_frames(change):
    gate = MechanicalGate()
    snapshot = quiet_snapshot(NOW)
    if change is None:
        snapshot = None
    elif change == 'future':
        snapshot['state']['publishedAtMs'] += 1
    elif change == 'stale':
        snapshot['state']['publishedAtMs'] -= 10000
    elif change == 'unknown':
        snapshot['state']['reasons'] = ['base_unavailable']
    elif change == 'blocked':
        snapshot['state']['blockedUntilMs'] = NOW + 1000
    elif change == 'reversed':
        snapshot['state']['confirmedThroughMs'] = NOW + 1
    else:
        snapshot['state'].update(spanId=None, cleanSinceMs=None)
    try:
        gate.update(snapshot, NOW)
    except ValueError:
        # Invalid externally supplied worker context terminates the attempt.
        assert change in ('blocked', 'reversed', 'unknown', 'missing_span', 'stale')
    assert not gate.admit(NOW / 1000)


def test_gaps_and_new_spans_reset_unfinished_processor_buffers():
    gate = MechanicalGate()
    gate.update(quiet_snapshot(NOW), NOW)
    assert gate.admit(NOW / 1000) and gate.changed
    assert gate.admit(NOW / 1000) and not gate.changed
    snapshot = quiet_snapshot(NOW + 1000, span='3959cffb-c029-42c5-9f79-3d36bda042b4')
    gate.update(snapshot, NOW + 1000)
    assert gate.admit((NOW + 1000) / 1000) and gate.changed
    resets = []
    processor = SimpleNamespace(parameters=None, run_context=None, install_runtime=lambda *args, **kwargs: resets.append(kwargs))
    clock = LiveFrameClock(wall=lambda: NOW / 1000, monotonic=lambda: 1)
    gate.update(None, NOW + 2000)
    frame = prepare_live_frame({'ts': NOW / 1000}, clock, (processor,), SimpleNamespace(check=lambda *_: False), gate)
    assert frame.status == 'mechanical_gated_frames' and resets[-1]['reset_side']


def test_queue_is_bounded_and_clock_rollback_does_not_retime_pending_estimates():
    gate = MechanicalGate()
    gate.update(None, NOW)
    writer = MechanicalWriter(gate, lambda *_: pytest.fail('Missing evidence was written'))
    for _ in range(MAX_PENDING):
        assert writer.submit(candidate())
    assert not writer.submit(candidate())
    gate.update(None, NOW - 1)
    writer.tick()
    assert not writer.pending and writer.excluded == MAX_PENDING


def test_reader_uses_real_migration_and_withholds_missing_or_corrupt_state():
    connection = sqlite3.connect(':memory:')
    assert read_snapshot(connection, NOW) is None
    migration = Path(__file__).parents[2] / 'src/db/biometrics-migrations/0032_mechanical_signal_context.sql'
    connection.executescript(migration.read_text())
    snapshot = quiet_snapshot(NOW)
    connection.execute('INSERT INTO biometric_mechanical_state VALUES (1,?)', (json.dumps(snapshot['state']),))
    span = snapshot['spans'][0]
    connection.execute('INSERT INTO biometric_mechanical_spans VALUES (?,?,?,?)', tuple(span[key] for key in ('id', 'epoch', 'startMs', 'endMs')))
    assert read_snapshot(connection, NOW) == snapshot
    connection.execute("UPDATE biometric_mechanical_state SET payload='{}'")
    assert read_snapshot(connection, NOW) is None
    oversized = deepcopy(snapshot)
    oversized['spans'] *= 65
    with pytest.raises(ValueError):
        validate_snapshot(oversized)
    malformed = deepcopy(snapshot)
    malformed['state']['publishedAtMs'] = True
    with pytest.raises(ValueError):
        validate_snapshot(malformed)
    connection.close()
