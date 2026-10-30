"""Raw-frame replay checks using locked numerical dependencies and real estimates."""
from copy import deepcopy
from dataclasses import FrozenInstanceError
from pathlib import Path
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.biometrics.config import manifest, config_hash
from common.biometrics.replay import WaveformReplay, RecordedContext, MAX_CHANNEL_BYTES
from common.biometrics.frames import decode_int32_samples, LOST_SAMPLE

START = 1_700_000_000_000
KNOWN = RecordedContext(('left',), True, False, True)


def make_replay(sink, start=START + 60_000, end=START + 150_000):
    configs = {side: deepcopy(manifest()['defaults']) for side in ('left', 'right')}
    return WaveformReplay(configs, retained_start_ms=START,
                          score_start_ms=start, score_end_ms=end, sink=sink)


def frames():
    for second in range(150):
        samples = (np.sin((np.arange(500) + second * 500) / 500 * 2 * np.pi * 1.2)
                   * 1_000_000).astype('<i4').tobytes()
        yield START + second * 1000, {'type': 'piezo-dual', 'left1': samples, 'right1': bytes(2000)}


def test_replay_is_deterministic_and_scores_only_post_preroll_outputs():
    def run():
        output = []
        replay = make_replay(output.append)
        replay.feed(START, {'type': 'frzHealth', 'left': {'pumpRpm': 0}, 'right': {'pumpRpm': 0}}, KNOWN)
        for timestamp, record in frames():
            replay.feed(timestamp, record, KNOWN)
        replay.close()
        replay.close()
        return output, replay
    first, replay = run()
    second, _ = run()
    assert first == second
    assert first
    assert all(START + 60_000 <= row.timestamp_ms < START + 150_000 for row in first)
    assert all(row.side == 'left' and row.candidate.run_context.source_side == 'left' for row in first)
    assert all(row.candidate.run_context.config_hash == config_hash(manifest()['defaults']) for row in first)
    assert all(row.candidate.heart_rate is not None for row in first)
    assert replay.counts['preroll_outputs'] > 0
    assert replay.counts['scored_outputs'] == len(first)
    assert replay.counts['accepted_frames'] == 150
    assert 'cold_start_without_serialized_state' in first[0].limitations
    assert 'missing_pump_context' not in replay.limitations
    with pytest.raises(FrozenInstanceError):
        first[0].side = 'right'
    with pytest.raises(ValueError, match='closed'):
        replay.feed(START, {}, KNOWN)


def test_recorded_pump_guard_drops_frames_until_exact_event_time_boundary():
    replay = make_replay(lambda _: None, start=START, end=START + 20_000)
    context = RecordedContext(('left', 'right'), False, False, True)
    quiet = np.ones(500, dtype='<i4').tobytes()
    loud = np.full(500, 100, dtype='<i4').tobytes()
    def record(value):
        return {'type': 'piezo-dual', 'left1': value, 'right1': value}
    replay.feed(START, record(quiet), context)
    replay.feed(START + 1000, record(loud), context)
    replay.feed(START + 5999, record(quiet), context)
    replay.feed(START + 6000, record(quiet), context)
    assert replay.counts['accepted_frames'] == 2
    assert replay.counts['pump_gated_frames'] == 2


def test_missing_context_is_explicit_and_bad_frames_do_not_fill_buffers():
    replay = make_replay(lambda _: None)
    lost = np.full(500, LOST_SAMPLE, dtype='<i4').tobytes()
    replay.feed(START, {'type': 'piezo-dual', 'left1': lost, 'right1': bytes(2000)}, RecordedContext())
    assert replay.counts['empty_channel_frames'] == 1
    assert len(replay.processors['left']._hr_buf) == 0
    assert {'missing_sleeper_mode', 'missing_occupancy_context', 'missing_pump_context'} <= replay.limitations
    with pytest.raises(ValueError, match='ordered'):
        replay.feed(START - 1, {}, KNOWN)
    with pytest.raises(ValueError, match='ordered'):
        replay.feed(START + 150_000, {}, KNOWN)
    with pytest.raises(ValueError, match='bounded'):
        replay.feed(START + 1, {'left1': bytes(MAX_CHANNEL_BYTES + 1)}, KNOWN)
    assert replay.counts['records'] == 1


def test_shared_decoder_preserves_lost_sample_repair_and_truncated_tail():
    data = np.array([10, LOST_SAMPLE, 30], dtype='<i4').tobytes() + b'x'
    assert decode_int32_samples(data).tolist() == [10, 20, 30]
    assert decode_int32_samples(np.array([LOST_SAMPLE, LOST_SAMPLE], dtype='<i4').tobytes()).size == 0
    assert decode_int32_samples('not bytes').size == 0


def test_context_is_immutable_and_requires_unambiguous_types():
    for args in [(['left'], True, False, True), (('left',), 1, False, True), (('left',), True, False, 1)]:
        with pytest.raises(ValueError):
            RecordedContext(*args)
    with pytest.raises(FrozenInstanceError):
        KNOWN.left_occupied = False


def test_recorded_home_change_resets_both_channels_and_selects_fixed_logical_config():
    configs = {side: deepcopy(manifest()['defaults']) for side in ('left', 'right')}
    configs['right']['heart_rate']['trackingToleranceBpm'] = 20
    right_hash = config_hash(configs['right'])
    replay = WaveformReplay(configs, retained_start_ms=START, score_start_ms=START,
                            score_end_ms=START + 10_000, sink=lambda _: None)
    # Mutating caller input afterward cannot alter the replay's frozen parameters.
    configs['right']['heart_rate']['trackingToleranceBpm'] = 25
    record = {'type': 'piezo-dual', 'left1': bytes(2000), 'right1': bytes(2000)}
    replay.feed(START, record, KNOWN)
    for side, processor in replay.processors.items():
        assert processor.run_context.side == 'left'
        assert processor.run_context.source_side == side
        assert len(processor._hr_buf) == 500
    replay.feed(START + 1000, record, RecordedContext(('right',), False, True, True))
    for processor in replay.processors.values():
        assert processor.parameters.tracking_tolerance_bpm == 20
        assert processor.run_context.side == 'right'
        assert processor.run_context.config_hash == right_hash
        assert len(processor._hr_buf) == 500  # New logical side starts a fresh buffer.


def test_retained_replay_matches_legacy_arrival_clock_adapter_for_identical_inputs(monkeypatch):
    import main
    from types import SimpleNamespace

    now = [START / 1000]
    monkeypatch.setattr(main.time, 'time', lambda: now[0])
    live_output = []

    def write(_holder, side, ts, hr, hrv, br, **metadata):
        if START + 60_000 <= round(ts.timestamp() * 1000) < START + 150_000:
            live_output.append((side, ts, hr, hrv, br, metadata['quality_score'],
                                tuple(metadata['flags'] or ()), metadata['hr_raw']))
        return True

    monkeypatch.setattr(main, 'write_vitals', write)
    mode = SimpleNamespace(home_side=lambda: 'left', active_sides=lambda: ('left',))
    pump = main.FrzHealthPumpState(clock=lambda: now[0])
    gate = main.PumpGate(clock=lambda: now[0])
    router = main.SingleSleeperVitals(None, mode, clock=lambda: now[0])
    left = main.SideProcessor('left', None, pump_state=pump)
    right = main.SideProcessor('right', None, pump_state=pump)
    left._other, right._other = right, left
    for processor in (left, right):
        processor.sink = router.submit
        processor.home_side = mode.home_side
        processor.bed_occupied = lambda: True
    replay_output = []
    replay = make_replay(replay_output.append)
    for timestamp, record in frames():
        now[0] = timestamp / 1000
        router.tick()
        l_samples = main._int32_samples(record['left1'])
        r_samples = main._int32_samples(record['right1'])
        if not gate.check(l_samples, r_samples):
            left.ingest(l_samples)
            right.ingest(r_samples)
        replay.feed(timestamp, record, KNOWN)
    router.flush()
    replay.close()
    projected = [(row.side, row.candidate.ts, row.candidate.heart_rate,
                  row.candidate.hrv, row.candidate.breathing_rate,
                  row.candidate.quality_score, tuple(row.candidate.flags or ()),
                  row.candidate.hr_raw) for row in replay_output]
    assert projected
    assert projected == live_output
