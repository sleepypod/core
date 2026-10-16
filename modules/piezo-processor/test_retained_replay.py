"""Retained gzip -> bounded CBOR -> shared numerical replay integration."""
from copy import deepcopy
from dataclasses import asdict
import gzip
from pathlib import Path
import struct
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.biometrics.config import manifest
from common.biometrics.raw_artifacts import RawArtifactStore, RawLimits
from common.biometrics.retained_replay import RetainedReplayInput, replay_retained
from test_waveform_replay import frames, START, KNOWN, make_replay


# Encode the small fixture subset without importing cbor2, which existing live
# adapter tests intentionally stub globally during collection.
def encode(value):
    if isinstance(value, dict):
        return bytes([0xa0 + len(value)]) + b''.join(encode(key) + encode(item) for key, item in value.items())
    if isinstance(value, str):
        return bytes([0x60 + len(value)]) + value.encode()
    if isinstance(value, bytes):
        return b'\x5a' + struct.pack('>I', len(value)) + value
    return b'\xfb' + struct.pack('>d', value)


def fixture(tmp_path, records=None, split_at=76):
    records = records if records is not None else [
        (START, {'type': 'frzHealth', 'left': {'pumpRpm': 0}, 'right': {'pumpRpm': 0}}), *frames()]
    archive = tmp_path / 'archive'
    archive.mkdir()
    store = RawArtifactStore(tmp_path / 'retained', RawLimits(1_000_000, 2_000_000, 4_000_000, 1))
    selected = []
    for index, group in enumerate([records[:split_at], records[split_at:]]):
        if not group:
            continue
        data = b''
        for timestamp, record in group:
            payload = encode({**record, 'ts': timestamp / 1000})
            data += b'\xa2\x63seq\x01\x64data\x5a' + struct.pack('>I', len(payload)) + payload
        name = f'{index}.RAW.gz'
        (archive / name).write_bytes(gzip.compress(data, mtime=0))
        artifact = store.retain(archive, name)
        selected.append({'artifact': asdict(artifact), 'first_event_ms': min(t for t, _ in group), 'last_event_ms': max(t for t, _ in group)})
        (archive / name).unlink()
    snapshot = {'version': 'retained-waveform-input-v1', 'retained_start_ms': START,
        'score_start_ms': START + 60000, 'score_end_ms': START + 150000, 'artifacts': selected,
        'contexts': [{'start_ms': START, 'end_ms': START + 150000,
            'active_sides': ['left'], 'left_occupied': True, 'right_occupied': False, 'pump_context_known': True}]}
    return store, snapshot, records


def run(store, snapshot, sink, **options):
    return replay_retained(store, snapshot,
        {side: deepcopy(manifest()['defaults']) for side in ('left', 'right')}, sink, **options)


def test_retained_files_match_direct_numerical_driver_after_original_archives_are_deleted(tmp_path):
    store, snapshot, records = fixture(tmp_path)
    expected, actual = [], []
    replay = make_replay(expected.append)
    for timestamp, record in records:
        replay.feed(timestamp, record, KNOWN)
    replay.close()
    result = run(store, snapshot, actual.append)
    assert actual == expected
    assert actual
    assert result['counts'] == replay.counts
    assert result['config_hashes'] == replay.hashes
    assert result['decoded_records'] == 151
    assert result['artifact_hashes'] == [item['artifact']['sha256'] for item in snapshot['artifacts']]
    assert result['limitations'] == sorted(replay.limitations)
    again = []
    assert run(store, snapshot, again.append) == result
    assert again == actual


def test_context_gaps_are_unknown_and_caller_mutation_cannot_change_frozen_timeline(tmp_path):
    store, snapshot, _ = fixture(tmp_path)
    snapshot['contexts'][0]['end_ms'] = START + 90000
    frozen = RetainedReplayInput.parse(snapshot)
    snapshot['contexts'][0]['active_sides'].append('right')
    assert frozen.contexts[0].context.active_sides == ('left',)
    snapshot['contexts'][0]['active_sides'] = ['left']
    output = []
    result = run(store, snapshot, output.append)
    assert {'missing_sleeper_mode', 'missing_occupancy_context', 'missing_pump_context'} <= set(result['limitations'])
    assert any('missing_occupancy_context' in row.limitations for row in output)


def test_rejects_overlaps_duplicates_unknown_versions_and_bad_context_before_outputs(tmp_path):
    store, snapshot, _ = fixture(tmp_path)
    bad_inputs = []
    bad = deepcopy(snapshot)
    bad['artifacts'][1]['first_event_ms'] = bad['artifacts'][0]['last_event_ms'] - 1
    bad_inputs.append(bad)
    bad = deepcopy(snapshot)
    bad['artifacts'].append(bad['artifacts'][0])
    bad_inputs.append(bad)
    bad = deepcopy(snapshot)
    bad['contexts'].append(bad['contexts'][0])
    bad_inputs.append(bad)
    bad = deepcopy(snapshot)
    bad['contexts'][0]['left_occupied'] = 1
    bad_inputs.append(bad)
    bad_inputs.extend([{**snapshot, 'version': 'future'}, {**snapshot, 'extra': True}, {**snapshot, 'artifacts': []}])
    for bad in bad_inputs:
        output = []
        with pytest.raises(ValueError):
            run(store, bad, output.append)
        assert not output


def test_rejects_incorrect_inspection_bounds_and_record_reversals(tmp_path):
    store, snapshot, _ = fixture(tmp_path)
    snapshot['artifacts'][0]['first_event_ms'] -= 1
    with pytest.raises(ValueError, match='differ from inspected'):
        run(store, snapshot, lambda _: None)
    snapshot['artifacts'][0]['first_event_ms'] += 2
    with pytest.raises(ValueError, match='outside inspected'):
        run(store, snapshot, lambda _: None)
    other = tmp_path / 'reversed'
    other.mkdir()
    store, snapshot, _ = fixture(other, [(START + offset, {'type': 'frzHealth'}) for offset in (0, 2000, 1000, 3000)])
    with pytest.raises(ValueError, match='reversed'):
        run(store, snapshot, lambda _: None)


def test_cancellation_output_and_decode_budgets_fail_without_successful_result(tmp_path):
    store, snapshot, _ = fixture(tmp_path)
    with pytest.raises(ValueError, match='cancelled'):
        run(store, snapshot, lambda _: None, cancelled=lambda: True)
    with pytest.raises(ValueError, match='record.*budget|record count'):
        run(store, snapshot, lambda _: None, maximum_records=100)
    with pytest.raises(ValueError, match='output budget'):
        run(store, snapshot, lambda _: None, maximum_readings=1)
    cancelled = [False]
    output = []
    def sink(row):
        output.append(row)
        cancelled[0] = True
    with pytest.raises(ValueError, match='cancelled'):
        run(store, snapshot, sink, cancelled=lambda: cancelled[0])
    assert len(output) == 1


def test_missing_artifact_never_falls_back_to_a_rolling_archive(tmp_path):
    store, snapshot, _ = fixture(tmp_path)
    (store.directory / snapshot['artifacts'][0]['artifact']['name']).unlink()
    with pytest.raises(FileNotFoundError):
        run(store, snapshot, lambda _: None)


def test_pod5_pump_records_stamped_ahead_replay_like_time_ordered_input(tmp_path):
    # Pod 5 writes each frzHealth stamped a second ahead of the piezo frame after it.
    pumps = [(START + offset, {'type': 'frzHealth', 'left': {'pumpRpm': 0}, 'right': {'pumpRpm': 0}}) for offset in range(1000, 150000, 10000)]
    ordered = sorted([*frames(), *pumps], key=lambda item: item[0])
    written = []
    for timestamp, record in ordered:
        if record['type'] == 'frzHealth' and written and written[-1][1]['type'] != 'frzHealth':
            written.insert(len(written) - 1, (timestamp, record))
        else:
            written.append((timestamp, record))
    assert written != ordered
    outputs = {}
    for name, records in (('ordered', ordered), ('written', written)):
        folder = tmp_path / name
        folder.mkdir()
        store, snapshot, _ = fixture(folder, records, split_at=len(records) // 2)
        rows = []
        run(store, snapshot, rows.append)
        outputs[name] = [(row.side, row.timestamp_ms, row.candidate.heart_rate) for row in rows]
    assert outputs['written'] == outputs['ordered'] and outputs['ordered']
