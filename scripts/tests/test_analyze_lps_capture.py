"""Tests for capture interpretation: sentinel timing, gaps and invalid inputs."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("analyze_lps", ROOT / "scripts/analyze-lps-capture.py")
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)
FIXTURE = ROOT / "src/streaming/tests/fixtures/lps-field-excerpt.jsonl"


class CaptureAnalysisTest(unittest.TestCase):
    def setUp(self):
        self.originals = [json.loads(line) for line in FIXTURE.read_text().splitlines()]
        self.records = analyzer.read_capture(FIXTURE)

    def test_sentinels_keep_time_and_do_not_pollute_statistics(self):
        for record, start in zip(self.records, (20, 100)):
            for channel in analyzer.CHANNELS:
                self.assertEqual(record["invalid"][channel], list(range(start, start + 10)))
                values = record["channels"][channel]
                self.assertEqual(len(values), 200)
                self.assertTrue(all(math.isnan(v) for v in values[start:start + 10]))
                self.assertLess(analyzer.frame_stats(values)[0], 0x7FFFFFFF)
                times, plotted = analyzer.sample_series([record], "lps", channel, record["ts"])
                self.assertEqual(times[start + 10], (start + 10) / 200)
                self.assertEqual(plotted[start + 10], values[start + 10])
        report = analyzer.summarize(self.records, "test")
        self.assertEqual(len(report["sentinel_bursts"]), 8)
        json.dumps(report, allow_nan=False)
        self.assertEqual(analyzer.frame_stats([math.nan] * 200), (None, None))

    def test_missing_frames_are_plot_gaps_not_compressed_time(self):
        times, values = analyzer.sample_series(self.records, "lps", "left1", self.records[0]["ts"])
        self.assertTrue(math.isnan(values[200]))
        self.assertEqual(times[201], 46)

    def test_bad_buffers_fail_with_line_number(self):
        record = copy.deepcopy(self.originals[0])
        record["frame"]["pres"]["left1"]["data"].pop()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.jsonl"
            path.write_text(json.dumps(record))
            with self.assertRaisesRegex(ValueError, "line 1: left1"):
                analyzer.read_capture(path)

    def test_duplicate_timestamps_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "duplicate.jsonl"
            path.write_text((json.dumps(self.originals[0]) + "\n") * 2)
            with self.assertRaisesRegex(ValueError, "strictly increasing"):
                analyzer.read_capture(path)

    def test_piezo_uses_its_own_frequency_and_timestamp(self):
        record = analyzer.decode_record(dict(phase="empty", frame=dict(
            type="piezo-dual", ts=100, freq=500, left1=[-12] * 500, right1=[34] * 500)))
        times, values = analyzer.sample_series([record], "piezo-dual", "left1", 99)
        self.assertEqual(times[1], 1.002)
        self.assertEqual(values, [-12] * 500)
        self.assertNotIn("left2", record["channels"])

    def test_piezo_sentinel_is_flagged_without_changing_neighbors(self):
        samples = [42] * 500
        samples[490] = 0x7FFFFFFF
        record = analyzer.decode_record(dict(phase="left", frame=dict(
            type="piezo-dual", ts=100, freq=500, left1=samples, right1=[0] * 500)))
        self.assertEqual(record["invalid"]["left1"], [490])
        self.assertTrue(math.isnan(record["channels"]["left1"][490]))
        self.assertEqual(record["channels"]["left1"][491], 42)
        self.assertEqual(analyzer.frame_stats(record["channels"]["left1"]), (42, 0))
        event = analyzer.summarize([record], "test")["sentinel_bursts"][0]
        self.assertEqual(event["type"], "piezo-dual")
        self.assertEqual(event["seconds_in_frame"], [0.98])


if __name__ == "__main__":
    unittest.main()
