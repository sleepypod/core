#!/usr/bin/env -S uv run --with numpy --with scikit-learn --quiet --no-project
"""Windowed features per Watch stage + leave-one-night-out tree, from dataset.csv.

Input is the CSV written by scripts/sleep-stage-dataset.py. Exploratory only;
classifier v2 (PLAN.md workstream E) builds on this once >= 20 nights exist.

Usage: docs/research/sleep-stage-calibration/feat2.py dataset.csv
"""
import csv
import sys
from collections import Counter, defaultdict

import numpy as np

STAGES = ('wake', 'light', 'deep', 'rem')
KEYS = ['hr_std', 'hr_rel', 'hrv_rel', 'br_std', 'tso']


def num(v):
    return float(v) if v != '' else np.nan


def load(path):
    nights = defaultdict(list)
    with open(path, newline='') as f:
        for r in csv.DictReader(f):
            nights[(r['night'], r['side'])].append(r)
    for rows in nights.values():
        rows.sort(key=lambda r: int(r['ts']))
    return dict(sorted(nights.items()))


def windowed(rows):
    """15-min centered window features for every row of one night.

    Windows and elapsed fraction use timestamps, not row indices, so gaps in
    the vitals do not stretch a window across hours."""
    ts = np.array([int(r['ts']) for r in rows])
    hr = np.array([num(r['hr']) for r in rows])
    hrv = np.array([num(r['hrv']) for r in rows])
    br = np.array([num(r['br']) for r in rows])
    # A nonpositive median would make the ratios infinite; treat it as missing.
    medhr, medhrv = (m if m > 0 else np.nan for m in (np.nanmedian(hr), np.nanmedian(hrv)))
    lo = np.searchsorted(ts, ts - 450, side='left')
    hi = np.searchsorted(ts, ts + 450, side='right')
    span = max(ts[-1] - ts[0], 1)
    out = []
    for i, r in enumerate(rows):
        s = slice(lo[i], hi[i])
        out.append({'w': r['watch_stage'], 'hr_std': np.nanstd(hr[s]), 'hr_rel': np.nanmean(hr[s]) / medhr,
                    'hrv_rel': np.nanmean(hrv[s]) / medhrv, 'br_std': np.nanstd(br[s]),
                    'tso': (ts[i] - ts[0]) / span})
    return out


def main(path):
    nights = load(path)
    print('=== movement health per night (nonzero fraction, p50/p90/p99)')
    for (n, side), rows in nights.items():
        mv = [float(r['movement']) for r in rows if r['movement'] != '']
        if mv:
            print(f'  {n} {side}: n={len(mv)} nonzero={sum(1 for x in mv if x > 0) / len(mv):.0%} '
                  f'p50={np.percentile(mv, 50):.0f} p90={np.percentile(mv, 90):.0f} p99={np.percentile(mv, 99):.0f}')

    print('\n=== windowed features per Watch stage (15-min centered)')
    groups = defaultdict(list)
    for (n, side), rows in nights.items():
        f = [x for x in windowed(rows) if x['w']]
        if f:
            groups[n].extend(f)
        print(f'  night {n} {side}')
        for s in STAGES:
            g = [x for x in f if x['w'] == s]
            if g:
                m = {k: np.nanmedian([x[k] for x in g]) for k in KEYS}
                print(f"    {s:5} n={len(g):3} hr_std={m['hr_std']:.2f} hr_rel={m['hr_rel']:.3f} "
                      f"hrv_rel={m['hrv_rel']:.2f} br_std={m['br_std']:.2f} tso={m['tso']:.2f}")

    if len(groups) < 2:
        print('\nleave-one-night-out needs >= 2 Watch-labeled nights')
        return
    try:
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.tree import DecisionTreeClassifier
    except ImportError as e:
        print('no sklearn', e)
        return

    def X(g):
        return np.nan_to_num(np.array([[x[k] for k in KEYS] for x in g]), nan=0.0, posinf=0.0, neginf=0.0)

    def y(g):
        return [x['w'] for x in g]

    print('\n=== leave-one-night-out, windowed features, small tree / forest')
    for night, te in groups.items():
        tr = [x for n, g in groups.items() if n != night for x in g]
        for name, clf in (('tree d3', DecisionTreeClassifier(max_depth=3, class_weight='balanced', random_state=0)),
                          ('forest', RandomForestClassifier(200, max_depth=4, class_weight='balanced', random_state=0))):
            clf.fit(X(tr), y(tr))
            pr = clf.predict(X(te))
            acc = np.mean(pr == np.array(y(te)))
            print(f'  test night {night} {name:8} acc={acc:.0%} pred={dict(Counter(str(p) for p in pr))} truth={dict(Counter(y(te)))}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
