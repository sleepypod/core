import hashlib
import importlib.metadata
from pathlib import Path

import pytest

from common.biometrics import build_identity
from common.biometrics.config import config_hash


def test_identity_is_deterministic_and_contains_sources_and_installed_versions():
    first = build_identity.replay_build_identity()
    assert first == build_identity.replay_build_identity()
    assert first['hash'] == config_hash(first['identity'])
    assert set(first['identity']['sources']) == set(build_identity.SOURCE_FILES)
    assert 'common/biometrics/build_identity.py' in first['identity']['sources']
    assert 'common/biometrics/live_input.py' in first['identity']['sources']
    assert first['identity']['dependencies']['numpy']['version'] == importlib.metadata.version('numpy')
    assert first['identity']['dependencies']['scipy']['version'] == importlib.metadata.version('scipy')
    root = Path(build_identity.__file__).resolve().parents[2]
    assert first['identity']['sources']['piezo-processor/uv.lock'] == hashlib.sha256((root / 'piezo-processor/uv.lock').read_bytes()).hexdigest()


def test_changed_sources_and_dependency_metadata_change_identity(monkeypatch):
    before = build_identity.replay_build_identity()
    original = build_identity._digest_file
    monkeypatch.setattr(build_identity, '_digest_file', lambda path: '0' * 64 if path.name == 'signal.py' else original(path))
    assert build_identity.replay_build_identity()['hash'] != before['hash']
    monkeypatch.setattr(build_identity, '_digest_file', original)
    distribution = importlib.metadata.distribution

    class Changed:
        version = 'changed-build'

        def read_text(self, name):
            return name + '-changed'

    monkeypatch.setattr(importlib.metadata, 'distribution', lambda name: Changed() if name == 'numpy' else distribution(name))
    assert build_identity.replay_build_identity()['hash'] != before['hash']


def test_missing_wheel_metadata_and_oversize_sources_fail_closed(tmp_path, monkeypatch):
    source = tmp_path / 'source.py'
    source.write_bytes(b'12345')
    monkeypatch.setattr(build_identity, 'MAX_FILE_BYTES', 4)
    with pytest.raises(ValueError, match='bound'):
        build_identity._digest_file(source)
    monkeypatch.setattr(build_identity, 'MAX_FILE_BYTES', 16 * 1024 * 1024)

    class Missing:
        version = '1'

        def read_text(self, name):
            return None

    monkeypatch.setattr(importlib.metadata, 'distribution', lambda name: Missing())
    with pytest.raises(ValueError, match='unavailable'):
        build_identity.replay_build_identity()


def test_changed_shared_live_input_invalidates_replay_and_shadow_qualification(monkeypatch):
    from common.biometrics.shadow_build import shadow_build_identity
    before_replay = build_identity.replay_build_identity()['hash']
    before_shadow = shadow_build_identity()['hash']
    original = build_identity._digest_file
    monkeypatch.setattr(build_identity, '_digest_file', lambda path: '0' * 64 if path.name == 'live_input.py' else original(path))
    assert build_identity.replay_build_identity()['hash'] != before_replay
    assert shadow_build_identity()['hash'] != before_shadow
