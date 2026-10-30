"""Real backup/import files with simulated systemd; never contact a Pod or actuator."""
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import handoff
import activation_checks
import prepare_data
import service_plan
from test_handoff import CONFIG


BACKUP_SCRIPT = '''import hashlib,json,sys,tarfile
from pathlib import Path
source=Path(sys.argv[sys.argv.index('--data')+1])
output=Path(sys.argv[sys.argv.index('--output')+1]); output.mkdir(mode=0o700)
manifest={'format':'free-sleep-migration/1','files':{},'archives':{}}
for category in ('data','private'):
 archive_path=output/(category+'.tar.gz')
 with tarfile.open(archive_path,'w:gz') as archive:
  if category=='data':
   for path in source.rglob('*'):
    if path.is_file():
     name='data/'+str(path.relative_to(source)); archive.add(path,arcname=name)
     manifest['files'][name]=hashlib.sha256(path.read_bytes()).hexdigest()
 manifest['archives'][archive_path.name]=hashlib.sha256(archive_path.read_bytes()).hexdigest()
(output/'manifest.json').write_text(json.dumps(manifest))
'''


class QuiescedImportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.directory = self.root / 'plan'
        self.plan = service_plan.prepare(CONFIG, self.directory)
        self.legacy = self.root / 'retained-data'
        self.legacy.mkdir()
        self.output = self.root / 'new-preparation'
        self.backup_tool = self.root / 'reviewed-backup.py'
        self.backup_tool.write_text(BACKUP_SCRIPT)
        self.backup_hash = prepare_data.digest(self.backup_tool)
        self.unit_directory = self.root / 'units'
        self.unit_directory.mkdir()
        self.states, self.calls = {}, []
        self.stop_failure = self.start_failure = False
        for name in service_plan.LEGACY_UNITS:
            path = self.unit_directory / name
            path.write_text('retained service\n')
            self.states[name] = {'LoadState': 'loaded', 'ActiveState': 'active', 'MainPID': '100',
                                 'UnitFileState': 'enabled', 'KillMode': 'control-group',
                                 'FragmentPath': str(path), 'DropInPaths': ''}
        for name, contents in service_plan.render(CONFIG).items():
            (self.unit_directory / name).write_text(contents)
            self.states[name] = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'MainPID': '0',
                                 'UnitFileState': 'disabled', 'FragmentPath': str(self.unit_directory / name),
                                 'DropInPaths': ''}
        self.journal = {'format': 'sleepypod-handoff/1', 'phase': 'installed_not_started',
                        'unitHashes': self.plan['units'], 'legacy': {
                            name: {'state': dict(self.states[name]), 'hashes': handoff.unit_hashes(self.states[name])}
                            for name in service_plan.LEGACY_UNITS}}
        (self.directory / 'handoff.json').write_text(json.dumps(self.journal))
        idle = {'isPriming': False, **{side: {'isOn': False, 'isAlarmVibrating': False, 'secondsRemaining': 0}
                                      for side in ('left', 'right')}}
        for name, value in (('UNIT_DIRECTORY', self.unit_directory), ('systemctl', self.control),
                            ('unit_state', lambda name: dict(self.states[name])),
                            ('local_json', lambda *_: idle), ('restored_idle', lambda: True)):
            context = patch.object(handoff, name, value)
            context.start(); self.addCleanup(context.stop)
        taps = {gesture: {'type': 'temperature', 'change': 'increment', 'amount': 1}
                for gesture in ('doubleTap', 'tripleTap', 'quadTap')}
        preference = {'name': 'Sleeper', 'awayMode': False, 'taps': taps, 'scheduleOverrides': {}}
        settings = {'timeZone': 'America/Los_Angeles', 'temperatureFormat': 'fahrenheit',
                    'primePodDaily': {'enabled': False, 'time': '00:15'}, 'rebootDaily': False,
                    'left': preference, 'right': preference}
        routine = {'power': {'enabled': False, 'on': '22:00', 'off': '07:00', 'onTemperature': 75},
                   'temperatures': {}, 'alarm': {'enabled': False, 'time': '06:30', 'duration': 10,
                    'vibrationIntensity': 50, 'vibrationPattern': 'rise', 'alarmTemperature': 80}}
        schedules = {side: {day: copy.deepcopy(routine) for day in
                     ('sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday')}
                     for side in ('left', 'right')}
        (self.legacy / 'lowdb').mkdir()
        for name, value in (('settingsDB.json', settings), ('schedulesDB.json', schedules)):
            (self.legacy / 'lowdb' / name).write_text(json.dumps(value))
        with sqlite3.connect(self.legacy / 'free-sleep.db') as database:
            database.executescript('''
                CREATE TABLE vitals (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER, heart_rate REAL, hrv REAL, breathing_rate REAL);
                CREATE TABLE movement (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER, total_movement INTEGER);
                CREATE TABLE sleep_records (id INTEGER PRIMARY KEY, side TEXT, entered_bed_at INTEGER, left_bed_at INTEGER,
                    sleep_period_seconds INTEGER, times_exited_bed INTEGER, present_intervals TEXT, not_present_intervals TEXT);
            ''')

    def control(self, *arguments):
        self.calls.append(arguments)
        action, *names = arguments
        for name in names:
            if action == 'stop' and not self.stop_failure:
                self.states[name].update(ActiveState='inactive', MainPID='0')
            if action == 'start' and not self.start_failure:
                self.states[name].update(ActiveState='active', MainPID='200')
        return ''

    def run_capture(self):
        return prepare_data.prepare(self.directory, self.legacy, self.backup_tool, self.backup_hash, self.output)

    def record(self):
        return json.loads((self.output / 'preparation.json').read_text())

    def assert_restored(self):
        self.assertTrue(all(self.states[name]['ActiveState'] == 'active' for name in service_plan.LEGACY_UNITS))
        self.assertTrue(all(self.states[name]['MainPID'] == '0' for name in service_plan.CORE_UNITS))
        self.assertTrue(all(call[0] in ('stop', 'start') and tuple(call[1:]) == service_plan.LEGACY_UNITS for call in self.calls))

    def test_capture_restores_before_real_import_and_preserves_history(self):
        before = {str(path.relative_to(self.legacy)): path.read_bytes() for path in self.legacy.rglob('*') if path.is_file()}
        run_tool = prepare_data.run_tool
        def observed(arguments, log, timeout):
            expected = 'inactive' if log.name == 'capture.log' else 'active'
            self.assertTrue(all(self.states[name]['ActiveState'] == expected for name in service_plan.LEGACY_UNITS))
            return run_tool(arguments, log, timeout)
        with patch.object(prepare_data, 'run_tool', side_effect=observed):
            result = self.run_capture()
        self.assertEqual(result['phase'], 'imported_for_review')
        self.assertTrue(result['captureComplete'] and result['restoredIdleVerified'])
        self.assertFalse(result['coreStarted'] or result['readyForCutover'] or result['liveDataReplaced'])
        self.assertLessEqual(result['capturedAt'], result['restoredAt'])
        self.assertLessEqual(result['restoredAt'], result['importedAt'])
        self.assert_restored()
        self.assertEqual(before, {str(path.relative_to(self.legacy)): path.read_bytes() for path in self.legacy.rglob('*') if path.is_file()})
        self.assertTrue((self.output / 'candidate/free-sleep-history.db').is_file())
        activation_checks.candidate_ready(self.output / 'candidate')
        with sqlite3.connect(self.output / 'candidate/sleepypod.db') as database:
            self.assertEqual(database.execute('SELECT COUNT(*) FROM comfort_activations').fetchone(), (0,))
        self.assertEqual((self.output / 'preparation.json').stat().st_mode & 0o777, 0o600)

    def test_invalid_hash_existing_or_overlapping_destination_never_stops(self):
        self.backup_hash = '0' * 64
        with self.assertRaisesRegex(ValueError, 'SHA-256'): self.run_capture()
        self.backup_hash = prepare_data.digest(self.backup_tool)
        self.output.mkdir()
        with self.assertRaisesRegex(ValueError, 'new directory'): self.run_capture()
        self.output = self.legacy / 'unsafe'
        with self.assertRaisesRegex(ValueError, 'separate'): self.run_capture()
        self.assertEqual(self.calls, [])

    def test_active_core_altered_service_or_active_heat_fail_before_downtime(self):
        self.states[service_plan.CORE_UNIT].update(ActiveState='active', MainPID='101')
        with self.assertRaisesRegex(ValueError, 'stopped and disabled'): self.run_capture()
        self.states[service_plan.CORE_UNIT].update(ActiveState='inactive', MainPID='0')
        with patch.object(handoff, 'require_thermal_idle', side_effect=RuntimeError('not idle')):
            with self.assertRaisesRegex(RuntimeError, 'not idle'): self.run_capture()
        (self.unit_directory / service_plan.LEGACY_UNITS[0]).write_text('unrelated unit')
        with self.assertRaisesRegex(ValueError, 'configuration changed'): self.run_capture()
        self.assertEqual(self.calls, [])
        self.assertFalse(self.output.exists())

    def test_unavailable_timezone_fails_before_capture_or_stop(self):
        settings = self.legacy / 'lowdb/settingsDB.json'
        value = json.loads(settings.read_text()); value['timeZone'] = 'Not/AZone'
        settings.write_text(json.dumps(value))
        with self.assertRaises(prepare_data.subprocess.CalledProcessError): self.run_capture()
        self.assertEqual(self.calls, [])
        self.assertFalse(self.output.exists())

    def test_output_cannot_land_inside_existing_core_data(self):
        plan = copy.deepcopy(self.plan)
        plan['config']['data'] = str(self.root)
        with patch.object(prepare_data, 'validate_plan', return_value=(plan, self.journal)):
            with self.assertRaisesRegex(ValueError, 'installed controller path'): self.run_capture()
        self.assertEqual(self.calls, [])

    def test_failed_stop_or_capture_always_restores_without_import(self):
        for failure in ('stop', 'capture', 'interrupt'):
            with self.subTest(failure=failure):
                self.output = self.root / ('attempt-' + failure)
                self.stop_failure = failure == 'stop'
                error = KeyboardInterrupt() if failure == 'interrupt' else OSError('capture failed')
                with patch.object(prepare_data, 'run_tool', side_effect=error) as runner:
                    with self.assertRaises((RuntimeError, OSError, KeyboardInterrupt)): self.run_capture()
                    self.assertLessEqual(runner.call_count, 1)
                self.assert_restored()
                self.assertEqual(self.record()['phase'], 'free_sleep_restored')
                self.assertFalse(self.record()['captureComplete'])
                self.assertFalse((self.output / 'candidate').exists())

    def test_configuration_change_after_stop_is_not_captured_or_overwritten(self):
        original = self.control
        changed = self.legacy / 'analytics/journal.json'
        def change(*arguments):
            result = original(*arguments)
            if arguments[0] == 'stop':
                changed.parent.mkdir(); changed.write_text('[]')
            return result
        with patch.object(handoff, 'systemctl', side_effect=change), patch.object(prepare_data, 'run_tool') as runner:
            with self.assertRaisesRegex(ValueError, 'changed before capture'): self.run_capture()
            runner.assert_not_called()
        self.assertEqual(changed.read_text(), '[]')
        self.assert_restored()

    def test_restart_during_capture_prevents_claim_of_quiesced_backup(self):
        run_tool = prepare_data.run_tool
        def restarted(*arguments):
            result = run_tool(*arguments)
            self.states[service_plan.LEGACY_UNITS[0]].update(ActiveState='active', MainPID='201')
            return result
        with patch.object(prepare_data, 'run_tool', side_effect=restarted):
            with self.assertRaisesRegex(RuntimeError, 'restarted during capture'): self.run_capture()
        self.assertFalse(self.record()['captureComplete'])
        self.assert_restored()

    def test_source_change_during_capture_is_reported_and_preserved(self):
        run_tool = prepare_data.run_tool
        def changed(*arguments):
            result = run_tool(*arguments)
            (self.legacy / 'lowdb/schedulesDB.json').write_text('{"new":"owner edit"}')
            return result
        with patch.object(prepare_data, 'run_tool', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'differs from the quiesced'): self.run_capture()
        self.assertEqual((self.legacy / 'lowdb/schedulesDB.json').read_text(), '{"new":"owner edit"}')
        self.assertFalse(self.record()['captureComplete'])
        self.assert_restored()

    def test_import_failure_happens_only_after_original_services_recover(self):
        run_tool = prepare_data.run_tool
        def failed(arguments, log, timeout):
            if log.name == 'import.log':
                self.assert_restored()
                raise OSError('import failed')
            return run_tool(arguments, log, timeout)
        with patch.object(prepare_data, 'run_tool', side_effect=failed):
            with self.assertRaisesRegex(OSError, 'import failed'): self.run_capture()
        self.assertEqual(self.record()['phase'], 'import_failed_free_sleep_restored')
        self.assertTrue(self.record()['captureComplete'])
        self.assert_restored()

    def test_restore_failure_keeps_recoverable_journal_without_repeating_capture(self):
        self.start_failure = True
        with self.assertRaisesRegex(RuntimeError, 'did not recover'): self.run_capture()
        self.assertEqual(self.record()['phase'], 'recovery_required')
        self.start_failure = False
        with patch.object(prepare_data, 'run_tool') as runner:
            result = prepare_data.recover(self.directory, self.output)
            runner.assert_not_called()
        self.assertTrue(result['restoredIdleVerified'])
        self.assertFalse((self.output / 'candidate').exists())
        self.assert_restored()

    def test_full_disk_does_not_prevent_restart_after_capture_error(self):
        write = handoff.private_json
        def failed_write(path, value):
            if value['phase'] == 'free_sleep_restored': raise OSError('disk full')
            return write(path, value)
        with patch.object(prepare_data, 'run_tool', side_effect=OSError('disk full')):
            with patch.object(handoff, 'private_json', side_effect=failed_write):
                with self.assertRaises(OSError): self.run_capture()
        self.assert_restored()

    def test_changed_plan_and_completed_import_cannot_be_recovered_as_interrupted(self):
        self.run_capture()
        with self.assertRaisesRegex(ValueError, 'No interrupted'): prepare_data.recover(self.directory, self.output)
        record = self.record(); record['planHash'] = '0' * 64
        (self.output / 'preparation.json').write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, 'another plan'): prepare_data.recover(self.directory, self.output)

    def test_recovery_will_not_start_an_unrelated_replacement_service(self):
        self.start_failure = True
        with self.assertRaises(RuntimeError): self.run_capture()
        (self.unit_directory / service_plan.LEGACY_UNITS[0]).write_text('unrelated replacement')
        calls = list(self.calls)
        with self.assertRaisesRegex(ValueError, 'configuration changed'):
            prepare_data.recover(self.directory, self.output)
        self.assertEqual(calls, self.calls)


if __name__ == '__main__':
    unittest.main()
