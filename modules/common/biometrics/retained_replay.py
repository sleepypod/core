"""Replay immutable artifact descriptors with a frozen context timeline.

Sink rows are provisional until this function returns successfully: a later
archive can fail verification. The durable worker must publish them atomically
with its successful result, never into canonical observations.
"""
from dataclasses import dataclass
import math

from .raw_artifacts import RawArtifact
from .raw_records import EVENT_TYPES, EventOrder, RawRecordBudget, iter_retained_records
from .replay import RecordedContext, WaveformReplay

MAX_SAFE_INTEGER = 9_007_199_254_740_991


def _integer(value):
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise ValueError('Expected a nonnegative safe integer')
    return value


def _keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected.split()):
        raise ValueError('Unexpected retained replay fields')


def _timestamp(record):
    value = record.get('ts')
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 9_007_199_254_740:
        raise ValueError('Invalid retained event timestamp')
    # Same rounding contract as the inspected inventory; no local timezone or
    # Python bankers-rounding dependency at half-millisecond boundaries.
    return _integer(math.floor(value * 1000 + 0.5))


@dataclass(frozen=True)
class ArtifactInput:
    artifact: RawArtifact
    first_event_ms: int
    last_event_ms: int


@dataclass(frozen=True)
class ContextInterval:
    start_ms: int
    end_ms: int
    context: RecordedContext


@dataclass(frozen=True)
class RetainedReplayInput:
    retained_start_ms: int
    score_start_ms: int
    score_end_ms: int
    artifacts: tuple
    contexts: tuple

    @classmethod
    def parse(cls, raw):
        _keys(raw, 'version retained_start_ms score_start_ms score_end_ms artifacts contexts')
        if raw['version'] != 'retained-waveform-input-v1':
            raise ValueError('Unsupported retained waveform input version')
        start, score, end = (_integer(raw[key]) for key in ('retained_start_ms', 'score_start_ms', 'score_end_ms'))
        if not start <= score < end:
            raise ValueError('Invalid retained replay window')
        if not isinstance(raw['artifacts'], list) or not 1 <= len(raw['artifacts']) <= 64:
            raise ValueError('Select between one and 64 retained artifacts')
        artifacts, hashes, compressed = [], set(), 0
        for item in raw['artifacts']:
            _keys(item, 'artifact first_event_ms last_event_ms')
            _keys(item['artifact'], 'name sha256 compressed_bytes expanded_bytes')
            artifact = RawArtifact(**item['artifact'])
            first, last = _integer(item['first_event_ms']), _integer(item['last_event_ms'])
            if first > last or last < start or first >= end:
                raise ValueError('Artifact has no events in the retained window')
            # Bounds may touch: Pod 5 can end one archive with a pump record
            # stamped at the next archive's first frame.
            if artifact.sha256 in hashes or (artifacts and first < artifacts[-1].last_event_ms):
                raise ValueError('Retained artifacts must be distinct and have nonoverlapping ordered event bounds')
            hashes.add(artifact.sha256)
            compressed += artifact.compressed_bytes
            if compressed > 1024 * 1024 * 1024:
                raise ValueError('Retained replay compressed input budget exceeded')
            artifacts.append(ArtifactInput(artifact, first, last))
        if not isinstance(raw['contexts'], list) or len(raw['contexts']) > 20000:
            raise ValueError('Retained context interval budget exceeded')
        contexts = []
        for item in raw['contexts']:
            _keys(item, 'start_ms end_ms active_sides left_occupied right_occupied pump_context_known')
            first, last = _integer(item['start_ms']), _integer(item['end_ms'])
            if not start <= first < last <= end or (contexts and first < contexts[-1].end_ms):
                raise ValueError('Context intervals must be ordered and nonoverlapping inside the retained window')
            active = item['active_sides']
            if active is not None and not isinstance(active, list):
                raise ValueError('Recorded active sides must be a list or unknown')
            context = RecordedContext(None if active is None else tuple(active),
                item['left_occupied'], item['right_occupied'], item['pump_context_known'])
            contexts.append(ContextInterval(first, last, context))
        return cls(start, score, end, tuple(artifacts), tuple(contexts))


def replay_retained(store, raw_input, configs, sink, *, cancelled=lambda: False,
                    maximum_readings=20000, maximum_records=1_000_000):
    """Run fixed shipped code; no archive fallback, live DB, or control access.

    Cross-artifact overlap is rejected rather than guessing which duplicate
    frames to drop. Gaps are preserved; event bounds never imply continuity.
    Every selected artifact is consumed to EOF, including out-of-window records,
    so decompression/framing and the inspected event bounds are verified.
    """
    if type(maximum_readings) is not int or maximum_readings <= 0 or type(maximum_records) is not int or maximum_records <= 0:
        raise ValueError('Invalid retained replay resource bounds')
    snapshot = RetainedReplayInput.parse(raw_input)
    readings = 0

    def write(row):
        nonlocal readings
        if cancelled():
            raise ValueError('Retained replay cancelled')
        readings += 1
        if readings > maximum_readings:
            raise ValueError('Retained replay output budget exceeded')
        sink(row)

    replay = WaveformReplay(configs, retained_start_ms=snapshot.retained_start_ms,
        score_start_ms=snapshot.score_start_ms, score_end_ms=snapshot.score_end_ms, sink=write)
    budget = RawRecordBudget(maximum_records)
    index, decoded = 0, 0
    order = EventOrder()

    def feed(ready):
        nonlocal index
        for timestamp, record in ready:
            if not snapshot.retained_start_ms <= timestamp < snapshot.score_end_ms:
                continue
            while index < len(snapshot.contexts) and timestamp >= snapshot.contexts[index].end_ms:
                index += 1
            interval = snapshot.contexts[index] if index < len(snapshot.contexts) else None
            context = interval.context if interval and timestamp >= interval.start_ms else RecordedContext()
            replay.feed(timestamp, record, context)

    for source in snapshot.artifacts:
        if cancelled():
            raise ValueError('Retained replay cancelled')
        first = last = None
        for record in iter_retained_records(store, source.artifact, max_records=maximum_records, budget=budget):
            if cancelled():
                raise ValueError('Retained replay cancelled')
            decoded += 1
            if decoded > maximum_records:
                raise ValueError('Retained replay decoded record budget exceeded')
            if record['type'] not in EVENT_TYPES:
                continue
            timestamp = _timestamp(record)
            # Bounds are the inspected min/max; the streams interleave within a file.
            first = timestamp if first is None else min(first, timestamp)
            last = timestamp if last is None else max(last, timestamp)
            if not source.first_event_ms <= timestamp <= source.last_event_ms:
                raise ValueError('Retained event lies outside inspected bounds')
            feed(order.push(timestamp, record, record['type']))
        if first != source.first_event_ms or last != source.last_event_ms:
            raise ValueError('Retained event bounds differ from inspected source')
    feed(order.flush())
    if cancelled():
        raise ValueError('Retained replay cancelled')
    replay.close()
    return {'version': 'retained-waveform-run-v1', 'decoded_records': decoded, 'raw_records': budget.consumed,
            'counts': dict(replay.counts), 'limitations': sorted(replay.limitations),
            'config_hashes': dict(replay.hashes), 'artifact_hashes': [item.artifact.sha256 for item in snapshot.artifacts]}
