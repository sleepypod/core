#!/usr/bin/env -S uv run --with numpy --with scikit-learn --quiet --no-project
"""The two personal stage models, off the pod, on the same features the iPhone computes.

Mirrors sleepypod-ios (docs/design/on-device-stage-training.md): 5-minute epochs
from each night's first labeled row, feature contract A (the challenger's
z-scores) or B (pod native), rare-class oversampling instead of class weights,
leave-one-night-out Cohen's kappa against the Watch, then a final fit.

Input is dataset.csv from scripts/sleep-stage-dataset.py. Nights are the
Watch-labeled rows of each (night, side); the bed window is the first to the
last labeled sample, which is what the pod record gives the phone.

Usage:
  personal-models.py dataset.csv [--contract A|B] [--model logistic|forest|both]
  personal-models.py dataset.csv --fixture night-fixture.json   # feature parity fixture for the Swift test
  personal-models.py dataset.csv --export out/                  # .mlmodel + card per model (needs coremltools)
"""
import argparse
import csv
import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

import numpy as np

STAGES = ('wake', 'light', 'deep', 'rem')          # class index order, as StageScore.order
EPOCH = 300
WINDOW_HALF = 450
CONTRACT_A = ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction']
CONTRACT_B = CONTRACT_A + ['hrvRel', 'hrv15Rel', 'hr15StdRel', 'br15Std', 'motion15', 'minutesSinceBed']
HYPER = {'logistic': {'maxIterations': 200, 'l2Penalty': 0.01}, 'forest': {'trees': 200, 'maxDepth': 4}}


def num(v):
    return float(v) if v not in ('', None) else None


def load(path):
    nights = defaultdict(list)
    with open(path, newline='') as f:
        for r in csv.DictReader(f):
            nights[(r['night'], r['side'])].append(r)
    for rows in nights.values():
        rows.sort(key=lambda r: int(r['ts']))
    return dict(sorted(nights.items()))


def pstd(values):
    return float(np.std(values)) if len(values) else 0.0


def zscores(values):
    values = np.asarray(values, dtype=float)
    s = pstd(values)
    return [0.0 if s == 0 else (v - values.mean()) / s for v in values]


def median(values):
    return float(np.median(values)) if len(values) else 0.0


def features(rows, entered, left, contract):
    """StageChallenger.features (A) plus StageFeatures.podNative (B), by column name, per kept epoch."""
    night = left - entered
    if night < EPOCH:
        return []
    count = int(night // EPOCH)
    hr = [(int(r['ts']), num(r['hr'])) for r in rows if num(r['hr']) is not None]
    hrv = [(int(r['ts']), num(r['hrv'])) for r in rows if num(r['hrv']) is not None]
    br = [(int(r['ts']), num(r['br'])) for r in rows if num(r['br']) is not None]
    mv = [(int(r['ts']), num(r['movement'])) for r in rows if num(r['movement']) is not None]
    kept = []
    for i in range(count):
        start = entered + i * EPOCH
        samples = [v for t, v in hr if start <= t < start + EPOCH]
        if not samples:
            continue
        motion = sum(v for t, v in mv if start <= t < start + EPOCH)
        kept.append((start, float(np.mean(samples)), pstd(samples) if len(samples) > 1 else 0.0, motion))
    hrz = zscores([k[1] for k in kept])
    hrstdz = zscores([k[2] for k in kept])
    motionz = zscores([math.log(1 + k[3]) for k in kept])
    out = []
    for i, (start, _, _, _) in enumerate(kept):
        out.append({'start': start, 'hrZ': hrz[i], 'hrStdZ': hrstdz[i], 'motionZ': motionz[i],
                    'nightFraction': (start - entered) / night})
    if contract == 'A':
        return out
    night_hrv_median = median([v for _, v in hrv])
    night_hr_std = pstd([v for _, v in hr])

    def ratio(value, denominator):
        return value / denominator if denominator > 0 and math.isfinite(denominator) else 0.0

    def window(samples, mid, half):
        return [v for t, v in samples if abs(t - mid) <= half]

    for row in out:
        mid = row['start'] + EPOCH / 2
        e_hrv = window(hrv, mid, EPOCH / 2)
        hrv15 = window(hrv, mid, WINDOW_HALF)
        hr15 = window(hr, mid, WINDOW_HALF)
        br15 = window(br, mid, WINDOW_HALF)
        motion15 = sum(v for t, v in mv if abs(t - mid) <= WINDOW_HALF)
        row.update({
            'hrvRel': ratio(float(np.mean(e_hrv)), night_hrv_median) if e_hrv else 0.0,
            'hrv15Rel': ratio(float(np.mean(hrv15)), night_hrv_median) if hrv15 else 0.0,
            'hr15StdRel': ratio(pstd(hr15), night_hr_std) if len(hr15) > 1 else 0.0,
            'br15Std': pstd(br15) if len(br15) > 1 else 0.0,
            'motion15': math.log(1 + motion15),
            'minutesSinceBed': (row['start'] - entered) / 60,
        })
    return out


def label(epochs, rows):
    """The Watch stage of the labeled row containing the epoch midpoint (first match), as StageDataset.label."""
    segments = []
    for r in rows:
        if r['watch_stage']:
            t = int(r['ts'])
            if segments and segments[-1][2] == r['watch_stage'] and t - segments[-1][1] <= 120:
                segments[-1][1] = t + 60
            else:
                segments.append([t, t + 60, r['watch_stage']])
    out = []
    for e in epochs:
        mid = e['start'] + EPOCH / 2
        for s, t, stage in segments:
            if s <= mid < t:
                out.append((e, STAGES.index(stage)))
                break
    return out


def oversample(rows):
    counts = Counter(y for _, y in rows)
    largest = max(counts.values())
    result = list(rows)
    for stage, count in counts.items():
        copies = largest // count - 1
        if copies > 0:
            members = [r for r in rows if r[1] == stage]
            for _ in range(copies):
                result.extend(members)
    return result


def kappa(y_true, y_pred):
    n = len(y_true)
    if n == 0:
        return None, None
    acc = sum(a == b for a, b in zip(y_true, y_pred)) / n
    ct, cp = Counter(y_true), Counter(y_pred)
    chance = sum((ct[k] / n) * (cp[k] / n) for k in range(len(STAGES)))
    return acc, (None if chance == 1 else (acc - chance) / (1 - chance))


def make(kind, seed=42):
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    if kind == 'logistic':
        return make_pipeline(StandardScaler(), LogisticRegression(max_iter=HYPER['logistic']['maxIterations'],
                                                                  C=1 / HYPER['logistic']['l2Penalty']))
    return RandomForestClassifier(HYPER['forest']['trees'], max_depth=HYPER['forest']['maxDepth'], random_state=seed)


def build(nights, contract):
    columns = CONTRACT_A if contract == 'A' else CONTRACT_B
    data = []
    for key, rows in nights.items():
        labeled = [r for r in rows if r['watch_stage']]
        if not labeled:
            continue
        entered, left = int(labeled[0]['ts']), int(labeled[-1]['ts']) + 60
        if sum(60 for r in labeled if r['watch_stage'] != 'wake') < 2 * 3600:
            print(f'  skip {key}: under 2 h of Watch sleep', file=sys.stderr)
            continue
        pairs = label(features(rows, entered, left, contract), rows)
        if pairs:
            data.append((key, [([e[c] for c in columns], y) for e, y in pairs]))
    return columns, data


def lono(data, kind, columns):
    y_all, p_all, per_night = [], [], []
    for i, (key, held) in enumerate(data):
        train = oversample([r for j, (_, rows) in enumerate(data) if j != i for r in rows])
        clf = make(kind).fit(np.array([x for x, _ in train]), np.array([y for _, y in train]))
        pred = clf.predict(np.array([x for x, _ in held])).tolist()
        truth = [y for _, y in held]
        acc, k = kappa(truth, pred)
        per_night.append((key, len(held), acc, k))
        y_all += truth
        p_all += pred
    return kappa(y_all, p_all), per_night


def export(data, kind, columns, out_dir, pooled, per_night):
    import coremltools as ct
    from pathlib import Path
    rows = oversample([r for _, night in data for r in night])
    clf = make(kind).fit(np.array([x for x, _ in rows]), np.array([y for _, y in rows]))
    model = ct.converters.sklearn.convert(clf, columns, 'classLabel')
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    model.save(f'{out_dir}/personal-{kind}.mlmodel')
    originals = [r for _, night in data for r in night]
    stride = max(1, len(originals) // 12)
    vectors = []
    for x, _ in originals[::stride][:12]:
        vectors.append({'inputs': dict(zip(columns, map(float, x))), 'expected': int(clf.predict(np.array([x]))[0])})
    acc, k = pooled
    nights = len(data)
    card = {
        'name': f'personal-{kind}', 'version': f'container-{kind}-{datetime.now(timezone.utc):%Y%m%dT%H%M}', 'model': kind,
        'classes': list(STAGES), 'features': columns, 'featureContract': columns, 'hyperparameters': HYPER[kind],
        'metrics': {kind: {'lono': {'epochs': len(originals), 'kappa': k, 'accuracy': acc, 'nights': nights}}},
        'training': {'dataset': 'Pod nights with Apple Watch labels, dataset.csv', 'subjects': nights},
        'limitations': 'One person, one pod, the Watch as reference. Experimental, not a medical device.',
        'testVectors': vectors,
    }
    with open(f'{out_dir}/personal-{kind}.card.json', 'w') as f:
        json.dump(card, f, indent=2, sort_keys=True)
    print(f'  wrote {out_dir}/personal-{kind}.mlmodel and card ({len(vectors)} test vectors)')


def fixture(nights, path):
    """One night's raw rows and the feature rows under both contracts, for SleepypodTests to replay."""
    key, rows = next(((k, r) for k, r in nights.items() if any(x['watch_stage'] for x in r)), (None, None))
    if rows is None:
        sys.exit('no labeled night for a fixture')
    labeled = [r for r in rows if r['watch_stage']]
    entered, left = int(labeled[0]['ts']), int(labeled[-1]['ts']) + 60
    doc = {
        'night': key[0], 'side': key[1], 'enteredBed': entered, 'leftBed': left,
        'vitals': [{'ts': int(r['ts']), 'hr': num(r['hr']), 'hrv': num(r['hrv']), 'br': num(r['br'])} for r in rows],
        'movement': [{'ts': int(r['ts']), 'total': num(r['movement'])} for r in rows if num(r['movement']) is not None],
        'contractA': features(rows, entered, left, 'A'),
        'contractB': features(rows, entered, left, 'B'),
    }
    with open(path, 'w') as f:
        json.dump(doc, f, indent=1)
    print(f'wrote {path}: {len(doc["contractA"])} epochs for night {key}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('csv')
    ap.add_argument('--contract', choices=['A', 'B'], default='A')
    ap.add_argument('--model', choices=['logistic', 'forest', 'both'], default='both')
    ap.add_argument('--export', metavar='DIR')
    ap.add_argument('--fixture', metavar='JSON')
    args = ap.parse_args()
    nights = load(args.csv)
    if args.fixture:
        fixture(nights, args.fixture)
        return
    columns, data = build(nights, args.contract)
    print(f'contract {args.contract}: {len(data)} nights, {sum(len(r) for _, r in data)} labeled epochs')
    if len(data) < 2:
        sys.exit('leave-one-night-out needs >= 2 Watch-labeled nights')
    for kind in (['logistic', 'forest'] if args.model == 'both' else [args.model]):
        pooled, per_night = lono(data, kind, columns)
        acc, k = pooled
        print(f'\n{kind}: pooled kappa {k:.3f} accuracy {acc:.1%}' if k is not None else f'\n{kind}: kappa undefined')
        for key, n, a, kk in per_night:
            print(f'  {key[0]} {key[1]}: n={n:3} acc={a:.1%} kappa={kk if kk is None else round(kk, 3)}')
        if args.export:
            export(data, kind, columns, args.export, pooled, per_night)


if __name__ == '__main__':
    main()
