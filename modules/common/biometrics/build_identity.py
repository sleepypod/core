"""Versioned identity of the shipped replay sources and installed runtime.

Distribution RECORD hashes identify installed wheel metadata, not an attestation
that every installed binary is unmodified. No archive or patient data is read.
"""
import hashlib
import importlib.metadata
from pathlib import Path
import platform
import sys
import sysconfig

from .config import config_hash

SOURCE_FILES = (
    'common/__init__.py', 'common/cbor_raw.py',
    'common/biometrics/__init__.py', 'common/biometrics/build_identity.py',
    'common/biometrics/config.py', 'common/biometrics/manifest.v1.json',
    'common/biometrics/live_input.py', 'common/biometrics/mechanical.py', 'common/biometrics/frames.py', 'common/biometrics/gates.py',
    'common/biometrics/processing.py', 'common/biometrics/routing.py',
    'common/biometrics/signal.py', 'common/biometrics/raw_artifacts.py',
    'common/biometrics/raw_records.py', 'common/biometrics/retained_replay.py',
    'common/biometrics/execution_lock.py',
    'common/biometrics/replay.py', 'common/biometrics/replay_worker.py',
    'piezo-processor/pyproject.toml', 'piezo-processor/uv.lock',
)
MAX_FILE_BYTES = 16 * 1024 * 1024


def _digest_file(path):
    digest = hashlib.sha256()
    size = 0
    with path.open('rb') as stream:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_FILE_BYTES:
                raise ValueError('Replay build identity file exceeds its bound')
            digest.update(chunk)
    return digest.hexdigest()


def replay_build_identity():
    root = Path(__file__).resolve().parents[2]
    sources = {name: _digest_file(root / name) for name in SOURCE_FILES}
    dependencies = {}
    for name in ('numpy', 'scipy'):
        distribution = importlib.metadata.distribution(name)
        record = distribution.read_text('RECORD')
        wheel = distribution.read_text('WHEEL')
        if not record or not wheel or len(record.encode()) > MAX_FILE_BYTES or len(wheel.encode()) > MAX_FILE_BYTES:
            raise ValueError('Replay dependency build metadata is unavailable')
        dependencies[name] = {'version': distribution.version,
            'record_sha256': hashlib.sha256(record.encode()).hexdigest(),
            'wheel_sha256': hashlib.sha256(wheel.encode()).hexdigest()}
    identity = {'version': 'waveform-python-build-v1', 'sources': sources,
        'dependencies': dependencies, 'runtime': {
            'implementation': platform.python_implementation(), 'version': sys.version,
            'cache_tag': sys.implementation.cache_tag, 'soabi': sysconfig.get_config_var('SOABI'),
            'machine': platform.machine(), 'system': platform.system(), 'byteorder': sys.byteorder,
        }}
    return {'hash': config_hash(identity), 'identity': identity}
