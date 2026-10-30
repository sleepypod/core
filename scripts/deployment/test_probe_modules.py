import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('probe_modules', Path(__file__).with_name('probe_modules.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ModuleProbeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        for name in probe.MODULE_IMPORTS:
            folder = self.root / name
            folder.mkdir()
            (folder / 'pyproject.toml').write_text('project')
            (folder / 'uv.lock').write_text('locked dependencies')

    def tearDown(self):
        self.directory.cleanup()

    def test_uses_venv_isolation_real_imports_and_lock_identity(self):
        response = subprocess.CompletedProcess([], 0, json.dumps({'imports': 'ok', 'packages': {'heartpy': '1.2.7'}}), '')
        with patch.object(probe.subprocess, 'run', return_value=response) as run:
            result = probe.probe_modules(self.root, ['piezo-processor'])
        self.assertTrue(result['ok'])
        self.assertFalse(result['servicesStarted'])
        self.assertEqual(run.call_args.args[0][:3], [str(self.root / 'piezo-processor/.venv/bin/python'), '-I', '-c'])
        self.assertIn('heartpy', run.call_args.args[0][4:])
        self.assertEqual(run.call_args.kwargs['timeout'], 45)
        self.assertEqual(len(result['modules']['piezo-processor']['files']['uv.lock']), 64)

    def test_missing_dependency_is_failure_and_does_not_hide_other_modules(self):
        responses = [subprocess.CompletedProcess([], 1, '', 'No module named pkg_resources'),
                     subprocess.CompletedProcess([], 0, '{"imports":"ok","packages":{}}', '')]
        with patch.object(probe.subprocess, 'run', side_effect=responses):
            result = probe.probe_modules(self.root, ['piezo-processor', 'cover-buttons'])
        self.assertFalse(result['ok'])
        self.assertIn('pkg_resources', result['modules']['piezo-processor']['error'])
        self.assertTrue(result['modules']['cover-buttons']['ok'])

    def test_malformed_response_timeout_and_absent_interpreter_fail_closed(self):
        failures = [subprocess.CompletedProcess([], 0, 'not json', ''),
                    subprocess.TimeoutExpired('python', 45), FileNotFoundError('missing interpreter')]
        for failure in failures:
            with self.subTest(failure=failure):
                kwargs = {'side_effect': failure} if isinstance(failure, Exception) else {'return_value': failure}
                with patch.object(probe.subprocess, 'run', **kwargs):
                    self.assertFalse(probe.probe_modules(self.root, ['cover-buttons'])['ok'])


if __name__ == '__main__':
    unittest.main()
