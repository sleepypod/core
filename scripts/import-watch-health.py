#!/usr/bin/env -S uv run --quiet --no-project
"""
Import Apple Watch sleep stages, heart rate, breathing rate and HRV from a Health export into the pod.

    scripts/import-watch-health.py ~/Desktop/apple_health_export --pod 192.168.1.88 --side left

Reads export.xml (or the unzipped apple_health_export/ directory) with the same
parser as sleep-stage-dataset.py, keeps samples whose sourceName matches
--source (default: Watch) and was not written by sleepypod itself, and posts
them to the pod's REST API:

  POST /api/biometrics/reference-stages   SleepAnalysis segments (wake/light/deep/rem)
  POST /api/biometrics/reference-vitals   HeartRate samples
  POST /api/biometrics/reference-samples  RespiratoryRate (breathing_rate, breaths/min)
                                          and HeartRateVariabilitySDNN (hrv_sdnn, ms)

Heart rate, breathing rate and HRV are first-write-wins on side + time +
source (+ metric), so re-running on a newer export only adds what is new. Stages are stricter: a batch is rejected
(HTTP 400) when a segment overlaps a stored one with different boundaries,
e.g. a night the iOS app already posted. Such a batch is skipped with a
warning, the vitals are still imported, and the run exits 1 at the end.
Nothing is written to the pod's own `vitals` table: Watch heart rate lives in
`reference_vitals` (the Biometrics page draws it as a second line over the
pod's heart rate), breathing rate and HRV in `reference_samples`.

Options:
  --days N        only samples from the last N days (default 30; 0 = everything)
  --dry-run       parse and count, post nothing
  --stages-only / --hr-only (heart rate alone, without breathing rate and HRV)
"""
import argparse
import importlib.util
import json
import os
import sys
import time
import zipfile
from contextlib import contextmanager
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('sleep_stage_dataset', os.path.join(HERE, 'sleep-stage-dataset.py'))
_ds = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ds)
parse_export = _ds.parse_export

HK_RR = 'HKQuantityTypeIdentifierRespiratoryRate'
HK_HRV = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN'
# reference_samples metric, HK type, plausible range (the API enforces the same)
SAMPLE_METRICS = (('breathing_rate', HK_RR, 4, 60), ('hrv_sdnn', HK_HRV, 1, 500))
# Factors into the canonical unit (breaths/min, ms). Health exports use
# count/min and ms; anything unlisted is skipped instead of stored unconverted.
SAMPLE_UNITS = {HK_RR: {'count/min': 1, 'count/s': 60, 'Hz': 60}, HK_HRV: {'ms': 1, 's': 1000}}
# The sleepypod iOS app writes the pod's own HR, breathing, HRV and sleep stages
# back into Health (sourceName "sleepypod", "sleepypod design"). Those are never
# a reference, whatever --source says.
POD_SOURCE = '(?i)sleepypod'

# The API caps both endpoints at 2000 items per call.
BATCH = 2000
# importReferenceStages rejects a batch whose segments overlap each other.
# Health exports occasionally carry two sources' segments for the same minute;
# the dataset builder resolves that by letting the later start win, and so do we.


def warn(msg):
    print(f'warning: {msg}', file=sys.stderr)


def dedupe_segments(segments):
    """Resolve overlaps exactly as sleep-stage-dataset.stage_lookup does (the
    segment starting latest wins) by splitting at every segment boundary and
    merging runs of the same stage, so the posted labels match the export-based
    dataset. Returns non-overlapping [(start_s, end_s, stage)] sorted by start."""
    if not segments:
        return []
    stage_at = _ds.stage_lookup(segments)
    bounds = sorted({int(t.timestamp()) for s, e, _ in segments for t in (s, e)})
    out = []
    for a, b in zip(bounds, bounds[1:]):
        stage = stage_at(a)
        if stage is None:
            continue
        if out and out[-1][1] == a and out[-1][2] == stage:
            out[-1] = (out[-1][0], b, stage)
        else:
            out.append((a, b, stage))
    return out


def chunks(items, n=BATCH):
    for i in range(0, len(items), n):
        yield items[i:i + n]


class Rejected(Exception):
    """The pod answered 4xx: the batch is bad, the pod is fine."""

    def __init__(self, url, code, body):
        super().__init__(f'{url} returned {code}: {body[:500]}')
        self.code = code


def post_json(url, payload, timeout=30):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        if 400 <= e.code < 500:
            raise Rejected(url, e.code, body)
        raise SystemExit(f'error: {url} returned {e.code}: {body[:500]}')
    except urllib.error.URLError as e:
        raise SystemExit(f'error: cannot reach {url}: {e.reason}')


def base_url(pod):
    if pod.startswith('http://') or pod.startswith('https://'):
        return pod.rstrip('/')
    return f'http://{pod}:3000' if ':' not in pod else f'http://{pod}'


@contextmanager
def export_stream(export):
    """Read only the Health XML member; never extract arbitrary ZIP paths."""
    if zipfile.is_zipfile(export):
        with zipfile.ZipFile(export) as archive:
            entries = [entry for entry in archive.infolist()
                       if entry.filename in ('export.xml', 'apple_health_export/export.xml')]
            if len(entries) != 1:
                raise ValueError('ZIP must contain exactly one apple_health_export/export.xml or export.xml')
            if entries[0].file_size > 1024 * 1024 * 1024:
                raise ValueError('Expanded export.xml exceeds 1 GiB; export a smaller date range')
            with archive.open(entries[0]) as xml:
                yield xml
    else:
        yield export


def run(export, pod, side, source_pattern='Watch', days=30, dry_run=False,
        stages=True, hr=True, extra=True, post=post_json, now=None, report=False):
    now = time.time() if now is None else now
    cutoff = now - days * 86400 if days > 0 else float('-inf')
    quantities = {hk: [] for _, hk, _, _ in SAMPLE_METRICS}
    with export_stream(export) as xml:
        segments, hr_samples = parse_export(xml, source_pattern, cutoff=cutoff, quantities=quantities,
                                            exclude_pattern=POD_SOURCE, units=SAMPLE_UNITS)

    segs = [s for s in dedupe_segments(segments) if s[1] >= cutoff] if stages else []
    samples = [(t, bpm) for t, bpm in hr_samples if t >= cutoff and 20 <= bpm <= 250] if hr else []
    extras = {metric: [(t, v) for t, v in quantities[hk] if t >= cutoff and lo <= v <= hi] if extra else []
              for metric, hk, lo, hi in SAMPLE_METRICS}

    def span(times):
        if not times:
            return 'none'
        lo, hi = min(times), max(times)
        fmt = lambda t: datetime.fromtimestamp(t, timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M')
        return f'{fmt(lo)} → {fmt(hi)}'

    print(f'{len(segs)} stage segments ({span([s[0] for s in segs])}), '
          f'{len(samples)} heart-rate samples ({span([t for t, _ in samples])}), '
          f"{len(extras['breathing_rate'])} breathing-rate and {len(extras['hrv_sdnn'])} HRV samples for side {side}",
          file=sys.stderr)
    if dry_run:
        return {'stages': 0, 'vitals': 0, 'breathing': 0, 'hrv': 0}

    url = base_url(pod)
    written = {'stages': 0, 'vitals': 0, 'breathing': 0, 'hrv': 0}
    rejected = 0
    for batch in chunks(segs):
        try:
            out = post(f'{url}/api/biometrics/reference-stages', {
                'side': side, 'source': 'apple_watch',
                'segments': [{'start': a, 'end': b, 'stage': st} for a, b, st in batch],
            })
        except Rejected as e:
            # A stored segment with different boundaries (iOS app, older
            # import) blocks this batch; the rest of the run still goes in.
            warn(f'skipped a batch of {len(batch)} stage segments ({span([s[0] for s in batch])}): {e}')
            rejected += 1
            continue
        written['stages'] += int(out.get('written', 0))
    for batch in chunks(samples):
        out = post(f'{url}/api/biometrics/reference-vitals', {
            'side': side, 'source': 'apple_watch',
            'samples': [{'timestamp': t, 'heartRate': bpm} for t, bpm in batch],
        })
        written['vitals'] += int(out.get('written', 0))
    for metric, key in (('breathing_rate', 'breathing'), ('hrv_sdnn', 'hrv')):
        for batch in chunks(extras[metric]):
            out = post(f'{url}/api/biometrics/reference-samples', {
                'side': side, 'source': 'apple_watch', 'metric': metric,
                'samples': [{'timestamp': t, 'value': v} for t, v in batch],
            })
            written[key] += int(out.get('written', 0))
    print(f"wrote {written['stages']} new stage segments, {written['vitals']} new heart-rate, "
          f"{written['breathing']} new breathing-rate and {written['hrv']} new HRV samples to {url}",
          file=sys.stderr)
    if report:
        return {**written, 'rejectedStageBatches': rejected, 'matchedStages': len(segs), 'matchedVitals': len(samples),
                'matchedBreathing': len(extras['breathing_rate']), 'matchedHrv': len(extras['hrv_sdnn'])}
    if rejected:
        raise SystemExit(f'error: {rejected} stage batch(es) rejected by the pod; vitals were still imported')
    return written


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('export', help='export.xml or the apple_health_export directory')
    ap.add_argument('--pod', required=True, help='pod host/IP (port 3000 assumed) or a full http(s) URL')
    ap.add_argument('--side', choices=('left', 'right'), required=True, help='the side the Watch wearer sleeps on')
    ap.add_argument('--source', default='Watch', help='regex on export sourceName (default: Watch)')
    ap.add_argument('--days', type=int, default=30, help='only the last N days (default 30; 0 = all)')
    ap.add_argument('--json', action='store_true', help='return import counts and partial stage conflicts as JSON')
    ap.add_argument('--dry-run', action='store_true', help='parse and count only')
    group = ap.add_mutually_exclusive_group()
    group.add_argument('--stages-only', action='store_true')
    group.add_argument('--hr-only', action='store_true')
    args = ap.parse_args(argv)

    export = os.path.join(args.export, 'export.xml') if os.path.isdir(args.export) else args.export
    if not os.path.exists(export):
        ap.error(f'{export} not found')
    result = run(export, args.pod, args.side, args.source, args.days, args.dry_run,
        stages=not args.hr_only, hr=not args.stages_only, extra=not (args.hr_only or args.stages_only),
        report=args.json)
    if args.json:
        print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
