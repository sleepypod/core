"""Bounded CBOR decoding against captured firmware and malformed archives."""
import base64
from dataclasses import replace
import gzip
import importlib.util
from pathlib import Path

import pytest
import cbor2

from common.biometrics import raw_records
from common.biometrics.raw_records import decode_record, DecodeLimits, iter_retained_records
from common.biometrics.raw_artifacts import RawArtifactStore, RawLimits
from common.nats_capture_fixtures import CAPTURE_FIXTURES

# Other follower tests stub the outer parser during collection. Use its actual
# source for this integration test, matching test_cbor_raw's isolation strategy.
spec = importlib.util.spec_from_file_location('_retained_raw_parser', Path(__file__).with_name('cbor_raw.py'))
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)


@pytest.fixture(autouse=True)
def real_outer_parser(monkeypatch):
    monkeypatch.setattr(raw_records, 'read_raw_record', parser.read_raw_record)


@pytest.mark.parametrize('fixture', list(CAPTURE_FIXTURES.values()))
def test_decodes_actual_firmware_indefinite_maps(fixture):
    payload = base64.b64decode(fixture['payload_b64'])
    record = decode_record(payload)
    assert record == cbor2.loads(payload)
    assert record['type'] == fixture['type']
    assert isinstance(record['ts'], (int, float))
    if record['type'] == 'piezo-dual':
        assert len(record['left1']) == len(record['right1']) == 2000


def test_rejects_huge_declared_containers_without_allocating_them():
    for prefix in [b'\x9b', b'\xbb']:
        with pytest.raises(ValueError, match='container budget'):
            decode_record(prefix + b'\xff' * 8)
    with pytest.raises(ValueError, match='string budget'):
        decode_record(b'\x5b' + b'\xff' * 8)


@pytest.mark.parametrize('payload', [
    b'\xbf\x64type\x61x\x64type\x61y\xff',  # Duplicate indefinite key.
    b'\xa2\x64type\x61x\x64type\x61y',       # Duplicate definite key.
    b'\xa1\x01\x61x',                           # Non-text key.
    b'\xa1\x64type\x61x\x00',                  # Trailing second value.
    b'\xa1\x64type\xc0\x61x',                  # Semantic tag.
    b'\xbf\x64type\x61x',                       # Missing break.
    b'\xa1\x64type\x7f\x61\xc3\x61\xa9\xff',  # Invalid UTF-8 chunks.
])
def test_rejects_ambiguous_or_malformed_records(payload):
    with pytest.raises(ValueError):
        decode_record(payload)


def test_depth_nodes_bytes_and_indefinite_chunk_budgets():
    with pytest.raises(ValueError, match='nesting'):
        decode_record(b'\x81' * 18 + b'\x00')
    with pytest.raises(ValueError, match='node budget'):
        decode_record(b'\x9f' + b'\x00' * 8 + b'\xff', replace(DecodeLimits(), nodes=5))
    with pytest.raises(ValueError, match='byte budget'):
        decode_record(b'x' * 10, replace(DecodeLimits(), record_bytes=9))
    with pytest.raises(ValueError, match='string budget'):
        decode_record(b'\x5f\x43abc\x43def\xff', replace(DecodeLimits(), string_bytes=5))


def test_numeric_and_chunked_values_preserve_wire_semantics():
    payload = (b'\xbf\x64type\x61x\x61v\x9f\x20\xf5\xf4\xf6'
               b'\xfa\x3f\xc0\x00\x00\xf9\x3e\x00\xff'
               b'\x61b\x5f\x42ab\x41c\xff\xff')
    assert decode_record(payload) == {'type': 'x', 'v': [-1, True, False, None, 1.5, 1.5], 'b': b'abc'}


def envelope(payload):
    return b'\xa2\x63seq\x01\x64data\x5a' + len(payload).to_bytes(4, 'big') + payload


def retain(tmp_path, payload):
    archive = tmp_path / 'archive'
    archive.mkdir(exist_ok=True)
    (archive / '1.RAW.gz').write_bytes(gzip.compress(payload, mtime=0))
    store = RawArtifactStore(tmp_path / 'retained', RawLimits(4096, 65536, 8192, 1))
    return store, store.retain(archive, '1.RAW.gz')


def test_streams_verified_records_and_counts_placeholders_against_budget(tmp_path):
    payload = b'\xa1\x64type\x61x'
    store, descriptor = retain(tmp_path, envelope(b'') + envelope(payload) + envelope(payload))
    assert list(iter_retained_records(store, descriptor)) == [{'type': 'x'}, {'type': 'x'}]
    with pytest.raises(ValueError, match='record count'):
        list(iter_retained_records(store, descriptor, max_records=2))


@pytest.mark.parametrize('tail', [b'\xa2', b'\xa2\x63seq\x01', envelope(b'abc')[:-1]])
def test_rejects_truncated_retained_outer_record_instead_of_silent_eof(tmp_path, tail):
    store, descriptor = retain(tmp_path, tail)
    with pytest.raises(ValueError, match='Truncated retained RAW framing'):
        list(iter_retained_records(store, descriptor))


def test_inventory_uses_retained_frames_without_inventing_missing_context(tmp_path):
    payload = base64.b64decode(CAPTURE_FIXTURES['raw.sens.piezo']['payload_b64'])
    store, descriptor = retain(tmp_path, envelope(payload) + envelope(payload))
    result = raw_records.inventory_retained(store, descriptor)
    assert result['ordered_waveform_available'] is True
    assert result['usable_dual_frames'] == 2
    assert result['duplicate_timestamps'] == 1
    assert result['first_event_ms'] == result['last_event_ms']
    assert result['channels']['left1']['samples'] == 1000
    assert result['channels']['right1']['samples'] == 1000
    assert result['pump_records'] == 0
    assert result['artifact_sha256'] == descriptor.sha256


def test_inventory_exposes_missing_times_and_does_not_claim_replayability(tmp_path):
    # Definite map: type=piezo-dual, no ts or sample channels.
    payload = b'\xa1\x64type\x6apiezo-dual'
    store, descriptor = retain(tmp_path, envelope(payload))
    result = raw_records.inventory_retained(store, descriptor)
    assert result['invalid_timestamps'] == 1
    assert result['empty_channel_frames'] == 1
    assert result['ordered_waveform_available'] is False
    assert result['first_event_ms'] is None


def piezo_record(timestamp, channel=b'\x01\x00\x00\x00'):
    encoded_time = b'\x1a' + timestamp.to_bytes(4, 'big')
    encoded_channel = b'\x59' + len(channel).to_bytes(2, 'big') + channel
    return (b'\xa4\x64type\x6apiezo-dual\x62ts' + encoded_time
            + b'\x65left1' + encoded_channel + b'\x66right1' + encoded_channel)


def test_inventory_reports_reversals_lost_markers_and_truncated_sample_bytes(tmp_path):
    channel = b'\x01\x00\x00\x00\xff\xff\xff\x7f\x03\x00\x00\x00x'
    store, descriptor = retain(tmp_path, envelope(piezo_record(100, channel)) + envelope(piezo_record(99, channel)))
    result = raw_records.inventory_retained(store, descriptor)
    assert result['timestamp_reversals'] == 1
    assert result['ordered_waveform_available'] is False
    assert (result['first_event_ms'], result['last_event_ms']) == (99000, 100000)
    assert result['channels']['left1'] == {'samples': 6, 'lost_markers': 2, 'truncated_tail_bytes': 2}


def test_inventory_rejects_channels_too_large_for_the_replay_driver(tmp_path):
    store, descriptor = retain(tmp_path, envelope(piezo_record(100, bytes(20004))))
    result = raw_records.inventory_retained(store, descriptor)
    assert result['oversize_channel_frames'] == 1
    assert result['ordered_waveform_available'] is False


def test_shared_budget_counts_empty_placeholders_across_artifact_streams(tmp_path):
    store, descriptor = retain(tmp_path, envelope(b'') + envelope(b''))
    budget = raw_records.RawRecordBudget(3)
    assert list(iter_retained_records(store, descriptor, budget=budget)) == []
    assert budget.consumed == 2
    with pytest.raises(ValueError, match='record count'):
        list(iter_retained_records(store, descriptor, budget=budget))
    assert budget.consumed == 4
    with pytest.raises(ValueError, match='shared RAW'):
        list(iter_retained_records(store, descriptor, budget=3))


def test_streams_every_map_of_a_pod5_packed_frame(tmp_path):
    # Pod 5 firmware packs consecutive `log` maps into one frame.
    first, second = cbor2.dumps({'type': 'log', 'msg': 'a'}), cbor2.dumps({'type': 'log', 'msg': 'b'})
    store, descriptor = retain(tmp_path, envelope(first + second) + envelope(b'\xa1\x64type\x61x'))
    assert list(iter_retained_records(store, descriptor)) == [{'type': 'log', 'msg': 'a'}, {'type': 'log', 'msg': 'b'}, {'type': 'x'}]
    with pytest.raises(ValueError, match='Trailing bytes'):
        decode_record(first + second)


def test_rejects_untyped_or_truncated_items_after_the_first_map():
    first = cbor2.dumps({'type': 'log'})
    with pytest.raises(ValueError, match='textual type'):
        raw_records.decode_records(first + cbor2.dumps([1]))
    with pytest.raises(ValueError):
        raw_records.decode_records(first + b'\xa1')


def pump_record(timestamp):
    return b'\xa2\x64type\x69frzHealth\x62ts\x1a' + timestamp.to_bytes(4, 'big')


def test_inventory_merges_pod5_pump_records_stamped_ahead_of_piezo_frames(tmp_path):
    # Pod 5 writes frzHealth stamped one second ahead of the next piezo frame.
    frames = [piezo_record(100), pump_record(102), piezo_record(101), piezo_record(102), pump_record(104), piezo_record(103)]
    store, descriptor = retain(tmp_path, b''.join(envelope(frame) for frame in frames))
    result = raw_records.inventory_retained(store, descriptor)
    assert result['timestamp_reversals'] == 0
    assert result['duplicate_timestamps'] == 1
    assert result['ordered_waveform_available'] is True
    assert (result['first_event_ms'], result['last_event_ms']) == (100000, 104000)


def test_event_order_releases_merged_streams_and_rejects_reversals():
    order = raw_records.EventOrder(window_ms=2000)
    released = order.push(10_000, 'a', 'piezo') + order.push(11_000, 'p', 'pump') + order.push(10_500, 'b', 'piezo')
    released += order.push(13_000, 'c', 'piezo') + order.flush()
    assert released == [(10_000, 'a'), (10_500, 'b'), (11_000, 'p'), (13_000, 'c')]
    with pytest.raises(ValueError, match='reversed'):
        order.push(12_000, 'late', 'pump')
    strict = raw_records.EventOrder()
    strict.push(5, 'x', 'piezo')
    with pytest.raises(ValueError, match='reversed'):
        strict.push(4, 'y', 'piezo')
    counting = raw_records.EventOrder(strict=False)
    counting.push(5, 'x', 'piezo')
    assert counting.push(4, 'y', 'piezo') == [] and counting.reversals == 1
