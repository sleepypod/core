"""Synthetic regressions for candidate uploads and explicit Watch label gaps."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


train = load('train_personal', 'scripts/train-personal-models.py')
models = load('personal', 'docs/research/sleep-stage-calibration/personal-models.py')


class CandidateTests(unittest.TestCase):
    def test_upload_routes_and_explicit_selection(self):
        for select, activate in [(False, False), (True, False), (False, True)]:
            with self.subTest(select=select, activate=activate), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'model.json'
                path.write_text('{"version":"test"}')
                calls = []

                def response(request, timeout):
                    calls.append((request.method, request.full_url, json.loads(request.data)))
                    return io.StringIO('{"id":7}')

                with patch.object(train.urllib.request, 'urlopen', side_effect=response), patch('sys.stdout', new_callable=io.StringIO) as output:
                    train.upload('pod', 'left', path, select=select, activate=activate)
                self.assertEqual(calls[0], ('POST', 'http://pod:3000/api/sleep-stages/models', {'side': 'left', 'model': {'version': 'test'}}))
                self.assertEqual(calls[1], ('POST', 'http://pod:3000/api/sleep-stages/model/preview', {'side': 'left', 'nights': 14, 'model': {'version': 'test'}}))
                self.assertIn('in-sample', output.getvalue())
                self.assertEqual(len(calls), 3 if select or activate else 2)
                if select or activate:
                    self.assertEqual(calls[2], ('PUT', 'http://pod:3000/api/sleep-stages/models/selected', {'side': 'left', 'id': 7, 'active': activate}))

    def test_failed_preview_never_selects(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'model.json'
            path.write_text('{}')
            with patch.object(train, 'request_json', side_effect=[{'id': 7}, RuntimeError('offline')]) as request:
                with self.assertRaises(RuntimeError):
                    train.upload('pod', 'left', path, activate=True)
                self.assertEqual(request.call_count, 2)

    def test_conflicting_flags_refused_before_any_work(self):
        for flags in [['--no-upload', '--select'], ['--no-upload', '--activate'], ['--select', '--activate']]:
            with patch('sys.argv', ['train', '--pod', 'pod'] + flags), patch.object(train, 'snapshot') as snapshot:
                with self.assertRaises(SystemExit) as error:
                    train.main()
                self.assertEqual(error.exception.code, 2)
                snapshot.assert_not_called()


class LabelTests(unittest.TestCase):
    def test_explicit_gap_not_bridged_by_same_stage(self):
        rows = [{'ts': t, 'watch_stage': stage} for t, stage in [(0, 'light'), (60, ''), (120, 'light'), (180, 'light')]]
        epochs = [{'start': mid - 150} for mid in [30, 60, 90, 120, 150, 210, 240]]
        self.assertEqual([e['start'] + 150 for e, _ in models.label(epochs, rows)], [30, 120, 150, 210])

    def test_missing_sample_still_bridges_and_stage_change_does_not(self):
        epochs = [{'start': -60}]
        self.assertEqual(len(models.label(epochs, [{'ts': 0, 'watch_stage': 'light'}, {'ts': 120, 'watch_stage': 'light'}])), 1)
        self.assertEqual(models.label(epochs, [{'ts': 0, 'watch_stage': 'light'}, {'ts': 120, 'watch_stage': 'deep'}]), [])

class CommandTests(unittest.TestCase):
    def test_command_defaults_candidate_and_propagates_explicit_flags(self):
        from types import SimpleNamespace
        for flag in [[], ['--select'], ['--activate'], ['--no-upload']]:
            with tempfile.TemporaryDirectory() as tmp:
                args = ['train', '--pod', 'pod', '--work', tmp, '--snapshot', 'existing.db'] + flag
                with patch('sys.argv', args), patch.object(train, 'run', return_value=SimpleNamespace(stdout='logistic: pooled kappa 0.2\nforest: pooled kappa 0.3\n')), patch.object(train, 'upload') as upload, patch('sys.stdout', new_callable=io.StringIO):
                    train.main()
                if flag == ['--no-upload']:
                    upload.assert_not_called()
                else:
                    upload.assert_called_once_with('pod', 'left', Path(tmp) / 'contract-B/personal-forest.json', select=flag == ['--select'], activate=flag == ['--activate'])

    def test_snapshot_cleanup_and_no_scored_model(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'biometrics.db'; db.write_text('synthetic')
            with patch('sys.argv', ['train', '--pod', 'pod', '--work', tmp]), patch.object(train, 'snapshot', return_value=db), patch.object(train, 'run', return_value=SimpleNamespace(stdout='no models')), patch('sys.stdout', new_callable=io.StringIO):
                with self.assertRaisesRegex(SystemExit, 'no model scored'):
                    train.main()
            self.assertFalse(db.exists())

    def test_http_error_reports_endpoint_without_selecting(self):
        error = train.urllib.error.HTTPError('http://pod', 400, 'bad', {}, io.BytesIO(b'invalid model'))
        with patch.object(train.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaisesRegex(SystemExit, 'pod refused models \\(400\\): invalid model'):
                train.request_json('pod', 'models', {})

    def test_snapshot_transport_and_subprocess_wrapper(self):
        with patch.object(train, 'run') as run:
            self.assertEqual(train.snapshot('pod', Path('/tmp/synthetic')), Path('/tmp/synthetic/biometrics.db'))
            self.assertEqual(run.call_count, 3)
            self.assertIn('src.backup(dst)', run.call_args_list[0].kwargs['input'])
        with patch.object(train.subprocess, 'run') as run:
            train.run([Path('/tmp/synthetic-command'), 'argument'])
            run.assert_called_once_with(['/tmp/synthetic-command', 'argument'], check=True, text=True)
