"""Prospective adapter parity and failure boundaries using locked signal deps."""
from copy import deepcopy
from pathlib import Path
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.biometrics.config import manifest
from common.biometrics.live_input import FIRMWARE_TIMESTAMP_BASIS
from common.biometrics.replay import RecordedContext, WaveformReplay
from common.biometrics.shadow import ProspectiveShadow
from common.tests_support.mechanical import quiet_snapshot

START = 1_700_000_000_000
CONTEXT = RecordedContext(('left',), True, False, True)


def context_at(timestamp):
    return RecordedContext(('left',), True, False, True, quiet_snapshot(timestamp))


def configs():
    return {side: deepcopy(manifest()['defaults']) for side in ('left', 'right')}


def frames():
    for second in range(150):
        values = (np.sin((np.arange(500) + second * 500) / 500 * 2 * np.pi * 1.2) * 1_000_000).astype('<i4').tobytes()
        yield START + second * 1000, {'type': 'piezo-dual', 'ts': START / 1000 + second, 'left1': values, 'right1': bytes(2000)}


def shadow(sink, **changes):
    options = dict(side='left', start_ms=START, end_ms=START + 150000,
                   maximum_records=200, maximum_outputs=10, maximum_cpu_ms=30000, sink=sink)
    options.update(changes)
    return ProspectiveShadow(configs(), **options)


def test_prospective_adapter_matches_shared_firmware_time_core_and_stays_separate():
    expected, actual = [], []
    core = WaveformReplay(configs(), retained_start_ms=START, score_start_ms=START,
                          score_end_ms=START + 150000, sink=expected.append,
                          clock_mode=FIRMWARE_TIMESTAMP_BASIS)
    candidate = shadow(actual.append)
    for timestamp, record in frames():
        core.feed(timestamp, record, context_at(timestamp))
        candidate.feed(timestamp, record, context_at(timestamp))
    core.close()
    candidate.finish()
    assert actual and [row.reading for row in actual] == expected
    assert [row.sequence for row in actual] == list(range(len(actual)))
    assert all(row.reading.side == 'left' and len(row.input_hash) == 64 for row in actual)
    assert candidate.health()['state'] == 'completed'
    assert 'cold_start_without_serialized_state' in candidate.health()['limitations']
    assert 'event_time_replaces_arrival_time' not in candidate.health()['limitations']
    with pytest.raises(ValueError, match='stopped'):
        candidate.feed(START, {}, CONTEXT)


def test_independent_instances_are_deterministic_and_context_changes_identity():
    first, second = shadow(lambda _: None), shadow(lambda _: None)
    record = {'type': 'frzHealth', 'left': {'pumpRpm': 0}, 'right': {'pumpRpm': 0}}
    first.feed(START, record, CONTEXT)
    second.feed(START, record, CONTEXT)
    assert first.health()['input_hash'] == second.health()['input_hash']
    third = shadow(lambda _: None)
    third.feed(START, record, RecordedContext())
    assert third.health()['input_hash'] != first.health()['input_hash']
    assert 'missing_occupancy_context' in third.health()['limitations']


def test_cooperative_cpu_budget_discards_provisional_outputs_and_stops():
    emitted = []
    ticks = iter([0, 2_000_000])
    candidate = shadow(emitted.append, maximum_cpu_ms=1, cpu_clock=lambda: next(ticks))
    timestamp, record = next(frames())
    with pytest.raises(ValueError, match='CPU budget'):
        candidate.feed(timestamp, record, context_at(timestamp))
    assert emitted == [] and candidate.health()['state'] == 'failed'
    with pytest.raises(ValueError, match='stopped'):
        candidate.feed(timestamp, record, context_at(timestamp))


def test_record_budget_cancellation_and_invalid_frames_stop_processing():
    candidate = shadow(lambda _: None, maximum_records=1)
    candidate.feed(START, {'type': 'frzHealth'}, CONTEXT)
    with pytest.raises(ValueError, match='record budget'):
        candidate.feed(START + 1, {'type': 'frzHealth'}, CONTEXT)
    other = shadow(lambda _: pytest.fail('Cancelled processor emitted output'))
    other.stop()
    other.stop('retry')
    assert other.health()['reason'] == 'cancelled'
    with pytest.raises(ValueError, match='stopped'):
        other.finish()
    bad = shadow(lambda _: None)
    with pytest.raises(ValueError, match='bounded shadow channel'):
        bad.feed(START, {'type': 'piezo-dual', 'left1': bytes(20001)}, CONTEXT)
    assert bad.health()['state'] == 'failed'


def test_real_outputs_stop_at_quota_and_sink_failure_never_retries_silently():
    output = []
    candidate = shadow(output.append, maximum_outputs=1)
    with pytest.raises(ValueError, match='output budget'):
        for timestamp, record in frames():
            candidate.feed(timestamp, record, context_at(timestamp))
        candidate.finish()
    assert len(output) == 1 and output[0].sequence == 0
    assert candidate.health()['state'] == 'failed'

    attempted = []
    def failing_sink(row):
        attempted.append(row)
        raise RuntimeError('shadow storage unavailable')
    failed = shadow(failing_sink)
    with pytest.raises(RuntimeError, match='storage unavailable'):
        for timestamp, record in frames():
            failed.feed(timestamp, record, context_at(timestamp))
        failed.finish()
    assert len(attempted) == 1
    with pytest.raises(ValueError, match='stopped'):
        failed.finish()
    assert len(attempted) == 1


def test_failed_processing_retains_measured_cpu_and_clock_failures_stop_adapter():
    ticks = iter([10_000_000, 13_000_000])
    candidate = shadow(lambda _: pytest.fail('Failed input emitted output'),
                       cpu_clock=lambda: next(ticks))
    with pytest.raises(ValueError, match='Invalid shadow record'):
        candidate.feed(START, {'type': 'unknown'}, CONTEXT)
    assert candidate.health()['cpu_ms'] == 3
    assert candidate.health()['state'] == 'failed'

    for ticks in ([None], [True], [-1], [10, 9]):
        clock = iter(ticks)
        broken = shadow(lambda _: pytest.fail('Invalid clock emitted output'),
                        cpu_clock=lambda: next(clock))
        with pytest.raises(ValueError, match='CPU clock'):
            broken.feed(START, {'type': 'frzHealth'}, CONTEXT)
        assert broken.health()['state'] == 'failed'
        with pytest.raises(ValueError, match='stopped'):
            broken.feed(START + 1, {'type': 'frzHealth'}, CONTEXT)

    def unavailable():
        raise RuntimeError('clock unavailable')
    unavailable_clock = shadow(lambda _: None, cpu_clock=unavailable)
    with pytest.raises(RuntimeError, match='clock unavailable'):
        unavailable_clock.feed(START, {'type': 'frzHealth'}, CONTEXT)
    assert unavailable_clock.health()['state'] == 'failed'
