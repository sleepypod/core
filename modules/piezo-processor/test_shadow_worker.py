"""Real subprocess transport for the shipped shadow worker; no pod imports."""
import base64
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import pytest

from test_shadow import START, configs, frames
from common.tests_support.mechanical import quiet_snapshot
from common.biometrics.config import config_hash
from common.biometrics.shadow_worker import MAX_LINE_BYTES, run


def initialization():
    values = configs()
    return {'schema': 'biometric-shadow-worker-v1', 'runId': str(uuid4()), 'attemptId': str(uuid4()),
        'configs': values, 'configHashes': {side: config_hash(config) for side, config in values.items()},
        'side': 'left', 'startMs': START, 'endMs': START + 150000, 'maximumRecords': 200, 'maximumOutputs': 10,
        'maximumCpuMs': 30000, 'maximumInputBytes': 2 * 1024 * 1024, 'maximumOutputBytes': 512 * 1024}


def encode(messages):
    return b''.join((json.dumps(message) + '\n').encode() for message in messages)


def frame(sequence, timestamp, record):
    return {'type': 'frame', 'sequence': sequence, 'observedAtMs': timestamp,
        'record': {key: base64.b64encode(value).decode() if isinstance(value, bytes) else value for key, value in record.items()},
        'context': {'activeSides': ['left'], 'leftOccupied': True, 'rightOccupied': False, 'pumpContextKnown': True, 'mechanical': quiet_snapshot(timestamp)}}


def test_real_worker_protocol_produces_candidate_only_outputs_and_exits_cleanly(tmp_path):
    init = initialization()
    messages = [init] + [frame(index, timestamp, record) for index, (timestamp, record) in enumerate(frames())] + [{'type': 'finish'}]
    environment = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parent.parent),
                   'BIOMETRICS_DB': str(tmp_path / 'must-not-be-created.sqlite')}
    result = subprocess.run([sys.executable, '-m', 'common.biometrics.shadow_worker'], input=encode(messages), capture_output=True,
                            env=environment, timeout=30)
    assert result.returncode == 0, result.stderr.decode()
    rows = [json.loads(line) for line in result.stdout.splitlines()]
    assert rows[0]['type'] == 'ready' and rows[-1]['type'] == 'finished'
    assert len(rows) == 152
    assert [row['sequence'] for row in rows[1:-1]] == list(range(150))
    assert all(row['runId'] == init['runId'] and row['attemptId'] == init['attemptId'] for row in rows)
    outputs = [output for row in rows for output in row.get('outputs', [])]
    assert outputs and all(output['side'] == 'left' and output['configHash'] == init['configHashes']['left'] for output in outputs)
    assert all(output['readings'][2]['windowMs'] == 300000 and output['readings'][2]['unit'] == 'ms' for output in outputs)
    assert [output['sequence'] for output in outputs] == list(range(len(outputs)))
    assert not (tmp_path / 'must-not-be-created.sqlite').exists()


def test_transport_rejects_configuration_substitution_sequence_errors_and_truncation():
    init = initialization()
    init['configHashes']['left'] = 'f' * 64
    with pytest.raises(ValueError, match='configuration identity'):
        run(BytesIO(encode([init])), BytesIO())
    message = frame(1, START, {'type': 'frzHealth'})
    with pytest.raises(ValueError, match='Out-of-order'):
        run(BytesIO(encode([initialization(), message])), BytesIO())
    with pytest.raises(ValueError, match='EOF'):
        run(BytesIO(encode([initialization()])), BytesIO())
    with pytest.raises(ValueError, match='transport limit'):
        run(BytesIO(b'x' * (MAX_LINE_BYTES + 1)), BytesIO())


def test_cancellation_and_transport_budgets_do_not_publish_success():
    output = BytesIO()
    run(BytesIO(encode([initialization(), {'type': 'cancel'}])), output)
    assert json.loads(output.getvalue().splitlines()[-1])['type'] == 'cancelled'
    for field in ('maximumInputBytes', 'maximumOutputBytes'):
        init = initialization()
        init[field] = 1
        with pytest.raises(ValueError, match='transport limit'):
            run(BytesIO(encode([init, {'type': 'finish'}])), BytesIO())
