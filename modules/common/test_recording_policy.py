import json
import logging
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from common import recording_policy as policy


class RecordingPolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'recording-policy.json'
        self.env = patch.dict('os.environ', {'SP_RECORDING_POLICY_FILE': str(self.path)})
        self.env.start()
        self.addCleanup(self.env.stop)
        policy._cache_path = None

    def write(self, **settings):
        self.path.write_text(json.dumps(settings))
        policy._cache_path = None

    def test_quiet_by_default_without_creating_file(self):
        self.assertEqual(policy.logging_mode(), 'quiet')
        self.assertFalse(self.path.exists())

    def test_expiry_restores_off_without_writing(self):
        self.write(loggingMode='off', debugUntil=2000)
        with patch('time.time', return_value=1):
            self.assertEqual(policy.logging_mode(), 'debug')
        with patch('time.time', return_value=2):
            self.assertEqual(policy.logging_mode(), 'off')
        self.assertEqual(json.loads(self.path.read_text())['debugUntil'], 2000)

    def test_filter_discards_off_and_quiet_info_but_keeps_quiet_errors(self):
        filt = policy.RecordingFilter()
        info = logging.LogRecord('test', logging.INFO, '', 0, 'info', (), None)
        error = logging.LogRecord('test', logging.ERROR, '', 0, 'error', (), None)
        self.write(loggingMode='quiet')
        self.assertFalse(filt.filter(info))
        self.assertTrue(filt.filter(error))
        self.write(loggingMode='off')
        self.assertFalse(filt.filter(error))

    def test_corrupt_policy_falls_back_to_warnings(self):
        self.path.write_text('{broken')
        self.assertEqual(policy.logging_mode(), 'quiet')

    def test_reload_after_one_second(self):
        with patch('time.monotonic', return_value=0):
            self.assertEqual(policy.logging_mode(), 'quiet')
        self.path.write_text(json.dumps({'loggingMode': 'off'}))
        with patch('time.monotonic', return_value=0.5):
            self.assertEqual(policy.logging_mode(), 'quiet')
        with patch('time.monotonic', return_value=1):
            self.assertEqual(policy.logging_mode(), 'off')
