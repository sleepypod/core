#!/usr/bin/env python3
"""Train the personal sleep stage models on this Mac and put the winner on the pod, in one command.

Chains what already exists: a consistent snapshot of the pod's biometrics
database over SSH (README section 1), the per-minute dataset of pod vitals
with Apple Watch labels (scripts/sleep-stage-dataset.py --from-db), the two
models on a feature contract with leave-one-night-out scoring and the pod's
portable JSON export (docs/research/sleep-stage-calibration/personal-models.py
--export), then stores and previews a candidate on the pod with the model whose
pooled kappa is higher. Seconds on Apple silicon; nothing runs on the phone.

Usage:
  scripts/train-personal-models.py --pod 192.168.1.88 --side left
  scripts/train-personal-models.py --pod eight-pod.local --side left --contract A --kind logistic --no-upload
  scripts/train-personal-models.py --pod ... --snapshot poddb/biometrics.db   # reuse a snapshot
  scripts/train-personal-models.py --pod ... --keep-snapshot                  # keep the ~75 MB snapshot for reuse

The pod needs the sleep-stages model endpoints (sleepypod-core PR #855). The
Watch stages must already be on the pod (scripts/import-watch-health.py).
"""
import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / 'scripts' / 'sleep-stage-dataset.py'
MODELS = ROOT / 'docs' / 'research' / 'sleep-stage-calibration' / 'personal-models.py'
SNAPSHOT_SCRIPT = """
import sqlite3
src = sqlite3.connect('file:/persistent/sleepypod-data/biometrics.db?mode=ro', uri=True)
dst = sqlite3.connect('/persistent/sleepypod-data/biometrics.snapshot.db')
src.backup(dst)
dst.close()
print('snapshot ok')
"""


def run(cmd, **kw):
    print('+', ' '.join(str(c) for c in cmd), file=sys.stderr)
    return subprocess.run([str(c) for c in cmd], check=True, text=True, **kw)


def snapshot(pod, work):
    """Copy a backup-API snapshot of the pod's biometrics.db to work/biometrics.db."""
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-p', '8822', f'root@{pod}']
    run(ssh + ['python3', '-'], input=SNAPSHOT_SCRIPT)
    target = work / 'biometrics.db'
    run(['scp', '-o', 'BatchMode=yes', '-P', '8822', f'root@{pod}:/persistent/sleepypod-data/biometrics.snapshot.db', target])
    run(ssh + ['rm', '-f', '/persistent/sleepypod-data/biometrics.snapshot.db'])
    return target


def kappa_of(output, kind):
    """The pooled kappa personal-models.py printed for `kind`, or None."""
    match = re.search(rf'^{kind}: pooled kappa (-?[0-9.]+)', output, re.M)
    return float(match.group(1)) if match else None


def request_json(pod, endpoint, body, method='POST'):
    request = urllib.request.Request(f'http://{pod}:3000/api/sleep-stages/{endpoint}',
                                     data=json.dumps(body).encode(), method=method,
                                     headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace')
        sys.exit(f'pod refused {endpoint} ({error.code}): {detail[:400]}')


def upload(pod, side, path, *, select=False, activate=False):
    """Store and preview a candidate. Selection requires explicit opt-in."""
    model = json.loads(path.read_text())
    stored = request_json(pod, 'models', {'side': side, 'model': model})
    print(f'pod stored candidate {stored}')
    preview = request_json(pod, 'model/preview', {'side': side, 'nights': 14, 'model': model})
    print('Preview (training nights are in-sample):')
    print(json.dumps(preview, indent=2))
    if select or activate:
        selected = request_json(pod, 'models/selected',
                                {'side': side, 'id': stored['id'], 'active': activate}, 'PUT')
        print(f'pod selected {selected}')
    return stored


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pod', required=True, help='pod host or IP (ssh on 8822, API on 3000)')
    ap.add_argument('--side', choices=('left', 'right'), default='left')
    ap.add_argument('--contract', choices=('A', 'B'), default='B', help='feature contract (default B, pod native)')
    ap.add_argument('--kind', choices=('logistic', 'forest', 'auto'), default='auto', help='which model to upload (default: higher kappa)')
    ap.add_argument('--work', default='personal-models', help='working directory (default ./personal-models)')
    ap.add_argument('--snapshot', help='an existing biometrics.db snapshot instead of taking one')
    ap.add_argument('--no-upload', action='store_true', help='train and export only')
    ap.add_argument('--select', action='store_true', help='select the candidate, inactive (disables personal staging)')
    ap.add_argument('--activate', action='store_true', help='select and activate the candidate after preview')
    ap.add_argument('--keep-snapshot', action='store_true', help='leave the ~75 MB database snapshot in the work dir (deleted after a run by default)')
    args = ap.parse_args()
    if args.select and args.activate:
        ap.error('--select and --activate cannot be combined')
    if args.no_upload and (args.select or args.activate):
        ap.error('--no-upload cannot be combined with --select or --activate')

    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    db = Path(args.snapshot) if args.snapshot else snapshot(args.pod, work)
    dataset = work / 'dataset.csv'
    try:
        run([sys.executable, DATASET, '--from-db', db, '--side', args.side, '--out', dataset])
    finally:
        # The snapshot is the only large file this leaves behind; a supplied one is the caller's to keep.
        if not args.snapshot and not args.keep_snapshot:
            db.unlink(missing_ok=True)
            print(f'removed snapshot {db} (pass --keep-snapshot to keep it)', file=sys.stderr)

    out = work / f'contract-{args.contract}'
    result = run([MODELS, dataset, '--contract', args.contract, '--export', out], capture_output=True)
    print(result.stdout)
    scores = {kind: kappa_of(result.stdout, kind) for kind in ('logistic', 'forest')}
    kind = args.kind
    if kind == 'auto':
        ranked = sorted((k for k in scores if scores[k] is not None), key=lambda k: scores[k], reverse=True)
        if not ranked:
            sys.exit('no model scored; see the output above')
        kind = ranked[0]
    path = out / f'personal-{kind}.json'
    print(f'chosen: {kind} (pooled kappa {scores[kind]}) -> {path}')
    if args.no_upload:
        return
    upload(args.pod, args.side, path, select=args.select, activate=args.activate)


if __name__ == '__main__':
    main()
