"""Tests for scripts/import-watch-health.py with a synthetic Health export and a
recording stand-in for the pod's REST API.

Run: python3 -m unittest scripts/tests/test_import_watch_health.py
 (or: uv run --with pytest --no-project pytest scripts/tests/test_import_watch_health.py)
"""

import contextlib
import importlib.util
import io
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    'import_watch_health', os.path.join(HERE, '..', 'import-watch-health.py'))
iw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(iw)

TZ = timezone(timedelta(hours=-7))
T0 = datetime(2026, 10, 9, 2, 0, tzinfo=TZ)
WATCH = "Jon&#8217;s Apple Watch"


def hk_time(dt):
    return dt.strftime('%Y-%m-%d %H:%M:%S %z')


def sleep_record(start, end, value, source=WATCH):
    return (f' <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="{source}" '
            f'startDate="{hk_time(start)}" endDate="{hk_time(end)}" '
            f'value="HKCategoryValueSleepAnalysis{value}"/>\n')


def hr_record(at, bpm, source=WATCH):
    return (f' <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="{source}" unit="count/min" '
            f'startDate="{hk_time(at)}" endDate="{hk_time(at)}" value="{bpm}"/>\n')


def quantity_record(kind, at, value, unit, source=WATCH):
    return (f' <Record type="HKQuantityTypeIdentifier{kind}" sourceName="{source}" unit="{unit}" '
            f'startDate="{hk_time(at)}" endDate="{hk_time(at)}" value="{value}"/>\n')


def write_export(path, segments, hr, rr=(), hrv=(), extra=''):
    parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n']
    for a, b, v in segments:
        parts.append(sleep_record(T0 + timedelta(minutes=a), T0 + timedelta(minutes=b), v))
    for m, bpm in hr:
        parts.append(hr_record(T0 + timedelta(minutes=m), bpm))
    for m, v in rr:
        parts.append(quantity_record('RespiratoryRate', T0 + timedelta(minutes=m), v, 'count/min'))
    for m, v in hrv:
        parts.append(quantity_record('HeartRateVariabilitySDNN', T0 + timedelta(minutes=m), v, 'ms'))
    parts.append(extra)
    parts.append('</HealthData>\n')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(''.join(parts))


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, url, payload):
        self.calls.append((url, payload))
        key = 'segments' if 'segments' in payload else 'samples'
        return {'written': len(payload[key])}


class RejectingRecorder(Recorder):
    """Pod stand-in that refuses every stage batch like a stored-overlap 400."""

    def __call__(self, url, payload):
        if 'segments' in payload:
            self.calls.append((url, payload))
            raise iw.Rejected(url, 400, 'Segments overlap stored reference stages')
        return super().__call__(url, payload)


class ImportWatchHealthTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.export = os.path.join(self.tmp.name, 'export.xml')
        self.now = (T0 + timedelta(days=1)).timestamp()

    def tearDown(self):
        self.tmp.cleanup()

    def run_import(self, **kw):
        post = Recorder()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            written = iw.run(self.export, '192.168.1.88', 'left', post=post, now=self.now, **kw)
        return post, written, err.getvalue()

    def test_posts_stages_and_heart_rate_to_the_pod_endpoints(self):
        write_export(self.export, [(0, 20, 'AsleepCore'), (20, 50, 'AsleepDeep'), (50, 60, 'Awake')],
                     [(1, 58), (6, 56.5), (11, 61)])
        post, written, err = self.run_import()
        urls = [u for u, _ in post.calls]
        self.assertEqual(urls, ['http://192.168.1.88:3000/api/biometrics/reference-stages',
                                'http://192.168.1.88:3000/api/biometrics/reference-vitals'])
        stages = post.calls[0][1]
        self.assertEqual(stages['side'], 'left')
        self.assertEqual(stages['source'], 'apple_watch')
        self.assertEqual([s['stage'] for s in stages['segments']], ['light', 'deep', 'wake'])
        self.assertEqual(stages['segments'][0]['start'], int(T0.timestamp()))
        self.assertEqual(stages['segments'][0]['end'], int((T0 + timedelta(minutes=20)).timestamp()))
        samples = post.calls[1][1]['samples']
        self.assertEqual(samples, [
            {'timestamp': int((T0 + timedelta(minutes=1)).timestamp()), 'heartRate': 58.0},
            {'timestamp': int((T0 + timedelta(minutes=6)).timestamp()), 'heartRate': 56.5},
            {'timestamp': int((T0 + timedelta(minutes=11)).timestamp()), 'heartRate': 61.0},
        ])
        self.assertEqual(written, {'stages': 3, 'vitals': 3, 'breathing': 0, 'hrv': 0})
        self.assertIn('wrote 3 new stage segments, 3 new heart-rate', err)

    def test_dry_run_posts_nothing_but_reports_counts(self):
        write_export(self.export, [(0, 20, 'AsleepCore')], [(1, 58)])
        post, written, err = self.run_import(dry_run=True)
        self.assertEqual(post.calls, [])
        self.assertEqual(written, {'stages': 0, 'vitals': 0, 'breathing': 0, 'hrv': 0})
        self.assertIn('1 stage segments', err)
        self.assertIn('1 heart-rate samples', err)

    def test_days_window_drops_old_samples(self):
        write_export(self.export, [(0, 20, 'AsleepCore'), (-60 * 24 * 40, -60 * 24 * 40 + 30, 'AsleepDeep')],
                     [(1, 58), (-60 * 24 * 40, 70)])
        post, written, _ = self.run_import(days=30)
        self.assertEqual(len(post.calls[0][1]['segments']), 1)
        self.assertEqual(len(post.calls[1][1]['samples']), 1)
        _, written_all, _ = self.run_import(days=0)
        self.assertEqual(written_all, {'stages': 2, 'vitals': 2, 'breathing': 0, 'hrv': 0})

    def test_batches_at_the_api_limit(self):
        write_export(self.export, [], [(m, 60) for m in range(0, 4500)])
        post, written, _ = self.run_import()
        self.assertEqual([len(p['samples']) for _, p in post.calls], [2000, 2000, 500])
        self.assertEqual(written['vitals'], 4500)

    def test_stages_only_and_hr_only(self):
        write_export(self.export, [(0, 20, 'AsleepCore')], [(1, 58)])
        post, _, _ = self.run_import(hr=False)
        self.assertEqual([u.rsplit('/', 1)[1] for u, _ in post.calls], ['reference-stages'])
        post, _, _ = self.run_import(stages=False)
        self.assertEqual([u.rsplit('/', 1)[1] for u, _ in post.calls], ['reference-vitals'])

    def test_overlapping_segments_are_trimmed_so_the_api_accepts_the_batch(self):
        # Two sources' segments for the same minutes; the later start wins over
        # the overlap, including a fully contained segment, matching stage_lookup.
        write_export(self.export, [(0, 30, 'AsleepCore'), (20, 40, 'AsleepDeep'), (25, 28, 'AsleepREM')], [])
        post, _, _ = self.run_import()
        segs = post.calls[0][1]['segments']
        for a, b in zip(segs, segs[1:]):
            self.assertLessEqual(a['end'], b['start'])
        t = lambda m: int((T0 + timedelta(minutes=m)).timestamp())
        self.assertEqual([(s['start'], s['end'], s['stage']) for s in segs], [
            (t(0), t(20), 'light'), (t(20), t(25), 'deep'), (t(25), t(28), 'rem'), (t(28), t(40), 'deep'),
        ])

    def test_rejected_stage_batch_still_imports_heart_rate_and_exits_nonzero(self):
        write_export(self.export, [(0, 20, 'AsleepCore')], [(1, 58), (6, 60)])
        post = RejectingRecorder()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as cm:
                iw.run(self.export, '192.168.1.88', 'left', post=post, now=self.now)
        self.assertEqual([u.rsplit('/', 1)[1] for u, _ in post.calls], ['reference-stages', 'reference-vitals'])
        self.assertEqual(len(post.calls[1][1]['samples']), 2)
        self.assertIn('skipped a batch of 1 stage segments', err.getvalue())
        self.assertIn('1 stage batch(es) rejected', str(cm.exception))

    def test_drops_implausible_heart_rates(self):
        write_export(self.export, [], [(1, 58), (2, 5), (3, 400)])
        post, _, _ = self.run_import()
        self.assertEqual([s['heartRate'] for s in post.calls[0][1]['samples']], [58.0])

    def test_ignores_other_sources(self):
        write_export(self.export, [(0, 20, 'AsleepCore')], [(1, 58)])
        with open(self.export, 'a', encoding='utf-8') as f:
            pass
        post, _, _ = self.run_import(source_pattern='Nope')
        self.assertEqual(post.calls, [])

    def test_posts_breathing_rate_and_hrv_per_metric(self):
        write_export(self.export, [], [(1, 58)], rr=[(2, 14.5), (7, 15), (8, 2), (9, 90)], hrv=[(3, 48), (4, 0), (5, 900)])
        post, written, err = self.run_import()
        t = lambda m: int((T0 + timedelta(minutes=m)).timestamp())
        self.assertEqual([u.rsplit('/', 1)[1] for u, _ in post.calls],
                         ['reference-vitals', 'reference-samples', 'reference-samples'])
        self.assertEqual(post.calls[1][1], {'side': 'left', 'source': 'apple_watch', 'metric': 'breathing_rate',
                                            'samples': [{'timestamp': t(2), 'value': 14.5}, {'timestamp': t(7), 'value': 15.0}]})
        self.assertEqual(post.calls[2][1], {'side': 'left', 'source': 'apple_watch', 'metric': 'hrv_sdnn',
                                            'samples': [{'timestamp': t(3), 'value': 48.0}]})
        self.assertEqual(written, {'stages': 0, 'vitals': 1, 'breathing': 2, 'hrv': 1})
        self.assertIn('2 breathing-rate and 1 HRV samples', err)
        # --hr-only and --stages-only leave breathing rate and HRV out.
        post, _, _ = self.run_import(stages=False, extra=False)
        self.assertEqual([u.rsplit('/', 1)[1] for u, _ in post.calls], ['reference-vitals'])

    def test_converts_breathing_and_hrv_units_and_skips_unknown_ones(self):
        extra = (quantity_record('RespiratoryRate', T0 + timedelta(minutes=2), 0.25, 'count/s')
                 + quantity_record('RespiratoryRate', T0 + timedelta(minutes=3), 15, 'count/h')
                 + quantity_record('HeartRateVariabilitySDNN', T0 + timedelta(minutes=4), 0.042, 's')
                 + quantity_record('HeartRateVariabilitySDNN', T0 + timedelta(minutes=5), 42, 'us'))
        write_export(self.export, [], [(1, 58)], extra=extra)
        post, written, _ = self.run_import()
        t = lambda m: int((T0 + timedelta(minutes=m)).timestamp())
        self.assertEqual(post.calls[1][1]['samples'], [{'timestamp': t(2), 'value': 15.0}])
        self.assertEqual(post.calls[2][1]['samples'], [{'timestamp': t(4), 'value': 42.0}])
        self.assertEqual(written, {'stages': 0, 'vitals': 1, 'breathing': 1, 'hrv': 1})

    def test_never_imports_records_sleepypod_wrote_to_health(self):
        at = T0 + timedelta(minutes=1)
        pod = ''.join([
            hr_record(at, 99, source='sleepypod'),
            quantity_record('RespiratoryRate', at, 30, 'count/min', source='sleepypod'),
            quantity_record('HeartRateVariabilitySDNN', at, 99, 'ms', source='sleepypod design'),
            sleep_record(at, at + timedelta(minutes=30), 'AsleepDeep', source='sleepypod'),
            # Even when the source pattern would match it.
            hr_record(at, 98, source='sleepypod Watch'),
        ])
        write_export(self.export, [(0, 20, 'AsleepCore')], [(2, 58)], rr=[(2, 14)], hrv=[(2, 40)], extra=pod)
        post, written, _ = self.run_import()
        values = [s.get('heartRate', s.get('value')) for _, p in post.calls for s in p.get('samples', [])]
        self.assertEqual(values, [58.0, 14.0, 40.0])
        self.assertEqual([s['stage'] for s in post.calls[0][1]['segments']], ['light'])
        _, written_any, _ = self.run_import(source_pattern='.')
        self.assertEqual(written_any, {'stages': 1, 'vitals': 1, 'breathing': 1, 'hrv': 1})

    def test_base_url_forms(self):
        self.assertEqual(iw.base_url('192.168.1.88'), 'http://192.168.1.88:3000')
        self.assertEqual(iw.base_url('pod.local:8080'), 'http://pod.local:8080')
        self.assertEqual(iw.base_url('https://pod.example/'), 'https://pod.example')

    def test_main_requires_an_existing_export(self):
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                iw.main([os.path.join(self.tmp.name, 'missing.xml'), '--pod', 'x', '--side', 'left'])



class WatchZipImportTest(unittest.TestCase):
    def test_zip_import_and_partial_conflicts_are_reported(self):
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            xml = os.path.join(directory, 'export.xml')
            write_export(xml, [(0, 10, 'AsleepCore')], [(5, 62)])
            archive = os.path.join(directory, 'export.zip')
            with zipfile.ZipFile(archive, 'w') as output:
                output.write(xml, 'apple_health_export/export.xml')
            result = iw.run(archive, 'pod', 'left', days=0, report=True, post=RejectingRecorder())
            self.assertEqual(result['vitals'], 1)
            self.assertEqual(result['rejectedStageBatches'], 1)
            self.assertEqual(result['matchedStages'], 1)

    def test_zip_does_not_extract_arbitrary_paths(self):
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            archive = os.path.join(directory, 'export.zip')
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('../export.xml', '<HealthData/>')
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                iw.run(archive, 'pod', 'left', report=True, post=Recorder())


if __name__ == '__main__':
    unittest.main()
