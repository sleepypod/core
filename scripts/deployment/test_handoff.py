import hashlib
import json
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import handoff
import service_plan


CONFIG = {
    'release': '/persistent/sleepypod-unified/releases/abc1234',
    'modules': '/persistent/sleepypod-unified/sensors/abc1234/modules',
    'data': '/persistent/sleepypod-unified/data',
    'environment': '/persistent/sleepypod-unified/controller.env',
    'dacSocket': '/persistent/deviceinfo/dac.sock',
    'rawData': '/persistent',
}


class ServicePlanTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_plan_is_inert_and_limits_service_ownership(self):
        directory = self.root / 'plan'
        plan = service_plan.prepare(CONFIG, directory)
        self.assertEqual(service_plan.read_plan(directory), plan)
        self.assertFalse(plan['servicesStarted'])
        self.assertFalse(plan['bootSelectionChanged'])
        self.assertEqual(set(plan['units']), set(service_plan.CORE_UNITS))
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        units = service_plan.render(CONFIG)
        for name, content in units.items():
            self.assertIn('User=dac\n', content)
            self.assertIn('KillMode=control-group\n', content)
            self.assertIn('Conflicts=free-sleep.service free-sleep-stream.service\n', content)
            self.assertNotIn('ExecStartPre=', content)
            self.assertNotIn('User=root', content)
            if name != 'sleepypod.service':
                self.assertIn('BindsTo=sleepypod.service\n', content)
                self.assertNotIn('EnvironmentFile=', content)
        self.assertNotIn('cover-buttons', '\n'.join(units))

    def test_unsafe_shared_overlapping_or_expandable_paths_are_rejected(self):
        cases = [('release', '/home/dac/free-sleep'), ('release', '/'),
                 ('release', '/persistent/sleepypod-unified/a/../b'),
                 ('release', '/persistent/sleepypod-unified/a%u'),
                 ('release', '/persistent/sleepypod-unified/a\nUser=root'),
                 ('release', '/persistent/sleepypod-unified/a b'),
                 ('modules', CONFIG['release'] + '/modules'),
                 ('data', CONFIG['release']),
                 ('environment', CONFIG['data'] + '/secret'),
                 ('dacSocket', '/tmp/other.sock')]
        for field, value in cases:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                service_plan.render({**CONFIG, field: value})

    def test_existing_destination_is_not_replaced(self):
        with self.assertRaises(ValueError):
            service_plan.prepare(CONFIG, self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_optional_maintenance_socket_is_explicit_and_leaves_existing_plans_unchanged(self):
        self.assertNotIn('SLEEPYPOD_MAINTENANCE_SOCKET', service_plan.render(CONFIG)['sleepypod.service'])
        units = service_plan.render({**CONFIG, 'maintenanceSocket': service_plan.MAINTENANCE_SOCKET})
        self.assertIn('Environment="SLEEPYPOD_MAINTENANCE_SOCKET=/run/sleepypod-maintenance/control.sock"', units['sleepypod.service'])
        self.assertTrue(all('SLEEPYPOD_MAINTENANCE_SOCKET' not in text for name, text in units.items() if name != 'sleepypod.service'))
        for socket in ('/tmp/control.sock', None, True, '/run/sleepypod-maintenance/control.sock\nUser=root'):
            with self.assertRaises(ValueError): service_plan.render({**CONFIG, 'maintenanceSocket': socket})

    def test_rehashed_service_tampering_is_rejected(self):
        directory = self.root / 'plan'
        plan = service_plan.prepare(CONFIG, directory)
        target = directory / 'sleepypod.service'
        target.write_text(target.read_text().replace('User=dac', 'User=root'))
        plan['units'][target.name] = hashlib.sha256(target.read_bytes()).hexdigest()
        (directory / 'plan.json').write_text(json.dumps(plan))
        with self.assertRaisesRegex(ValueError, 'reviewed template'):
            service_plan.read_plan(directory)

    def test_unit_symlink_is_rejected(self):
        directory = self.root / 'plan'
        service_plan.prepare(CONFIG, directory)
        target = directory / 'sleepypod.service'
        saved = self.root / 'saved.service'
        target.rename(saved)
        target.symlink_to(saved)
        with self.assertRaises(ValueError):
            service_plan.read_plan(directory)


class HandoffTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / 'plan'
        self.plan = service_plan.prepare(CONFIG, self.directory)
        self.unit_directory = self.root / 'units'
        self.unit_directory.mkdir()
        self.calls = []
        self.states = {}
        self.start_failure = False
        self.stop_failure = False
        for name in service_plan.LEGACY_UNITS:
            path = self.unit_directory / name
            path.write_text('original retained service\n')
            self.states[name] = {'LoadState': 'loaded', 'ActiveState': 'active', 'MainPID': '123',
                                 'UnitFileState': 'enabled', 'FragmentPath': str(path), 'DropInPaths': ''}
        for name in service_plan.CORE_UNITS:
            self.states[name] = {'LoadState': 'not-found', 'ActiveState': 'inactive', 'MainPID': '0',
                                 'UnitFileState': '', 'FragmentPath': '', 'DropInPaths': ''}
        for name, replacement in [('UNIT_DIRECTORY', self.unit_directory), ('systemctl', self.control), ('unit_state', lambda name: dict(self.states[name])),
                                  ('require_legacy_recovery_data', lambda _: None)]:
            context = patch.object(handoff, name, replacement)
            context.start()
            self.addCleanup(context.stop)

    def control(self, *arguments):
        self.calls.append(arguments)
        action, *names = arguments
        if action == 'daemon-reload':
            for name in service_plan.CORE_UNITS:
                self.states[name].update(LoadState='loaded', UnitFileState='disabled',
                                         FragmentPath=str(self.unit_directory / name))
        if action == 'stop':
            for name in names:
                if self.stop_failure and name in service_plan.LEGACY_UNITS:
                    continue
                self.states[name].update(ActiveState='inactive', MainPID='0')
        if action == 'start':
            if names == ['sleepypod.service'] and self.start_failure:
                raise OSError('startup failed')
            for name in names:
                self.states[name].update(ActiveState='active', MainPID='456')
        return ''

    def test_restore_holds_personal_data_before_and_after_stopping_writers(self):
        handoff.install(self.directory)
        journal = json.loads((self.directory/'handoff.json').read_text())
        for effects, should_stop in [([ValueError('personal recovery')], False), ([None, ValueError('personal recovery')], True)]:
            self.calls.clear()
            with patch.object(handoff, 'require_legacy_recovery_data', side_effect=effects), self.assertRaisesRegex(ValueError, 'personal recovery'):
                handoff.restore(self.plan, journal)
            self.assertEqual(any(call[0] == 'stop' for call in self.calls), should_stop)
            self.assertFalse(any(call[0] == 'start' for call in self.calls))

    def prepare_trial(self):
        handoff.install(self.directory)
        for name, replacement in [('prerequisites', lambda plan: 'a' * 40),
                                  ('read_owner_key', lambda path: 'test-key-never-recorded')]:
            context = patch.object(handoff, name, replacement)
            context.start()
            self.addCleanup(context.stop)

    def run_trial(self, observation=None):
        clock = iter(range(100))
        return handoff.trial(self.directory, 10, observe=observation or (lambda *_: {
            'controller': {'id': 'sleepypod-core'}, 'device': {'freshness': 'fresh'},
            'temperatureRuntime': 'ready'}), sleep=lambda _: None, monotonic=lambda: next(clock))

    def test_install_never_starts_or_enables_services(self):
        result = handoff.install(self.directory)
        self.assertEqual(result['phase'], 'installed_not_started')
        self.assertEqual(self.calls, [('daemon-reload',)])
        self.assertFalse(result['bootSelectionChanged'])
        self.assertEqual(set(result['createdUnits']), set(service_plan.CORE_UNITS))
        with self.assertRaises(ValueError):
            handoff.install(self.directory)

    def test_install_refuses_existing_foreign_units(self):
        (self.unit_directory / 'sleepypod.service').write_text('unrelated')
        with self.assertRaises(ValueError):
            handoff.install(self.directory)
        self.assertEqual(self.calls, [])
        self.assertEqual((self.unit_directory / 'sleepypod.service').read_text(), 'unrelated')

    def test_trial_has_single_owner_and_always_restores_original_boot_selection(self):
        self.prepare_trial()
        result = self.run_trial()
        self.assertTrue(result['trialSucceeded'])
        self.assertEqual(result['phase'], 'trial_restored')
        self.assertEqual(self.calls[1:], [('stop', *service_plan.LEGACY_UNITS), ('start', service_plan.CORE_UNIT),
                                       ('stop', *service_plan.CORE_UNITS), ('start', *service_plan.LEGACY_UNITS)])
        self.assertNotIn('test-key-never-recorded', (self.directory / 'handoff.json').read_text())
        self.assertFalse(result['restoration']['physicalOperationVerified'])

    def test_failed_core_start_restores_legacy(self):
        self.prepare_trial()
        self.start_failure = True
        with self.assertRaisesRegex(OSError, 'startup failed'):
            self.run_trial()
        self.assertEqual(self.calls[-2:], [('stop', *service_plan.CORE_UNITS), ('start', *service_plan.LEGACY_UNITS)])
        self.assertEqual(json.loads((self.directory / 'handoff.json').read_text())['phase'], 'trial_restored')

    def test_legacy_stop_failure_never_starts_core(self):
        self.prepare_trial()
        self.stop_failure = True
        with self.assertRaisesRegex(RuntimeError, 'still present'):
            self.run_trial()
        self.assertNotIn(('start', service_plan.CORE_UNIT), self.calls)
        self.assertEqual(self.calls[-1], ('start', *service_plan.LEGACY_UNITS))

    def test_stale_or_failed_observations_restore_without_success_claim(self):
        for behavior in ('stale', 'failure'):
            with self.subTest(behavior=behavior):
                if behavior == 'stale':
                    self.prepare_trial()
                def observe(*_args):
                    if behavior == 'failure':
                        raise OSError('not ready')
                    return {'device': {'freshness': 'stale'}}
                with self.assertRaisesRegex(RuntimeError, 'fresh device report'):
                    self.run_trial(observe)
                result = json.loads((self.directory / 'handoff.json').read_text())
                self.assertFalse(result['trialSucceeded'])
                self.assertEqual(result['phase'], 'trial_restored')

    def test_interrupt_still_restores_and_propagates(self):
        self.prepare_trial()
        def interrupted(*_args):
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.run_trial(interrupted)
        self.assertEqual(self.calls[-1], ('start', *service_plan.LEGACY_UNITS))

    def test_modified_unit_or_old_journal_stops_before_any_service_mutation(self):
        self.prepare_trial()
        for changed in (self.unit_directory / 'sleepypod.service', self.unit_directory / 'free-sleep.service'):
            original = changed.read_bytes()
            changed.write_text('changed')
            with self.assertRaises(ValueError):
                self.run_trial()
            changed.write_bytes(original)
        self.assertEqual(self.calls, [('daemon-reload',)])
        journal = self.directory / 'handoff.json'
        value = json.loads(journal.read_text())
        value['phase'] = 'core_trial'
        journal.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'Recover'):
            self.run_trial()

    def test_restore_stops_core_before_rejecting_changed_legacy(self):
        self.prepare_trial()
        journal = json.loads((self.directory / 'handoff.json').read_text())
        (self.unit_directory / 'free-sleep.service').write_text('changed')
        with self.assertRaises(ValueError):
            handoff.restore(self.plan, journal)
        self.assertEqual(self.calls[-1], ('stop', *service_plan.CORE_UNITS))

    def test_credentials_require_private_file_and_never_accept_ambiguous_values(self):
        path = self.root / 'owner.env'
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)
        with patch.object(Path, 'lstat', return_value=info):
            for content in ('', 'SLEEPYPOD_AUTH_TOKEN=short', 'SLEEPYPOD_AUTH_TOKEN="' + 'a' * 40 + '"',
                            'SLEEPYPOD_AUTH_TOKEN=' + 'a' * 40 + '\nSLEEPYPOD_AUTH_TOKEN=' + 'b' * 40):
                path.write_text(content)
                with self.assertRaises(ValueError):
                    handoff.read_owner_key(path)
            path.write_text('SLEEPYPOD_AUTH_TOKEN=' + 'a' * 40)
            self.assertEqual(handoff.read_owner_key(path), 'a' * 40)
            info.st_mode = stat.S_IFREG | 0o644
            with self.assertRaises(ValueError):
                handoff.read_owner_key(path)

    def test_settling_requires_consecutive_fresh_observations(self):
        self.prepare_trial()
        current = [0]
        observations = []

        def observe(*_args):
            observations.append(current[0])
            return {'device': {'freshness': 'stale' if current[0] == 2 else 'fresh'}}

        result = handoff.trial(self.directory, 10, observe=observe, settle_seconds=3,
                               monotonic=lambda: current[0], sleep=lambda seconds: current.__setitem__(0, current[0] + seconds))
        self.assertEqual(observations, [0, 2, 4, 6, 8])
        self.assertTrue(result['trialSucceeded'])

    def test_idle_trial_rejects_active_legacy_before_stopping_it(self):
        self.prepare_trial()
        with patch.object(handoff, 'local_json', return_value={'isPriming': True}):
            with self.assertRaisesRegex(RuntimeError, 'priming'):
                handoff.trial(self.directory, 10, require_idle=True)
        self.assertEqual(self.calls, [('daemon-reload',)])

    def test_idle_trial_rejects_heating_drift_and_checks_restored_api(self):
        self.prepare_trial()
        idle = {'isPriming': False, **{side: {'isOn': False, 'isAlarmVibrating': False, 'secondsRemaining': 0}
                                      for side in ('left', 'right')}}
        drift = {'isPriming': False, 'leftSide': {'heatingDuration': 28800}, 'rightSide': {'heatingDuration': 0}}
        with patch.object(handoff, 'local_json', side_effect=[idle, drift, idle]):
            with self.assertRaisesRegex(RuntimeError, 'countdown'):
                handoff.trial(self.directory, 10, require_idle=True, observe=lambda *_: {'device': {'freshness': 'fresh'}})
        journal = json.loads((self.directory / 'handoff.json').read_text())
        self.assertFalse(journal['trialSucceeded'])
        self.assertTrue(journal['restoredIdleVerified'])
        self.assertEqual(journal['phase'], 'trial_restored')

    def test_post_restoration_power_change_revokes_trial_success(self):
        self.prepare_trial()
        idle = {'isPriming': False, **{side: {'isOn': False, 'isAlarmVibrating': False, 'secondsRemaining': 0}
                                      for side in ('left', 'right')}}
        core = {'isPriming': False, 'leftSide': {'heatingDuration': 0}, 'rightSide': {'heatingDuration': 0}}
        changed = {**idle, 'left': {**idle['left'], 'secondsRemaining': 60}}
        with patch.object(handoff, 'local_json', side_effect=[idle, core, changed]):
            with self.assertRaisesRegex(RuntimeError, 'countdown'):
                handoff.trial(self.directory, 10, require_idle=True, observe=lambda *_: {'device': {'freshness': 'fresh'}})
        journal = json.loads((self.directory / 'handoff.json').read_text())
        self.assertFalse(journal['trialSucceeded'])
        self.assertFalse(journal['restoredIdleVerified'])

    def test_idle_check_accepts_retained_targets_but_rejects_missing_or_boolean_duration(self):
        value = {'isPriming': False, 'leftSide': {'targetLevel': 5, 'heatingDuration': 0},
                 'rightSide': {'targetLevel': -20, 'heatingDuration': 0}}
        handoff.require_thermal_idle(value, core=True)
        for duration in (None, False, -1, float('nan'), 1):
            value['leftSide']['heatingDuration'] = duration
            with self.assertRaises(RuntimeError):
                handoff.require_thermal_idle(value, core=True)


if __name__ == '__main__':
    unittest.main()
