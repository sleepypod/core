"""Bounded firmware CBOR records for retained replay inputs.

Decode containers incrementally instead of trusting attacker/corruption supplied
container lengths to a decoder allocation. Firmware uses indefinite maps, so
these remain supported along with definite containers and strings. Semantic
tags and non-text map keys are outside this versioned firmware-record contract.
"""
from dataclasses import dataclass
import heapq
import struct

from common.cbor_raw import read_raw_record


@dataclass(frozen=True)
class DecodeLimits:
    record_bytes: int = 128 * 1024
    string_bytes: int = 64 * 1024
    nodes: int = 4096
    depth: int = 16

    def __post_init__(self):
        if any(type(value) is not int or value <= 0 for value in vars(self).values()):
            raise ValueError('Invalid RAW decoding limits')


class _Decoder:
    def __init__(self, payload, limits):
        self.payload, self.limits, self.position, self.nodes = payload, limits, 0, 0

    def take(self, size):
        if size > len(self.payload) - self.position:
            raise ValueError('Truncated inner CBOR record')
        start = self.position
        self.position += size
        return self.payload[start:self.position]

    def argument(self, additional):
        if additional < 24:
            return additional
        size = {24: 1, 25: 2, 26: 4, 27: 8}.get(additional)
        if size is None:
            raise ValueError('Invalid CBOR length encoding')
        return int.from_bytes(self.take(size), 'big')

    def node(self):
        self.nodes += 1
        if self.nodes > self.limits.nodes:
            raise ValueError('CBOR node budget exceeded')

    def ended(self):
        if self.position >= len(self.payload):
            raise ValueError('Truncated indefinite CBOR container')
        if self.payload[self.position] == 0xff:
            self.position += 1
            return True
        return False

    def value(self, depth=0):
        self.node()
        if depth > self.limits.depth:
            raise ValueError('CBOR nesting budget exceeded')
        header = self.take(1)[0]
        major, additional = header >> 5, header & 31
        if major in (0, 1):
            number = self.argument(additional)
            return number if major == 0 else -1 - number
        if major in (2, 3):
            if additional == 31:
                chunks, total = [], 0
                while not self.ended():
                    self.node()
                    chunk = self.take(1)[0]
                    if chunk >> 5 != major or chunk & 31 == 31:
                        raise ValueError('Invalid indefinite CBOR string chunk')
                    size = self.argument(chunk & 31)
                    total += size
                    if total > self.limits.string_bytes:
                        raise ValueError('CBOR string budget exceeded')
                    data = self.take(size)
                    if major == 3:
                        data.decode('utf-8', errors='strict')
                    chunks.append(data)
                data = b''.join(chunks)
            else:
                size = self.argument(additional)
                if size > self.limits.string_bytes:
                    raise ValueError('CBOR string budget exceeded')
                data = self.take(size)
            return data if major == 2 else data.decode('utf-8', errors='strict')
        if major in (4, 5):
            count = None if additional == 31 else self.argument(additional)
            multiplier = 2 if major == 5 else 1
            if count is not None and count * multiplier > self.limits.nodes - self.nodes:
                raise ValueError('CBOR container budget exceeded')
            result = {} if major == 5 else []
            consumed = 0
            while count is None or consumed < count:
                if count is None and self.ended():
                    break
                item = self.value(depth + 1)
                if major == 5:
                    if not isinstance(item, str):
                        raise ValueError('CBOR record map keys must be text')
                    if item in result:
                        raise ValueError('Duplicate CBOR record key')
                    result[item] = self.value(depth + 1)
                else:
                    result.append(item)
                consumed += 1
            return result
        if major == 7:
            if additional in (20, 21, 22):
                return {20: False, 21: True, 22: None}[additional]
            encoding = {25: ('>e', 2), 26: ('>f', 4), 27: ('>d', 8)}.get(additional)
            if encoding:
                return struct.unpack(encoding[0], self.take(encoding[1]))[0]
        raise ValueError('Unsupported CBOR record value')


def decode_record(payload, limits=DecodeLimits()):
    records = decode_records(payload, limits)
    if len(records) != 1:
        raise ValueError('Trailing bytes after CBOR record')
    return records[0]


def decode_records(payload, limits=DecodeLimits()):
    """Decode one RAW frame. Pod 5 firmware packs several `log` maps into a
    single frame back to back, so a frame is a CBOR sequence; every item must
    be a typed record and all items share one decode budget."""
    if not isinstance(payload, bytes) or len(payload) > limits.record_bytes:
        raise ValueError('RAW inner record byte budget exceeded')
    decoder = _Decoder(payload, limits)
    records = []
    while True:
        result = decoder.value()
        if not isinstance(result, dict) or not isinstance(result.get('type'), str):
            raise ValueError('RAW record must have a textual type')
        records.append(result)
        if decoder.position == len(payload):
            return records


EVENT_TYPES = ('piezo-dual', 'frzHealth')
REORDER_WINDOW_MS = 5000


class EventOrder:
    """Release piezo and pump events in timestamp order.

    Each record type must be monotonic on its own, but Pod 5 stamps a
    frzHealth record up to a second ahead of the piezo frame written after
    it. Events are held until one at least `window_ms` newer arrives, which
    merges the streams. A step back within a stream, or an event older than
    one already released, is a real reversal: strict callers raise on it,
    counting callers drop it and report `reversals`.
    """
    def __init__(self, strict=True, window_ms=REORDER_WINDOW_MS):
        self.strict, self.window_ms = strict, window_ms
        self.released, self.reversals = None, 0
        self._held, self._sequence, self._latest = [], 0, {}

    def push(self, timestamp_ms, item, kind):
        latest = self._latest.get(kind)
        if (latest is not None and timestamp_ms < latest) or (self.released is not None and timestamp_ms < self.released):
            if self.strict:
                raise ValueError('Retained event timestamps reversed')
            self.reversals += 1
            return []
        self._latest[kind] = timestamp_ms
        heapq.heappush(self._held, (timestamp_ms, self._sequence, item))
        self._sequence += 1
        return self._release(timestamp_ms - self.window_ms)

    def flush(self):
        return self._release(None)

    def _release(self, through):
        ready = []
        while self._held and (through is None or self._held[0][0] <= through):
            timestamp_ms, _, item = heapq.heappop(self._held)
            self.released = timestamp_ms
            ready.append((timestamp_ms, item))
        return ready


class RawRecordBudget:
    """One count budget shared by all artifacts, including empty placeholders."""
    def __init__(self, maximum):
        if type(maximum) is not int or maximum <= 0:
            raise ValueError('Invalid RAW record count limit')
        self.maximum, self.consumed = maximum, 0

    def consume(self):
        self.consumed += 1
        if self.consumed > self.maximum:
            raise ValueError('RAW record count limit exceeded')


def iter_retained_records(store, descriptor, limits=DecodeLimits(), max_records=1_000_000, *, budget=None):
    """Yield decoded records without buffering a file or concealing truncation."""
    if type(max_records) is not int or max_records <= 0:
        raise ValueError('Invalid RAW record count limit')
    if budget is not None and not isinstance(budget, RawRecordBudget):
        raise ValueError('Invalid shared RAW record budget')
    with store.open_raw(descriptor) as stream:
        count = 0
        while True:
            offset = stream.tell()
            try:
                payload = read_raw_record(stream)
            except EOFError:
                if stream.tell() != offset:
                    raise ValueError('Truncated retained RAW framing') from None
                return
            count += 1
            if budget is not None:
                budget.consume()
            if count > max_records:
                raise ValueError('RAW record count limit exceeded')
            if payload is not None:
                yield from decode_records(payload, limits)


def inventory_retained(store, descriptor, limits=DecodeLimits(), max_records=1_000_000):
    """Inventory recorded event times and channel bytes, not inferred occupancy.

    Timestamp bounds are event bounds, not a claim of continuous signal support.
    Missing timestamps or reversals make this ordered replay contract unavailable.
    """
    import math

    result = {'version': 'retained-raw-inventory-v1', 'artifact_sha256': descriptor.sha256,
              'decoded_records': 0, 'piezo_records': 0, 'pump_records': 0,
              'usable_dual_frames': 0, 'empty_channel_frames': 0,
              'oversize_channel_frames': 0, 'invalid_timestamps': 0,
              'timestamp_reversals': 0, 'duplicate_timestamps': 0,
              'first_event_ms': None, 'last_event_ms': None,
              'channels': {side: {'samples': 0, 'lost_markers': 0, 'truncated_tail_bytes': 0}
                           for side in ('left1', 'right1')}}
    order, previous = EventOrder(strict=False), None

    def count_order(ready):
        nonlocal previous
        for timestamp_ms, _ in ready:
            result['duplicate_timestamps'] += int(timestamp_ms == previous)
            previous = timestamp_ms

    for record in iter_retained_records(store, descriptor, limits, max_records):
        result['decoded_records'] += 1
        kind = record['type']
        if kind not in EVENT_TYPES:
            continue
        timestamp = record.get('ts')
        if (type(timestamp) not in (int, float) or not math.isfinite(timestamp)
                or timestamp < 0 or timestamp > 9_007_199_254_740):
            result['invalid_timestamps'] += 1
        else:
            timestamp_ms = math.floor(timestamp * 1000 + 0.5)
            count_order(order.push(timestamp_ms, None, kind))
            result['first_event_ms'] = timestamp_ms if result['first_event_ms'] is None else min(result['first_event_ms'], timestamp_ms)
            result['last_event_ms'] = timestamp_ms if result['last_event_ms'] is None else max(result['last_event_ms'], timestamp_ms)
        if kind == 'frzHealth':
            result['pump_records'] += 1
            continue
        result['piezo_records'] += 1
        usable, oversized = True, False
        for side, totals in result['channels'].items():
            payload = record.get(side)
            if not isinstance(payload, bytes):
                usable = False
                continue
            if len(payload) > 20_000:
                oversized = True
                usable = False
                continue
            size = len(payload) - len(payload) % 4
            count = size // 4
            lost = sum(value == 2_147_483_647 for (value,) in struct.iter_unpack('<i', payload[:size]))
            totals['samples'] += count
            totals['lost_markers'] += lost
            totals['truncated_tail_bytes'] += len(payload) % 4
            usable = usable and count > lost
        result['usable_dual_frames'] += int(usable)
        result['empty_channel_frames'] += int(not usable and not oversized)
        result['oversize_channel_frames'] += int(oversized)
    count_order(order.flush())
    result['timestamp_reversals'] = order.reversals
    result['ordered_waveform_available'] = (result['usable_dual_frames'] > 0
        and result['invalid_timestamps'] == 0 and result['timestamp_reversals'] == 0
        and result['oversize_channel_frames'] == 0)
    result['limitations'] = ['Event timestamps do not establish continuous waveform coverage.',
                            'Pump record counts do not prove complete historical pump context.',
                            'Sleeper mode, occupancy and calibration require separately retained context.']
    return result
