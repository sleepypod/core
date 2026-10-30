"""Bounded JSONL interface for an externally supervised shipped shadow worker.

stdin carries configuration and frames; stdout carries acknowledgments and
candidate-only readings. No DB, live source, network or hardware is opened.
The parent must impose OS process budgets and terminate idle/cancelled workers.
"""
import base64
import json
import sys
from uuid import UUID

from .config import config_hash
from .replay import MAX_CHANNEL_BYTES, RecordedContext
from .shadow import ProspectiveShadow
from .processing import HRV_WINDOW_S
from .live_input import FIRMWARE_TIMESTAMP_BASIS

MAX_LINE_BYTES = 128 * 1024


def positive(value):
    if type(value) is not int or not 0 < value <= 9_007_199_254_740_991:
        raise ValueError('Invalid transport budget')
    return value


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys.split()):
        raise ValueError('Unexpected shadow protocol fields')


def run(source, destination):
    input_bytes = output_bytes = 0
    maximum_input = MAX_LINE_BYTES
    maximum_output = MAX_LINE_BYTES

    def read():
        nonlocal input_bytes
        line = source.readline(MAX_LINE_BYTES + 1)
        if not line:
            raise ValueError('Unexpected shadow protocol EOF')
        input_bytes += len(line)
        if len(line) > MAX_LINE_BYTES or input_bytes > maximum_input or not line.endswith(b'\n'):
            raise ValueError('Shadow input transport limit exceeded')
        return json.loads(line.decode('utf-8'))

    init = read()
    exact(init, 'schema runId attemptId configs configHashes side startMs endMs maximumRecords maximumOutputs maximumCpuMs maximumInputBytes maximumOutputBytes')
    if init['schema'] != 'biometric-shadow-worker-v1':
        raise ValueError('Unsupported shadow worker protocol')
    for key in ('runId', 'attemptId'):
        if not isinstance(init[key], str) or str(UUID(init[key])) != init[key]:
            raise ValueError('Invalid shadow attempt identity')
    maximum_input, maximum_output = positive(init['maximumInputBytes']), positive(init['maximumOutputBytes'])
    if input_bytes > maximum_input:
        raise ValueError('Shadow input transport limit exceeded')
    if not isinstance(init['configs'], dict) or set(init['configs']) != {'left', 'right'}:
        raise ValueError('Both shadow configurations required')
    hashes = {side: config_hash(config) for side, config in init['configs'].items()}
    if hashes != init['configHashes']:
        raise ValueError('Shadow configuration identity mismatch')

    def write(payload):
        nonlocal output_bytes
        response = {'runId': init['runId'], 'attemptId': init['attemptId'], **payload}
        line = (json.dumps(response, allow_nan=False, separators=(',', ':')) + '\n').encode()
        output_bytes += len(line)
        if len(line) > MAX_LINE_BYTES or output_bytes > maximum_output:
            raise ValueError('Shadow output transport limit exceeded')
        destination.write(line)
        destination.flush()

    pending = []
    def sink(output):
        candidate = output.reading.candidate
        pending.append({'sequence': output.sequence, 'inputHash': output.input_hash,
            'side': output.reading.side, 'sourceSide': candidate.run_context.source_side,
            'timestampMs': output.reading.timestamp_ms, 'timestampBasis': FIRMWARE_TIMESTAMP_BASIS, 'configHash': candidate.run_context.config_hash,
            'readings': [
                {'metric': 'heart_rate', 'unit': 'bpm', 'windowMs': None, 'value': candidate.heart_rate, 'quality': candidate.quality_score},
                {'metric': 'breathing_rate', 'unit': 'breaths/min', 'windowMs': None, 'value': candidate.breathing_rate, 'quality': candidate.quality_score},
                {'metric': 'window_ibi_variability_v1', 'unit': 'ms', 'windowMs': HRV_WINDOW_S * 1000, 'value': candidate.hrv, 'quality': candidate.quality_score},
            ], 'flags': candidate.flags, 'limitations': output.reading.limitations})

    processor = ProspectiveShadow(init['configs'], side=init['side'], start_ms=init['startMs'], end_ms=init['endMs'],
        maximum_records=init['maximumRecords'], maximum_outputs=init['maximumOutputs'], maximum_cpu_ms=init['maximumCpuMs'], sink=sink)
    write({'type': 'ready', 'configHashes': hashes})
    expected_sequence = 0
    try:
        while True:
            message = read()
            if message == {'type': 'finish'}:
                processor.finish()
                write({'type': 'finished', 'outputs': pending, 'health': processor.health()})
                return
            if message == {'type': 'cancel'}:
                processor.stop()
                write({'type': 'cancelled', 'health': processor.health()})
                return
            exact(message, 'type sequence observedAtMs record context')
            if message['type'] != 'frame' or type(message['sequence']) is not int or message['sequence'] != expected_sequence:
                raise ValueError('Out-of-order shadow protocol frame')
            exact(message['context'], 'activeSides leftOccupied rightOccupied pumpContextKnown'
                  + (' mechanical' if 'mechanical' in message['context'] else ''))
            context = message['context']
            if context['activeSides'] is not None and not isinstance(context['activeSides'], list):
                raise ValueError('Invalid shadow active sides')
            recorded = RecordedContext(tuple(context['activeSides']) if context['activeSides'] is not None else None,
                context['leftOccupied'], context['rightOccupied'], context['pumpContextKnown'], context.get('mechanical'))
            if not isinstance(message['record'], dict):
                raise ValueError('Invalid shadow record')
            record = dict(message['record'])
            for channel in ('left1', 'right1'):
                if channel in record:
                    encoded = record[channel]
                    if not isinstance(encoded, str) or len(encoded) > ((MAX_CHANNEL_BYTES + 2) // 3) * 4:
                        raise ValueError('Invalid encoded shadow channel')
                    record[channel] = base64.b64decode(encoded, validate=True)
                    if len(record[channel]) > MAX_CHANNEL_BYTES:
                        raise ValueError('Shadow channel limit exceeded')
            processor.feed(message['observedAtMs'], record, recorded)
            write({'type': 'frame_result', 'sequence': expected_sequence, 'outputs': pending, 'health': processor.health()})
            pending.clear()
            expected_sequence += 1
    finally:
        processor.stop('transport_closed')


if __name__ == '__main__':
    try:
        run(sys.stdin.buffer, sys.stdout.buffer)
    except Exception as error:
        sys.stderr.write(str(error)[:500] + '\n')
        sys.exit(1)
