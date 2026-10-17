"""Laptop entry point for the shipped retained waveform worker.

Calls the unchanged common.biometrics.replay_worker.run(), so readings come
from the same sources the pod pins in its Python build hash. Only the pod's
host-wide execution lock, CPU rlimit and nice level are left out, which lets
several nights replay in parallel on a development machine.
"""
import os
import sys

for key in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
    os.environ[key] = '1'


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('--retained-directory', '--describe-build'):
        sys.stderr.write('usage: local_replay.py --retained-directory DIR | --describe-build -\n')
        return 2
    try:
        if sys.argv[1] == '--describe-build':
            import json
            from common.biometrics.build_identity import replay_build_identity
            sys.stdout.write(json.dumps(replay_build_identity(), allow_nan=False, separators=(',', ':')) + '\n')
        else:
            from common.biometrics.replay_worker import run
            run(sys.stdin.buffer, sys.stdout.buffer, sys.argv[2])
        return 0
    except Exception:
        sys.stderr.write('Retained waveform worker failed\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())
