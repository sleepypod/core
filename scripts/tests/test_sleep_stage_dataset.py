"""Tests for scripts/sleep-stage-dataset.py using small synthetic fixtures.

Run: python3 -m unittest scripts/tests/test_sleep_stage_dataset.py
 (or: uv run --with pytest --no-project pytest scripts/tests/test_sleep_stage_dataset.py)
"""

import contextlib
import csv
import importlib.util
import io
import os
import sqlite3
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    'sleep_stage_dataset', os.path.join(HERE, '..', 'sleep-stage-dataset.py'))
ds = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ds)

TZ = timezone(timedelta(hours=-7))
# Night of 2026-10-08: Watch coverage 02:00-02:30 local on 10-09.
T0 = datetime(2026, 10, 9, 2, 0, tzinfo=TZ)
WATCH = "Jane&#8217;s Apple Watch"


def hk_time(dt):
    return dt.strftime('%Y-%m-%d %H:%M:%S %z')


def sleep_record(start, end, value, source=WATCH):
    return (f' <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="{source}" '
            f'sourceVersion="11.0" creationDate="{hk_time(end)}" startDate="{hk_time(start)}" '
            f'endDate="{hk_time(end)}" value="HKCategoryValueSleepAnalysis{value}">\n'
            f'  <MetadataEntry key="HKTimeZone" value="America/Los_Angeles"/>\n </Record>\n')


def hr_record(at, bpm, source=WATCH):
    return (f' <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="{source}" '
            f'unit="count/min" startDate="{hk_time(at)}" endDate="{hk_time(at)}" value="{bpm}"/>\n')


# Segments: 02:00-02:10 light, 02:10-02:20 deep, 02:20-02:30 rem
SEGMENTS = [(0, 10, 'AsleepCore'), (10, 20, 'AsleepDeep'), (20, 30, 'AsleepREM')]


def write_export(path, hr_offset=0.0, with_hr=True):
    parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n']
    for a, b, v in SEGMENTS:
        parts.append(sleep_record(T0 + timedelta(minutes=a), T0 + timedelta(minutes=b), v))
    # Noise that must be ignored: other source, InBed, non-Watch HR.
    parts.append(sleep_record(T0, T0 + timedelta(minutes=30), 'AsleepDeep', source='sleepypod'))
    parts.append(sleep_record(T0, T0 + timedelta(minutes=30), 'InBed'))
    parts.append(hr_record(T0, 150, source='sleepypod'))
    if with_hr:
        for m in range(30):
            parts.append(hr_record(T0 + timedelta(minutes=m, seconds=20), pod_hr(m) + hr_offset))
    parts.append('</HealthData>\n')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(''.join(parts))


def pod_hr(minute):
    return 60.0 + (minute % 3)


def make_db(path, side='left', minutes=range(-5, 35)):
    conn = sqlite3.connect(path)
    conn.executescript('''
        CREATE TABLE vitals (id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT, timestamp INTEGER,
                             heart_rate REAL, hrv REAL, breathing_rate REAL);
        CREATE TABLE movement (id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT, timestamp INTEGER,
                               total_movement INTEGER);
        CREATE TABLE vitals_quality (id INTEGER PRIMARY KEY AUTOINCREMENT, vitals_id INTEGER,
                                     side TEXT, timestamp INTEGER, quality_score REAL);
    ''')
    base = int(T0.timestamp())
    for m in minutes:
        ts = base + m * 60 + 5
        cur = conn.execute('INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES (?,?,?,?,?)',
                           (side, ts, pod_hr(m), 50.0 + m, 14.0))
        conn.execute('INSERT INTO vitals_quality (vitals_id, side, timestamp, quality_score) VALUES (?,?,?,?)',
                     (cur.lastrowid, side, ts, 0.5))
        conn.execute('INSERT INTO movement (side, timestamp, total_movement) VALUES (?,?,?)',
                     (side, base + m * 60 + 42, m * 10))
    conn.commit()
    return conn


def add_reference_stages(conn, side='left'):
    conn.execute('CREATE TABLE reference_stages (id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT, '
                 'source TEXT, start INTEGER, "end" INTEGER, stage TEXT, created_at INTEGER)')
    stage = {'AsleepCore': 'light', 'AsleepDeep': 'deep', 'AsleepREM': 'rem'}
    for a, b, v in SEGMENTS:
        conn.execute('INSERT INTO reference_stages (side, source, start, "end", stage, created_at) VALUES (?,?,?,?,?,0)',
                     (side, 'apple_watch', int((T0 + timedelta(minutes=a)).timestamp()),
                      int((T0 + timedelta(minutes=b)).timestamp()), stage[v]))
    conn.commit()


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.export = os.path.join(self.tmp.name, 'export.xml')
        self.db_path = os.path.join(self.tmp.name, 'biometrics.db')

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            ds.main(list(argv))
        return out.getvalue(), err.getvalue()


class ParseExportTest(Fixture):
    def test_keeps_only_watch_stage_samples_and_hr(self):
        write_export(self.export)
        segments, hr = ds.parse_export(self.export)
        self.assertEqual([s for _, _, s in segments], ['light', 'deep', 'rem'])
        self.assertEqual(len(hr), 30)
        self.assertTrue(all(55 <= v <= 65 for _, v in hr))

    def test_accepts_export_directory(self):
        write_export(self.export)
        segments, _ = ds.parse_export(self.tmp.name)
        self.assertEqual(len(segments), 3)

    def test_source_regex_selects_other_source(self):
        write_export(self.export)
        segments, hr = ds.parse_export(self.export, source_pattern='^sleepypod$')
        self.assertEqual([s for _, _, s in segments], ['deep'])
        self.assertEqual(hr, [(int(T0.timestamp()), 150.0)])


class JoinTest(Fixture):
    def test_rows_per_minute_with_labels_movement_quality_and_watch_hr(self):
        write_export(self.export)
        make_db(self.db_path).close()
        out, _ = self.run_main(self.export, self.db_path, '--side', 'left')
        rows = list(csv.DictReader(io.StringIO(out)))
        self.assertEqual(list(rows[0].keys()), list(ds.CSV_FIELDS))
        # Window = 02:00-02:30 padded 10 min = 01:50-02:40 → minutes -5..34 all present.
        self.assertEqual(len(rows), 40)
        self.assertEqual({r['night'] for r in rows}, {'2026-10-08'})
        by_min = {(int(r['ts']) - int(T0.timestamp())) // 60: r for r in rows}
        self.assertEqual(by_min[-1]['watch_stage'], '')
        self.assertEqual(by_min[0]['watch_stage'], 'light')
        self.assertEqual(by_min[9]['watch_stage'], 'light')
        self.assertEqual(by_min[10]['watch_stage'], 'deep')
        self.assertEqual(by_min[25]['watch_stage'], 'rem')
        self.assertEqual(by_min[30]['watch_stage'], '')
        # Vitals at :05; previous minute's movement row at :42 (23 s away) beats this minute's (37 s).
        self.assertEqual(by_min[3]['movement'], '20')
        self.assertEqual(by_min[3]['hr_quality'], '0.5')
        # Watch HR at :20 of each minute 0..29 is 15 s from the vitals sample.
        self.assertEqual(by_min[4]['watch_hr'], by_min[4]['hr'])
        self.assertEqual(by_min[-2]['watch_hr'], '')
        self.assertEqual(by_min[32]['watch_hr'], '')

    def test_nearest_respects_tolerance_and_prefers_earlier_on_tie(self):
        times, vals = [100, 200], ['a', 'b']
        self.assertEqual(ds.nearest(times, vals, 150), 'a')
        self.assertEqual(ds.nearest(times, vals, 190), 'b')
        self.assertIsNone(ds.nearest(times, vals, 300))
        self.assertIsNone(ds.nearest([], [], 5))

    def test_only_requested_side_is_read(self):
        write_export(self.export)
        make_db(self.db_path, side='right').close()
        out, err = self.run_main(self.export, self.db_path, '--side', 'left')
        self.assertEqual(out.strip(), ','.join(ds.CSV_FIELDS))
        self.assertIn('no left vitals', err)

    def test_from_db_matches_export_rows(self):
        # reference_stages has no tz; night labels use local time, so pin it to the export's zone.
        old_tz = os.environ.get('TZ')
        os.environ['TZ'] = 'America/Los_Angeles'
        time.tzset()
        self.addCleanup(self._restore_tz, old_tz)
        write_export(self.export, with_hr=False)
        conn = make_db(self.db_path)
        add_reference_stages(conn)
        conn.close()
        from_export, _ = self.run_main(self.export, self.db_path)
        from_db, _ = self.run_main('--from-db', self.db_path)
        self.assertEqual(from_db, from_export)
        self.assertEqual(len(from_db.strip().splitlines()), 41)

    @staticmethod
    def _restore_tz(old_tz):
        if old_tz is None:
            os.environ.pop('TZ', None)
        else:
            os.environ['TZ'] = old_tz
        time.tzset()

    def test_out_matching_an_input_is_refused(self):
        write_export(self.export)
        make_db(self.db_path).close()
        size = os.path.getsize(self.db_path)
        for target in (self.db_path, self.export):
            with self.assertRaises(SystemExit):
                self.run_main(self.tmp.name, self.db_path, '--out', target)
        self.assertEqual(os.path.getsize(self.db_path), size)

    def test_from_db_without_table_exits_with_message(self):
        make_db(self.db_path).close()
        with self.assertRaises(SystemExit) as cm:
            self.run_main('--from-db', self.db_path)
        self.assertIn('reference_stages', str(cm.exception.code))


class LabelAndWindowTest(unittest.TestCase):
    def test_sample_before_mid_minute_transition_keeps_earlier_stage(self):
        t = T0 + timedelta(minutes=1, seconds=30)
        segs = [(T0, t, 'light'), (t, T0 + timedelta(minutes=5), 'deep')]
        stage_at = ds.stage_lookup(segs)
        base = int(T0.timestamp())
        self.assertEqual(stage_at(base + 70), 'light')
        self.assertEqual(stage_at(base + 90), 'deep')
        self.assertIsNone(stage_at(base + 300))
        self.assertIsNone(stage_at(base - 1))

    def test_overlap_resolution_ignores_input_order(self):
        segs = [(T0, T0 + timedelta(minutes=30), 'light'),
                (T0 + timedelta(minutes=10), T0 + timedelta(minutes=12), 'rem')]
        base = int(T0.timestamp())
        for order in (segs, segs[::-1]):
            stage_at = ds.stage_lookup(order)
            self.assertEqual([stage_at(base + m * 60) for m in (5, 11, 20)], ['light', 'rem', 'light'])

    def test_sleep_spanning_noon_belongs_to_one_night(self):
        noon = datetime(2026, 10, 9, 12, 0, tzinfo=TZ)
        segs = [(noon - timedelta(minutes=10), noon + timedelta(minutes=10), 'light'),
                (noon + timedelta(minutes=10), noon + timedelta(minutes=30), 'deep')]
        windows = ds.group_nights(segs, 10)
        self.assertEqual(list(windows), ['2026-10-08'])
        start, end = windows['2026-10-08']
        self.assertEqual((start, end), (int(noon.timestamp()) - 20 * 60, int(noon.timestamp()) + 40 * 60))


class SideMismatchGuardTest(Fixture):
    def test_night_within_threshold_is_kept(self):
        write_export(self.export, hr_offset=3.0)
        make_db(self.db_path).close()
        out, err = self.run_main(self.export, self.db_path)
        self.assertEqual(len(out.strip().splitlines()), 41)
        self.assertNotIn('MAD', err)

    def test_night_over_threshold_warns_and_is_skipped(self):
        write_export(self.export, hr_offset=12.0)
        make_db(self.db_path).close()
        out, err = self.run_main(self.export, self.db_path)
        self.assertEqual(out.strip(), ','.join(ds.CSV_FIELDS))
        self.assertIn('2026-10-08', err)
        self.assertRegex(err, r'HR MAD 12\.\d bpm > 8')

    def test_threshold_is_configurable(self):
        write_export(self.export, hr_offset=12.0)
        make_db(self.db_path).close()
        out, _ = self.run_main(self.export, self.db_path, '--max-hr-mad', '15')
        self.assertEqual(len(out.strip().splitlines()), 41)

    def test_too_few_hr_matches_warns_but_keeps(self):
        write_export(self.export, with_hr=False)
        make_db(self.db_path).close()
        out, err = self.run_main(self.export, self.db_path)
        self.assertEqual(len(out.strip().splitlines()), 41)
        self.assertIn('guard not applied', err)

    def test_hr_mad(self):
        rows = [{'hr': 60.0, 'watch_hr': 70.0}, {'hr': 60.0, 'watch_hr': 58.0},
                {'hr': None, 'watch_hr': 90.0}, {'hr': 60.0, 'watch_hr': None}]
        self.assertEqual(ds.hr_mad(rows), (6.0, 2))


def vit(minute, hr, hrv=None, br=None):
    return (1_790_000_000 + minute * 60, hr, hrv, br)


def mov(minute, total):
    return (1_790_000_000 + minute * 60, total)


class ClassifierPortTest(unittest.TestCase):
    """Mirrors src/lib/tests/sleep-stages.test.ts for classifySleepStages."""

    def stages(self, vitals, movement, cq=0.0):
        return [s for _, s in ds.classify_sleep_stages(vitals, movement, cq)]

    def test_empty(self):
        self.assertEqual(ds.classify_sleep_stages([], []), [])

    def test_high_movement_is_wake(self):
        self.assertEqual(self.stages([vit(0, 70, 40, 15)], [mov(0, 500)]), ['wake'])

    def test_movement_only_mode_never_emits_deep_or_rem(self):
        v = [vit(0, 80, 35, 15), vit(5, 65, 40, 15), vit(10, 63, 50, 14), vit(15, 75, 38, 15), vit(20, 72, 36, 15)]
        self.assertEqual(self.stages(v, [], 0.0), ['light'] * 5)

    def test_low_hr_ratio_is_deep(self):
        v = [vit(0, 80, 35, 15), vit(5, 65, 40, 15), vit(10, 63, 50, 14), vit(15, 75, 38, 15), vit(20, 72, 36, 15)]
        self.assertEqual(self.stages(v, [], 1.0)[2], 'deep')

    def test_elevated_hr_low_hrv_low_movement_is_rem(self):
        v = [vit(0, 55, 20, 14), vit(5, 62, 20, 14), vit(10, 65, 20, 14), vit(15, 68, 20, 14), vit(20, 78, 18, 16)]
        self.assertEqual(self.stages(v, [mov(20, 10)], 1.0)[4], 'rem')

    def test_missing_movement_does_not_produce_rem(self):
        v = [vit(m, 70, 20, 14) for m in (0, 5, 10, 15, 20)]
        self.assertNotIn('rem', self.stages(v, [], 1.0))

    def test_aba_smoothing(self):
        v = [vit(0, 60, 40, 14), vit(5, 60, 40, 14), vit(10, 60, 40, 14)]
        self.assertEqual(self.stages(v, [mov(0, 10), mov(5, 300), mov(10, 10)]), ['light'] * 3)

    def test_transition_wake_to_deep_passes_through_light(self):
        # Epoch 0 wake by movement; epoch 1 deep by HR ratio; HR window kept varied so
        # the outlier filter keeps it.
        v = [vit(0, 70, 40, 14), vit(5, 58, 40, 14), vit(10, 66, 40, 14), vit(15, 72, 40, 14)]
        raw = [ds.classify_epoch(h, x, m, 66.5, 1.0) for (_, h, x, _), m in zip(v, [300, None, None, None])]
        self.assertEqual(raw[:2], ['wake', 'deep'])
        self.assertEqual(self.stages(v, [mov(0, 300)], 1.0)[1], 'light')

    def test_outlier_filter_hard_limits_and_median(self):
        out = ds.filter_outliers([vit(0, 40, 0.5, 30), vit(1, 60, 50, 14), vit(2, 61, 50, 14),
                                  vit(3, 100, 50, 14), vit(4, 60, 50, 14), vit(5, 61, 50, 14)])
        self.assertEqual(out[0][1:], (None, None, None))
        self.assertIsNone(out[3][1])  # 100 vs window median 61, std ~15.6 → > 2σ
        self.assertEqual(out[1][1], 60)

    def test_single_sample_window_keeps_hr(self):
        v = [vit(0, None), vit(5, None), vit(10, 68, 40, 14), vit(15, None), vit(20, None)]
        self.assertEqual(ds.filter_outliers(v)[2][1], 68)

    def test_movement_uses_five_minute_buckets_last_row_wins(self):
        # Vitals at minute 1 rounds to bucket 0; movement rows at minutes 0 and 2 share it.
        self.assertEqual(self.stages([vit(1, 60)], [mov(0, 10), mov(2, 300)]), ['wake'])
        self.assertEqual(self.stages([vit(1, 60)], [mov(0, 300), mov(2, 10)]), ['light'])


class SummaryTest(Fixture):
    def test_summary_reports_agreement_per_night(self):
        write_export(self.export)
        make_db(self.db_path).close()
        out, _ = self.run_main(self.export, self.db_path, '--summary')
        line = next(ln for ln in out.splitlines() if ln.startswith('2026-10-08'))
        _night, side, rows, labeled, _mad, deployed, _ios, light = line.split()
        self.assertEqual((side, rows, labeled), ('left', '40', '30'))
        # 10 light / 10 deep / 10 rem Watch minutes. Movement-only mode only ever says
        # light or wake, so both it and always-light score the 10 light minutes.
        self.assertEqual(light, '33%')
        self.assertEqual(deployed, '33%')

    def test_agreement_ignores_unlabeled_rows(self):
        rows = [{'ts': 1, 'watch_stage': 'light'}, {'ts': 2, 'watch_stage': None}, {'ts': 3, 'watch_stage': 'deep'}]
        self.assertEqual(ds.agreement(rows, {1: 'light', 2: 'deep', 3: 'light'}), 50.0)
        self.assertIsNone(ds.agreement([{'ts': 1, 'watch_stage': None}], {}))


if __name__ == '__main__':
    unittest.main()
