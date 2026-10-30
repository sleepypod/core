"""Prospective adapter for the shipped core, with an isolated candidate state.

No database, hardware, code loading or source selection. A separately admitted
host supplies observed arrival times/context and connects the sink to shadow
storage. CPU checks are cooperative; the host must also enforce process limits.
"""
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import time

from .config import canonical_json
from .live_input import FIRMWARE_TIMESTAMP_BASIS
from .replay import MAX_CHANNEL_BYTES, RecordedContext, ReplayReading, WaveformReplay


@dataclass(frozen=True)
class ShadowOutput:
    sequence: int
    input_hash: str
    reading: ReplayReading


class ProspectiveShadow:
    def __init__(self, configs, *, side, start_ms, end_ms, maximum_records,
                 maximum_outputs, maximum_cpu_ms, sink, cpu_clock=time.process_time_ns):
        if side not in ('left', 'right'):
            raise ValueError('Invalid shadow side')
        for value in (maximum_records, maximum_outputs, maximum_cpu_ms):
            if type(value) is not int or not 0 < value <= 9_007_199_254_740_991:
                raise ValueError('Invalid shadow resource budget')
        if type(start_ms) is not int or type(end_ms) is not int or not 0 <= start_ms < end_ms <= 9_007_199_254_740_991 or end_ms - start_ms > 7 * 86400000:
            raise ValueError('Invalid prospective window')
        self.side, self.start_ms, self.end_ms = side, start_ms, end_ms
        self.maximum_records, self.maximum_outputs = maximum_records, maximum_outputs
        self.maximum_cpu_ns = maximum_cpu_ms * 1_000_000
        self._cpu_clock, self._sink = cpu_clock, sink
        self._cpu_ns, self._records, self._outputs = 0, 0, 0
        self._staged = []
        self._digest = hashlib.sha256(b'biometric-shadow-input-v1\n').digest()
        self.state, self.reason = 'running', None
        self._processor = WaveformReplay(deepcopy(configs), retained_start_ms=start_ms,
            score_start_ms=start_ms, score_end_ms=end_ms, sink=self._capture,
            clock_mode=FIRMWARE_TIMESTAMP_BASIS)

    def _capture(self, reading):
        if reading.side != self.side:
            return
        if len(self._staged) >= 4 or self._outputs + len(self._staged) >= self.maximum_outputs:
            raise ValueError('Shadow output budget exceeded')
        self._staged.append(reading)

    def _read_cpu(self):
        value = self._cpu_clock()
        if type(value) is not int or value < 0:
            raise ValueError('Invalid shadow CPU clock')
        return value

    def _execute(self, action):
        if self.state != 'running':
            raise ValueError('Shadow processor is stopped')
        self._staged = []
        try:
            before = self._read_cpu()
            if self._cpu_ns >= self.maximum_cpu_ns:
                raise ValueError('Shadow CPU budget exceeded')
            try:
                action()
            finally:
                # Failed numerical/validation calls still consumed CPU. Do not
                # report a zero-cost failure or permit reuse after clock failure.
                elapsed = self._read_cpu() - before
                if elapsed < 0:
                    raise ValueError('Shadow CPU clock regressed')
                self._cpu_ns += elapsed
            if self._cpu_ns > self.maximum_cpu_ns:
                raise ValueError('Shadow CPU budget exceeded')
            # Do not publish this frame's provisional output after a budget or
            # processing failure. A sink failure terminates further processing.
            for reading in self._staged:
                self._sink(ShadowOutput(self._outputs, self._digest.hex(), reading))
                self._outputs += 1
        except Exception as error:
            self.state, self.reason = 'failed', str(error)[:500]
            raise
        finally:
            self._staged = []

    def feed(self, observed_at_ms, record, context):
        """Use firmware time for estimates and recorded arrival for admission.

        Arrival also drives pump/router timers; its difference from production's
        local monotonic clock is retained as an explicit comparison limitation.
        """
        def action():
            if self._records >= self.maximum_records:
                raise ValueError('Shadow record budget exceeded')
            if not isinstance(record, dict) or record.get('type') not in ('piezo-dual', 'frzHealth') or not isinstance(context, RecordedContext):
                raise ValueError('Invalid shadow record or context')
            for channel in ('left1', 'right1'):
                if channel in record:
                    value = record[channel]
                    if not isinstance(value, (bytes, bytearray, memoryview)) or len(value) > MAX_CHANNEL_BYTES:
                        raise ValueError('Invalid bounded shadow channel')
            frozen = {key: bytes(value) if key in ('left1', 'right1') else deepcopy(value) for key, value in record.items()}
            identity = dict(frozen)
            for channel in ('left1', 'right1'):
                if channel in frozen:
                    value = frozen[channel]
                    if not isinstance(value, (bytes, bytearray, memoryview)) or len(value) > MAX_CHANNEL_BYTES:
                        raise ValueError('Invalid bounded shadow channel')
                    frozen[channel] = bytes(value)
                    identity[channel] = {'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()}
            encoded = canonical_json({'observedAtMs': observed_at_ms, 'record': identity,
                'context': {'activeSides': list(context.active_sides) if context.active_sides is not None else None,
                            'leftOccupied': context.left_occupied, 'rightOccupied': context.right_occupied,
                            'pumpContextKnown': context.pump_context_known,
                            'mechanical': context.mechanical}}).encode()
            self._digest = hashlib.sha256(self._digest + encoded).digest()
            self._processor.feed(observed_at_ms, frozen, context)
            self._records += 1
        self._execute(action)

    def finish(self):
        """Normal completion flushes arbitration once. Cancellation does not."""
        self._execute(self._processor.close)
        self.state, self.reason = 'completed', 'window_complete'

    def stop(self, reason='cancelled'):
        if self.state == 'running':
            self.state, self.reason = 'stopped', str(reason)[:500]
            self._staged = []

    def health(self):
        return {'timestampBasis': FIRMWARE_TIMESTAMP_BASIS, 'state': self.state, 'reason': self.reason, 'records': self._records,
                'outputs': self._outputs, 'cpu_ms': self._cpu_ns / 1_000_000,
                'input_hash': self._digest.hex(), 'counts': dict(self._processor.counts),
                'limitations': tuple(sorted(self._processor.limitations))}
