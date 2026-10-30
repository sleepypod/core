#!/usr/bin/env python3
"""Check installed sensor dependencies without importing daemons or opening hardware."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

MODULE_IMPORTS = {
    'piezo-processor': ['cbor2', 'nats', 'numpy', 'scipy.signal', 'heartpy'],
    'sleep-detector': ['cbor2', 'nats', 'numpy'],
    'environment-monitor': ['cbor2', 'nats'],
    'calibrator': ['cbor2', 'nats'],
    'cover-buttons': ['cbor2'],
}

IMPORT_PROBE = '''import importlib, importlib.metadata, json, sys
for name in sys.argv[1:]:
    importlib.import_module(name)
if 'numpy' in sys.argv:
    import numpy as np
    assert float(np.arange(5).sum()) == 10
if 'scipy.signal' in sys.argv:
    from scipy.signal import welch
    spectrum = welch(np.sin(np.arange(2048) / 20), fs=500)
    assert all(np.isfinite(part).all() for part in spectrum)
print(json.dumps({'python': sys.version.split()[0], 'imports': 'ok',
    'packages': {item.metadata['Name']: item.version for item in importlib.metadata.distributions()}}))
'''


def probe_module(root, name):
    """Use the real venv in isolation; tests must not stub missing runtime imports."""
    folder = root / name
    fingerprints = {
        filename: hashlib.sha256((folder / filename).read_bytes()).hexdigest()
        for filename in ['pyproject.toml', 'uv.lock']
    }
    with tempfile.TemporaryDirectory(prefix='sleepypod-import-probe-') as temporary:
        result = subprocess.run(
            [str(folder / '.venv/bin/python'), '-I', '-c', IMPORT_PROBE, *MODULE_IMPORTS[name]],
            cwd=temporary, capture_output=True, text=True, timeout=45,
            env={**os.environ, 'MPLCONFIGDIR': temporary},
        )
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:] or f'Interpreter exited {result.returncode}')
    report = json.loads(result.stdout)
    if report.get('imports') != 'ok' or not isinstance(report.get('packages'), dict):
        raise ValueError('Invalid dependency probe response')
    return {**report, 'files': fingerprints}


def probe_modules(root, names):
    results = {}
    for name in names:
        try:
            results[name] = {'ok': True, **probe_module(root, name)}
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            results[name] = {'ok': False, 'error': str(error)[-2000:]}
    return {'probeVersion': 1, 'ok': all(item['ok'] for item in results.values()),
            'applicationImported': False, 'servicesStarted': False, 'modules': results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--modules-root', type=Path, required=True)
    parser.add_argument('--module', choices=MODULE_IMPORTS, action='append')
    parser.add_argument('--output', type=Path, help='Optional new private JSON receipt; never overwritten')
    arguments = parser.parse_args()
    report = probe_modules(arguments.modules_root.resolve(), arguments.module or list(MODULE_IMPORTS))
    encoded = json.dumps(report, indent=2) + '\n'
    if arguments.output:
        descriptor = os.open(arguments.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            output.write(encoded)
    print(encoded, end='')
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
