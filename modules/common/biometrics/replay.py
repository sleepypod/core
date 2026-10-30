"""Bounded event-time waveform replay using the shipped stateful processor.

Callers stream retained records and complete recorded context snapshots. This
module never opens live state or a database. Output is delivered incrementally
to an experiment sink; the driver retains only bounded processor buffers.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Mapping, Optional, Tuple

from .config import config_hash, validate_config
from .frames import decode_int32_samples
from .gates import FrzHealthPumpState, PumpGate
from .live_input import FIRMWARE_TIMESTAMP_BASIS, LiveFrameClock, prepare_live_frame
from .mechanical import MechanicalGate, MechanicalWriter, validate_snapshot
from .processing import StatefulSideProcessor
from .routing import SingleSleeperRouter
from .signal import ProcessingParameters

SIDES = ('left', 'right')
MAX_CHANNEL_BYTES = 5000 * 4  # Ten seconds at the supported 500 Hz rate.


@dataclass(frozen=True)
class RecordedContext:
    active_sides: Optional[Tuple[str, ...]] = None
    left_occupied: Optional[bool] = None
    right_occupied: Optional[bool] = None
    pump_context_known: bool = False
    mechanical: Optional[dict] = None

    def __post_init__(self):
        if self.active_sides not in (None, (), ('left',), ('right',), SIDES):
            raise ValueError('Invalid recorded sleeper mode')
        for value in (self.left_occupied, self.right_occupied):
            if value is not None and type(value) is not bool:
                raise ValueError('Invalid recorded occupancy')
        if type(self.pump_context_known) is not bool:
            raise ValueError('Invalid pump context availability')
        object.__setattr__(self, 'mechanical', validate_snapshot(self.mechanical))


@dataclass(frozen=True)
class ReplayProvenance:
    side: str
    source_side: str
    config_hash: str


@dataclass(frozen=True)
class ReplayCandidate:
    side: str
    ts: datetime
    heart_rate: Optional[float]
    hrv: Optional[float]
    breathing_rate: Optional[float]
    quality_score: float
    flags: Optional[Tuple[str, ...]]
    hr_raw: Optional[float]
    run_context: ReplayProvenance

    def __post_init__(self):
        object.__setattr__(self, 'flags', tuple(self.flags) if self.flags else None)


@dataclass(frozen=True)
class ReplayReading:
    candidate: ReplayCandidate
    side: str
    timestamp_ms: int
    limitations: Tuple[str, ...]


class WaveformReplay:
    """Replay [retained_start_ms, score_end_ms); score only the requested window.

    Timestamps must be integer Unix milliseconds in retained record order.
    Equal timestamps are allowed (pump/context and piezo records can coincide).
    Both physical channels are always processed, left first. Configurations are
    fixed experiment snapshots indexed by logical side, not live bindings.
    """
    def __init__(self, configs: Mapping[str, dict], *, retained_start_ms: int,
                 score_start_ms: int, score_end_ms: int,
                 sink: Callable[[ReplayReading], None], clock_mode='recorded_event_time'):
        for value in (retained_start_ms, score_start_ms, score_end_ms):
            if type(value) is not int or value < 0:
                raise ValueError('Invalid replay timestamp')
        if not retained_start_ms <= score_start_ms < score_end_ms:
            raise ValueError('Invalid replay window')
        if set(configs) != set(SIDES):
            raise ValueError('Both logical-side configurations are required')
        for config in configs.values():
            validate_config(config)
        self.parameters = {side: ProcessingParameters.from_config(configs[side]) for side in SIDES}
        self.hashes = {side: config_hash(configs[side]) for side in SIDES}
        self.retained_start_ms, self.score_start_ms, self.score_end_ms = retained_start_ms, score_start_ms, score_end_ms
        self._now_ms = retained_start_ms
        self._closed = False
        self._context = RecordedContext()
        self._sink = sink
        if clock_mode not in ('recorded_event_time', 'observed_arrival_time', FIRMWARE_TIMESTAMP_BASIS):
            raise ValueError('Invalid processing clock mode')
        self.clock_mode = clock_mode
        self.limitations = {'cold_start_without_serialized_state'}
        if clock_mode == FIRMWARE_TIMESTAMP_BASIS:
            self.limitations.add('recorded_arrival_replaces_local_monotonic_clock')
        if clock_mode == 'recorded_event_time':
            self.limitations.add('event_time_replaces_arrival_time')
        if score_start_ms - retained_start_ms < 300_000:
            self.limitations.add('less_than_five_minutes_preroll')
        self.counts = {'records': 0, 'accepted_frames': 0, 'empty_channel_frames': 0,
                       'pump_gated_frames': 0, 'preroll_outputs': 0, 'scored_outputs': 0}
        if clock_mode == FIRMWARE_TIMESTAMP_BASIS:
            self.counts['timestamp_rejected_frames'] = 0
            self.counts['mechanical_gated_frames'] = 0
        clock = lambda: self._now_ms / 1000
        self.frame_clock = LiveFrameClock(wall=clock, monotonic=clock)
        processing_clock = self.frame_clock if clock_mode == FIRMWARE_TIMESTAMP_BASIS else clock
        self.pumps = FrzHealthPumpState(clock=clock)
        self.gate = PumpGate(clock=clock)
        self.mechanical = MechanicalGate()
        self.guarded_writer = MechanicalWriter(self.mechanical, self._write)
        self.router = SingleSleeperRouter(self, self.guarded_writer.submit if clock_mode == FIRMWARE_TIMESTAMP_BASIS else self._write, clock=clock)
        self.processors = {}
        for side in SIDES:
            processor = StatefulSideProcessor(side, clock=processing_clock,
                writer=lambda candidate: self._write(candidate, None),
                candidate_factory=ReplayCandidate, pump_state=self.pumps,
                parameters=self.parameters[side])
            processor.sink = self.router.submit
            processor.home_side = self.home_side
            processor.bed_occupied = lambda side=side: self._occupied(self.home_side() or side)
            self.processors[side] = processor
        self.processors['left']._other = self.processors['right']
        self.processors['right']._other = self.processors['left']

    def active_sides(self):
        # The fallback is explicitly approximate, never reported as known mode.
        return self._context.active_sides if self._context.active_sides is not None else SIDES

    def home_side(self):
        active = self.active_sides()
        return active[0] if len(active) == 1 else None

    def _occupied(self, side):
        return self._context.left_occupied if side == 'left' else self._context.right_occupied

    def _write(self, candidate, destination):
        # The live SQLite writer stores integer Unix seconds. Exact joins must
        # use that same quantization, even when firmware supplies fractions.
        timestamp_ms = (int(candidate.ts.timestamp()) * 1000 if self.clock_mode == FIRMWARE_TIMESTAMP_BASIS
                        else round(candidate.ts.timestamp() * 1000))
        if self.score_start_ms <= timestamp_ms < self.score_end_ms:
            # Like live provenance, a held candidate retains its computed side
            # even when the recorded mode changes before its sink is flushed.
            self._sink(ReplayReading(candidate, candidate.run_context.side,
                                     timestamp_ms, tuple(sorted(self.limitations))))
            self.counts['scored_outputs'] += 1
        else:
            self.counts['preroll_outputs'] += 1
        return True

    def feed(self, timestamp_ms: int, record: dict, context: RecordedContext):
        if self._closed:
            raise ValueError('Replay is closed')
        if type(timestamp_ms) is not int or not self._now_ms <= timestamp_ms < self.score_end_ms:
            raise ValueError('Replay records must be ordered inside the retained window')
        if not isinstance(record, dict) or not isinstance(context, RecordedContext):
            raise ValueError('Invalid replay record or context')
        for side in SIDES:
            payload = record.get(side + '1', b'')
            if isinstance(payload, (bytes, bytearray, memoryview)) and len(payload) > MAX_CHANNEL_BYTES:
                raise ValueError('Replay channel exceeds bounded frame size')
        self._now_ms, self._context = timestamp_ms, context
        self.mechanical.update(context.mechanical, timestamp_ms)
        self.counts['records'] += 1
        if context.active_sides is None:
            self.limitations.add('missing_sleeper_mode')
        if context.left_occupied is None or context.right_occupied is None:
            self.limitations.add('missing_occupancy_context')
        if not context.pump_context_known:
            self.limitations.add('missing_pump_context')
        if context.mechanical is None:
            self.limitations.add('missing_mechanical_context')
        self.router.tick()
        self.guarded_writer.tick()
        if record.get('type') == 'frzHealth':
            self.pumps.update(record)
            return
        if record.get('type') != 'piezo-dual':
            return
        if self.clock_mode == FIRMWARE_TIMESTAMP_BASIS:
            frame = prepare_live_frame(record, self.frame_clock, tuple(self.processors.values()), self.gate, self.mechanical)
            if frame.samples is None:
                self.counts[frame.status] += 1
                return
            left, right = frame.samples
        else:
            left = decode_int32_samples(record.get('left1', b''))
            right = decode_int32_samples(record.get('right1', b''))
            if left.size == 0 or right.size == 0:
                self.counts['empty_channel_frames'] += 1
                return
            if self.gate.check(left, right):
                self.counts['pump_gated_frames'] += 1
                return
        for side in SIDES:
            processor = self.processors[side]
            logical = self.home_side() or side
            previous = processor.run_context
            provenance = ReplayProvenance(logical, side, self.hashes[logical])
            processor.install_runtime(self.parameters[logical], provenance,
                reset_side=previous is None or previous.side != logical)
        self.processors['left'].ingest(left)
        self.processors['right'].ingest(right)
        self.counts['accepted_frames'] += 1

    def close(self):
        if not self._closed:
            self._now_ms = self.score_end_ms
            self.router.flush()
            self.guarded_writer.tick()
            if self.guarded_writer.pending:
                self.limitations.add('unconfirmed_mechanical_windows_at_finish')
            self._closed = True
