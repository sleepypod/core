#!/usr/bin/env -S uv run --quiet --no-project
"""
Sleep-stage dataset builder: joins Apple Watch sleep stages with pod vitals.

Emits one CSV row per pod vitals sample (about one per minute) for every night
that has Watch stage labels:

    night,side,ts,watch_stage,hr,hrv,br,movement,hr_quality,watch_hr

- night        local date the night started (sample time minus 12 h)
- ts           pod vitals timestamp, unix seconds
- watch_stage  wake|light|deep|rem of the Watch segment containing ts, empty if none
- hr,hrv,br    raw pod vitals (not outlier-filtered)
- movement     nearest movement.total_movement within 60 s, empty if none
- hr_quality   vitals_quality.quality_score for that vitals row, empty if none
- watch_hr     nearest Watch heart-rate sample within 60 s, empty if none

A night's window is the Watch stage coverage padded by --pad-min on each side.
Nights whose pod-vs-Watch mean absolute HR difference exceeds --max-hr-mad are
skipped with a warning: that pattern means the Watch wearer slept on the other
side.

--summary prints per-night agreement with the Watch for the classifier in
src/lib/sleep-stages.ts (ported below), as deployed (calibrationQuality 0,
movement-only) and with the iOS rule set (calibrationQuality 1), plus the
always-light baseline.

Usage:
  scripts/sleep-stage-dataset.py export.xml biometrics.db --side left --out dataset.csv
  scripts/sleep-stage-dataset.py apple_health_export/ biometrics.db --summary
  scripts/sleep-stage-dataset.py --from-db biometrics.db --side left --out dataset.csv

--from-db reads Watch stages from the reference_stages table that
biometrics.importReferenceStages writes, instead of a Health export. That source
carries no Watch heart rate, so the side-mismatch guard cannot run.

See docs/research/sleep-stage-calibration/README.md for pulling the pod DB.
Stdlib only; runs under python3 >= 3.9 directly or via the uv shebang.
"""

import argparse
import bisect
import csv
import math
import os
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

STAGES = ('wake', 'light', 'deep', 'rem')
CSV_FIELDS = ('night', 'side', 'ts', 'watch_stage', 'hr', 'hrv', 'br', 'movement', 'hr_quality', 'watch_hr')

# HKCategoryValueSleepAnalysis* -> stage. InBed, Asleep and AsleepUnspecified
# carry no stage and are ignored.
HK_STAGE = {
    'HKCategoryValueSleepAnalysisAwake': 'wake',
    'HKCategoryValueSleepAnalysisAsleepCore': 'light',
    'HKCategoryValueSleepAnalysisAsleepDeep': 'deep',
    'HKCategoryValueSleepAnalysisAsleepREM': 'rem',
}
HK_SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis'
HK_HR = 'HKQuantityTypeIdentifierHeartRate'

JOIN_TOLERANCE_S = 60
MIN_HR_MATCHES = 10
NIGHT_ROLLOVER = timedelta(hours=12)


def warn(msg):
    print(f'warning: {msg}', file=sys.stderr)


def night_of(dt):
    """Local date the night started; dt must be timezone-aware local time."""
    return (dt - NIGHT_ROLLOVER).date().isoformat()


# ── Health export ──────────────────────────────────────────────────────────

def parse_export(path, source_pattern='Watch'):
    """Stream export.xml and return (stage_segments, hr_samples) for sources
    matching source_pattern.

    stage_segments: [(start_dt, end_dt, stage)] in file order (aware datetimes)
    hr_samples:     [(unix_s, bpm)] sorted by time
    """
    if os.path.isdir(path):
        path = os.path.join(path, 'export.xml')
    source_re = re.compile(source_pattern)
    segments, hr = [], []

    def add(a):
        kind = a.get('type')
        if kind not in (HK_SLEEP, HK_HR) or not source_re.search(a.get('sourceName', '')):
            return
        try:
            start = datetime.strptime(a['startDate'], '%Y-%m-%d %H:%M:%S %z')
            end = datetime.strptime(a['endDate'], '%Y-%m-%d %H:%M:%S %z')
        except (KeyError, ValueError):
            return
        if kind == HK_SLEEP:
            stage = HK_STAGE.get(a.get('value', ''))
            if stage and end > start:
                segments.append((start, end, stage))
            return
        try:
            bpm = float(a['value'])
        except (KeyError, ValueError):
            return
        if math.isfinite(bpm):
            hr.append((int(start.timestamp()), bpm))

    # Incremental parse, so record layout (line breaks, attribute wrapping)
    # does not matter. Clearing the root after each record keeps memory flat.
    events = ET.iterparse(path, events=('start', 'end'))
    _, root = next(events)
    for event, elem in events:
        if event == 'end' and elem.tag == 'Record':
            add(elem.attrib)
            root.clear()
    hr.sort()
    return segments, hr


def segments_from_db(conn, side, source='apple_watch'):
    """Read Watch stage segments from reference_stages (sleepypod-core-116).

    Timestamps are unix seconds (Drizzle mode 'timestamp'); millisecond values
    are tolerated. Returns segments as local aware datetimes, like parse_export.
    """
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_stages'").fetchone()
    if not exists:
        raise SystemExit(
            'error: reference_stages table not found in the DB. It is created by the '
            'biometrics.importReferenceStages migration; pass a Health export instead.')

    def to_dt(v):
        v = float(v)
        if v > 1e11:
            v /= 1000.0
        return datetime.fromtimestamp(v).astimezone()

    rows = conn.execute(
        'SELECT start, "end", stage FROM reference_stages WHERE side = ? AND source = ? ORDER BY start',
        (side, source)).fetchall()
    return [(to_dt(s), to_dt(e), st) for s, e, st in rows if st in STAGES and float(e) > float(s)]


def stage_lookup(segments):
    """Return stage_at(ts) -> stage of the segment whose [start, end) contains
    unix second ts, else None. Where segments overlap, the one starting latest
    wins, so export file order and DB order give the same labels."""
    segs = sorted((s.timestamp(), e.timestamp(), st) for s, e, st in segments)
    starts = [s for s, _, _ in segs]
    reach, m = [], float('-inf')
    for _, e, _ in segs:
        m = max(m, e)
        reach.append(m)

    def stage_at(ts):
        j = bisect.bisect_right(starts, ts) - 1
        # reach[j] is the latest end among segments 0..j; once it is <= ts no
        # earlier segment can contain ts.
        while j >= 0 and reach[j] > ts:
            if segs[j][1] > ts:
                return segs[j][2]
            j -= 1
        return None

    return stage_at


def group_nights(segments, pad_min):
    """{night: (window_start_s, window_end_s)} from Watch coverage + padding.

    Windows are disjoint: a window that touches the previous night's (sleep
    spanning the noon rollover, or padding) is merged into that night, so no
    vitals row is emitted under two nights."""
    spans = {}
    for start, end, _ in segments:
        n = night_of(start)
        s, e = start.timestamp(), end.timestamp()
        if n in spans:
            spans[n] = (min(spans[n][0], s), max(spans[n][1], e))
        else:
            spans[n] = (s, e)
    pad = pad_min * 60
    out, prev = {}, None
    for n, (s, e) in sorted(spans.items(), key=lambda kv: kv[1][0]):
        s, e = int(s - pad), int(e + pad)
        if prev is not None and s <= out[prev][1]:
            out[prev] = (out[prev][0], max(out[prev][1], e))
            continue
        out[n] = (s, e)
        prev = n
    return out


# ── Pod DB ─────────────────────────────────────────────────────────────────

def load_pod(conn, side, start_s, end_s, join_pad_s=0):
    """Return (vitals, movement) for one side and window, ascending.

    vitals:   [(id, ts, hr, hrv, br, quality)]
    movement: [(ts, total_movement)], over the window widened by join_pad_s
              on each side so vitals at the edges can match their nearest row
    """
    has_quality = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vitals_quality'").fetchone()
    if has_quality:
        q = ('SELECT v.id, v.timestamp, v.heart_rate, v.hrv, v.breathing_rate, '
             '(SELECT quality_score FROM vitals_quality WHERE vitals_id = v.id ORDER BY id DESC LIMIT 1) '
             'FROM vitals v WHERE v.side = ? AND v.timestamp BETWEEN ? AND ? ORDER BY v.timestamp')
    else:
        q = ('SELECT id, timestamp, heart_rate, hrv, breathing_rate, NULL '
             'FROM vitals WHERE side = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp')
    vitals = conn.execute(q, (side, start_s, end_s)).fetchall()
    movement = conn.execute(
        'SELECT timestamp, total_movement FROM movement WHERE side = ? AND timestamp BETWEEN ? AND ? '
        'ORDER BY timestamp', (side, start_s - join_pad_s, end_s + join_pad_s)).fetchall()
    return vitals, movement


def nearest(times, values, t, tol=JOIN_TOLERANCE_S):
    """Value whose time is nearest t within tol (earlier wins ties), else None."""
    i = bisect.bisect_left(times, t)
    best, best_d = None, None
    for j in (i - 1, i):
        if 0 <= j < len(times):
            d = abs(times[j] - t)
            if d <= tol and (best_d is None or d < best_d):
                best, best_d = values[j], d
    return best


def join_night(night, side, vitals, movement, stage_at, watch_hr):
    """Build dataset rows (dicts keyed by CSV_FIELDS) for one night."""
    mov_t = [t for t, _ in movement]
    mov_v = [v for _, v in movement]
    hr_t = [t for t, _ in watch_hr]
    hr_v = [v for _, v in watch_hr]
    rows = []
    for _id, ts, hr, hrv, br, quality in vitals:
        rows.append({
            'night': night,
            'side': side,
            'ts': int(ts),
            'watch_stage': stage_at(ts),
            'hr': hr,
            'hrv': hrv,
            'br': br,
            'movement': nearest(mov_t, mov_v, ts),
            'hr_quality': quality,
            'watch_hr': nearest(hr_t, hr_v, ts),
        })
    return rows


def hr_mad(rows):
    """(mean |pod HR - Watch HR|, matched count) over rows with both values
    finite."""
    diffs = [abs(r['hr'] - r['watch_hr']) for r in rows if r['hr'] is not None and r['watch_hr'] is not None]
    diffs = [d for d in diffs if math.isfinite(d)]
    return (sum(diffs) / len(diffs) if diffs else None), len(diffs)


# ── Classifier port of src/lib/sleep-stages.ts ─────────────────────────────
# Keep in lockstep with classifySleepStages / classifyEpoch / filterOutliers.

def _js_round(x):
    return math.floor(x + 0.5)


def filter_outliers(vitals):
    """[(ts, hr, hrv, br)] -> same with outliers nulled (hard limits + ±2 HR median filter)."""
    def ok_hr(h):
        return h is not None and 45 <= h <= 130

    out = []
    n = len(vitals)
    for i, (ts, hr, hrv, br) in enumerate(vitals):
        if hr is not None and (hr < 45 or hr > 130):
            hr = None
        if hrv is not None and (hrv < 1 or hrv > 300):
            hrv = None
        if br is not None and (br < 8 or br > 25):
            br = None
        if hr is not None:
            window = [w[1] for w in vitals[max(0, i - 2):min(n - 1, i + 2) + 1] if ok_hr(w[1])]
            if window:
                median = sorted(window)[len(window) // 2]
                mean = sum(window) / len(window)
                std = math.sqrt(sum((h - mean) ** 2 for h in window) / len(window))
                if std > 0 and abs(hr - median) > 2 * std:
                    hr = None
        out.append((ts, hr, hrv, br))
    return out


def classify_epoch(hr, hrv, mov, avg_hr, cq):
    if cq < 0.3:
        if mov is not None and mov > 200:
            return 'wake'
        return 'light'
    if mov is not None and mov > 200:
        return 'wake'
    if hr is not None and hr > 0:
        ratio = hr / avg_hr
        if ratio < 0.92:
            return 'deep'
        if ratio >= 0.95:
            if hrv is not None and hrv < 25 and mov is not None and mov < 30:
                return 'rem'
            if mov is not None and mov < 50 and hrv is not None and hrv < 40:
                return 'rem'
            if mov is not None and mov > 100:
                return 'wake'
    return 'light'


def classify_sleep_stages(vitals, movement, calibration_quality=0.0):
    """vitals [(ts_s, hr, hrv, br)], movement [(ts_s, total)] -> [(ts_s, stage)].

    Mirrors classifySleepStages: outlier filter, 5-min movement buckets
    (last row wins), phase-1 rules, A-B-A smoothing, transition constraints.
    """
    if not vitals:
        return []
    v = filter_outliers(sorted(vitals, key=lambda r: r[0]))

    buckets = {}
    for ts, total in movement:
        buckets[_js_round(ts * 1000 / 300_000) * 300_000] = total

    valid = [hr for _, hr, _, _ in v if hr is not None and hr > 0]
    avg_hr = sum(valid) / len(valid) if valid else 60

    stages = [
        classify_epoch(hr, hrv, buckets.get(_js_round(ts * 1000 / 300_000) * 300_000), avg_hr, calibration_quality)
        for ts, hr, hrv, _ in v
    ]
    for i in range(1, len(stages) - 1):
        if stages[i - 1] == stages[i + 1] and stages[i] != stages[i - 1]:
            stages[i] = stages[i - 1]
    blocked = {('wake', 'deep'), ('deep', 'wake'), ('deep', 'rem'), ('rem', 'deep')}
    for i in range(1, len(stages)):
        if (stages[i - 1], stages[i]) in blocked:
            stages[i] = 'light'
    return [(ts, s) for (ts, *_), s in zip(v, stages)]


# ── Summary ────────────────────────────────────────────────────────────────

def agreement(rows, predicted):
    """Percent of Watch-labeled rows where predicted[ts] equals watch_stage."""
    labeled = [r for r in rows if r['watch_stage']]
    if not labeled:
        return None
    hit = sum(1 for r in labeled if predicted.get(r['ts']) == r['watch_stage'])
    return 100.0 * hit / len(labeled)


def summarize_night(rows, movement):
    vitals = [(r['ts'], r['hr'], r['hrv'], r['br']) for r in rows]
    deployed = dict(classify_sleep_stages(vitals, movement, 0.0))
    ios = dict(classify_sleep_stages(vitals, movement, 1.0))
    light = {r['ts']: 'light' for r in rows}
    return {
        'labeled': sum(1 for r in rows if r['watch_stage']),
        'deployed': agreement(rows, deployed),
        'ios': agreement(rows, ios),
        'light': agreement(rows, light),
        'watch_dist': Counter(r['watch_stage'] for r in rows if r['watch_stage']),
    }


def print_summary(results, out=None):
    out = out or sys.stdout

    def pct(x):
        return '   n/a' if x is None else f'{x:5.0f}%'

    def mad(x):
        return '   n/a' if x is None else f'{x:6.1f}'

    print('night       side   rows labeled  HR-MAD  deployed(cq=0)  iOS(cq=1)  always-light', file=out)
    for r in results:
        print(f"{r['night']}  {r['side']:5} {r['rows']:5} {r['labeled']:7} {mad(r['mad'])}  "
              f"{pct(r['deployed']):>14}  {pct(r['ios']):>9}  {pct(r['light']):>12}", file=out)
    print('\nWatch-labeled samples per night:', file=out)
    for r in results:
        dist = ', '.join(f'{s}={r["watch_dist"].get(s, 0)}' for s in STAGES)
        print(f"  {r['night']}: {dist}", file=out)


# ── Driver ─────────────────────────────────────────────────────────────────

def build(conn, segments, watch_hr, side, pad_min=10, max_hr_mad=8.0, nights=None):
    """Return [(night, rows, movement, mad, matched)] for nights passing the guard."""
    stage_at = stage_lookup(segments)
    out = []
    for night, (start_s, end_s) in group_nights(segments, pad_min).items():
        if nights and night not in nights:
            continue
        vitals, near_mov = load_pod(conn, side, start_s, end_s, JOIN_TOLERANCE_S)
        if not vitals:
            warn(f'{night}: no {side} vitals in the Watch window; skipped')
            continue
        # Join candidates reach JOIN_TOLERANCE_S past the window; the
        # classifier's movement input stays inside it.
        hr_in = [(t, v) for t, v in watch_hr if start_s - JOIN_TOLERANCE_S <= t <= end_s + JOIN_TOLERANCE_S]
        rows = join_night(night, side, vitals, near_mov, stage_at, hr_in)
        movement = [(t, v) for t, v in near_mov if start_s <= t <= end_s]
        mad, matched = hr_mad(rows)
        if matched < MIN_HR_MATCHES:
            warn(f'{night}: only {matched} pod/Watch HR matches; side-mismatch guard not applied')
        elif mad > max_hr_mad:
            warn(f'{night}: pod {side} vs Watch HR MAD {mad:.1f} bpm > {max_hr_mad:g} '
                 f'({matched} matches); likely the other side, skipped')
            continue
        out.append((night, rows, movement, mad, matched))
    return out


def _fmt(v):
    if v is None:
        return ''
    if isinstance(v, float):
        if v != 0 and abs(v) < 0.0005:
            # Three decimals would print it as 0.
            return f'{v:.3g}'
        return f'{v:.3f}'.rstrip('0').rstrip('.')
    return v


def write_csv(nights, fh):
    w = csv.writer(fh, lineterminator='\n')
    w.writerow(CSV_FIELDS)
    for _night, rows, *_ in nights:
        for r in rows:
            w.writerow([_fmt(r[k]) for k in CSV_FIELDS])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('inputs', nargs='+', metavar='PATH',
                    help='<export.xml | export dir> <biometrics.db>, or just <biometrics.db> with --from-db')
    ap.add_argument('--from-db', action='store_true',
                    help='read Watch stages from the reference_stages table instead of an export')
    ap.add_argument('--side', choices=('left', 'right'), default='left')
    ap.add_argument('--out', help='CSV path (default: stdout unless --summary)')
    ap.add_argument('--summary', action='store_true', help='print per-night classifier agreement')
    ap.add_argument('--nights', help='comma-separated night dates to keep, e.g. 2026-10-08,2026-10-09')
    ap.add_argument('--source', default='Watch', help='regex on export sourceName (default: Watch)')
    ap.add_argument('--pad-min', type=int, default=10, help='minutes added around Watch coverage (default 10)')
    ap.add_argument('--max-hr-mad', type=float, default=8.0, help='side-mismatch guard threshold in bpm (default 8)')
    args = ap.parse_args(argv)

    expected = 1 if args.from_db else 2
    if len(args.inputs) != expected:
        ap.error('expected <biometrics.db> with --from-db' if args.from_db
                 else 'expected <export.xml | export dir> <biometrics.db>')
    db_path = args.inputs[-1]
    if not os.path.exists(db_path):
        ap.error(f'{db_path} not found')
    inputs = [db_path]
    if not args.from_db:
        export = args.inputs[0]
        export_xml = os.path.join(export, 'export.xml') if os.path.isdir(export) else export
        if not os.path.exists(export_xml):
            ap.error(f'{export_xml} not found')
        inputs.append(export_xml)
    if args.out and os.path.exists(args.out) and any(os.path.samefile(args.out, p) for p in inputs):
        ap.error(f'--out {args.out} is an input file; refusing to overwrite it')
    # as_uri() percent-encodes ?, # and %, which SQLite would otherwise read
    # as URI syntax and open a different file.
    conn = sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True)

    if args.from_db:
        segments, watch_hr = segments_from_db(conn, args.side), []
    else:
        try:
            segments, watch_hr = parse_export(export_xml, args.source)
        except ET.ParseError as e:
            raise SystemExit(f'error: {export_xml} is not valid XML: {e}')
    if not segments:
        raise SystemExit('error: no Watch sleep-stage samples found')

    wanted = {n.strip() for n in args.nights.split(',') if n.strip()} if args.nights else None
    nights = build(conn, segments, watch_hr, args.side, args.pad_min, args.max_hr_mad, wanted)

    if args.out:
        with open(args.out, 'w', newline='') as fh:
            write_csv(nights, fh)
        print(f'wrote {sum(len(n[1]) for n in nights)} rows for {len(nights)} nights to {args.out}', file=sys.stderr)
    elif not args.summary:
        write_csv(nights, sys.stdout)

    if args.summary:
        results = []
        for night, rows, movement, mad, _matched in nights:
            s = summarize_night(rows, movement)
            results.append({'night': night, 'side': args.side, 'rows': len(rows), 'mad': mad, **s})
        if results:
            print_summary(results)
        else:
            print('no nights passed the filters', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
