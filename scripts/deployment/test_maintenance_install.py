import copy
import json
import os
from pathlib import Path
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import handoff
import maintenance_install as provision
import maintenance_plan
import service_plan
from test_handoff import CONFIG


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root/'maintenance-plan-fixture'
        self.units = self.root/'units'
        self.units.mkdir()
        self.calls, self.states = [], {}
        self.listener = None
        self.socket = self.root/'control.sock'
        self.addCleanup(self.close_socket)
        self.manifest = maintenance_plan.prepare('/persistent/sleepypod-unified/service-plan-fixture', CONFIG['release'], self.directory)
        self.plan = service_plan.prepare({**CONFIG, 'maintenanceSocket': service_plan.MAINTENANCE_SOCKET}, self.root/'core-plan')
        for name in service_plan.CORE_UNITS:
            (self.units/name).write_bytes((self.root/'core-plan'/name).read_bytes())
            self.states[name] = self.state(name, enabled='disabled')
        for name in service_plan.LEGACY_UNITS:
            (self.units/name).write_text('Retained controller fixture\n')
            self.states[name] = self.state(name, active='active', pid='123', enabled='enabled')
        self.saved = {'legacy': {name: {'state': copy.deepcopy(self.states[name]),
                     'hashes': {str(self.units/name): provision.digest((self.units/name).read_bytes())}}
                     for name in service_plan.LEGACY_UNITS}}
        self.context = {'manifest': self.manifest, 'controller': Path(self.manifest['controllerPlan']),
                        'plan': self.plan, 'handoff': self.saved, 'revision': 'a'*40}
        for target, name, value in [(provision, 'OWNER_UID', os.getuid()), (provision, 'UNIT_DIRECTORY', self.units),
                                    (handoff, 'UNIT_DIRECTORY', self.units), (handoff, 'systemctl', self.control),
                                    (handoff, 'unit_state', self.unit_state), (service_plan, 'MAINTENANCE_SOCKET', str(self.socket))]:
            context = patch.object(target, name, value)
            context.start()
            self.addCleanup(context.stop)
        context = patch.object(provision.pwd, 'getpwnam', return_value=SimpleNamespace(pw_gid=os.getgid()))
        context.start()
        self.addCleanup(context.stop)
        self.foreign = self.units/'unrelated.service'
        self.foreign.write_text('unrelated service')
        self.credentials = self.root/'controller.env'
        self.credentials.write_bytes(b'SLEEPYPOD_AUTH_TOKEN=fixture-key-not-used\n')

    def state(self, name, active='inactive', pid='0', enabled='static', loaded='loaded'):
        result = {'LoadState': loaded, 'ActiveState': active, 'UnitFileState': enabled,
                  'FragmentPath': str(self.units/name) if loaded == 'loaded' else '', 'DropInPaths': ''}
        # Real systemd socket units have no MainPID, including when not found.
        if name != maintenance_plan.SOCKET:
            result['MainPID'] = pid
        return result

    def unit_state(self, name):
        return copy.deepcopy(self.states.get(name, self.state(name, loaded='not-found', enabled='')))

    def close_socket(self):
        if self.listener:
            self.listener.close()
            self.listener = None
        self.socket.unlink(missing_ok=True)

    def control(self, *arguments):
        self.calls.append(arguments)
        action, *names = arguments
        if action == 'daemon-reload':
            for name in provision.UNITS:
                if (self.units/name).exists():
                    self.states[name] = self.states.get(name, self.state(name, enabled='disabled' if name == maintenance_plan.SOCKET else 'static'))
                else: self.states.pop(name, None)
        elif action == 'enable':
            self.assertEqual(names, ['--now', maintenance_plan.SOCKET])
            self.states[maintenance_plan.SOCKET].update(ActiveState='active', UnitFileState='enabled')
            self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.listener.bind(str(self.socket))
            self.socket.chmod(0o660)
        elif action == 'stop':
            self.assertTrue(set(names) <= set(provision.UNITS))
            for name in names:
                self.states[name]['ActiveState'] = 'inactive'
                if name != maintenance_plan.SOCKET:
                    self.states[name]['MainPID'] = '0'
            self.close_socket()
        elif action == 'disable':
            self.assertEqual(names, [maintenance_plan.SOCKET])
            self.states[maintenance_plan.SOCKET]['UnitFileState'] = 'disabled'
        else: raise AssertionError('Unexpected service action: '+str(arguments))
        return ''

    def assert_preserved(self):
        self.assertEqual(self.foreign.read_text(), 'unrelated service')
        self.assertEqual(self.credentials.read_bytes(), b'SLEEPYPOD_AUTH_TOKEN=fixture-key-not-used\n')
        for name in service_plan.CORE_UNITS:
            self.assertEqual(self.states[name]['ActiveState'], 'inactive')
            self.assertEqual((self.units/name).read_bytes(), (self.root/'core-plan'/name).read_bytes())
        for name in service_plan.LEGACY_UNITS: self.assertEqual(self.states[name]['MainPID'], '123')

    def test_install_enable_and_rollback_leave_controller_and_credentials_untouched(self):
        self.assertEqual(provision.install(self.directory, self.context)['phase'], 'installed_stopped')
        self.assertEqual(self.calls, [('daemon-reload',)])
        self.assertFalse(self.socket.exists())
        self.assertEqual(provision.enable(self.directory, self.context)['phase'], 'enabled')
        self.assertTrue(self.socket.exists())
        self.assertEqual(provision.rollback(self.directory, self.context)['phase'], 'rolled_back')
        self.assertFalse(self.socket.exists())
        self.assertTrue(all(not (self.units/name).exists() for name in provision.UNITS))
        before = list(self.calls)
        self.assertEqual(provision.rollback(self.directory, self.context)['phase'], 'rolled_back')
        self.assertEqual(self.calls, before)
        self.assert_preserved()

    def test_refuses_live_or_boot_selected_core_and_unavailable_legacy_before_writes(self):
        for name, changes in [('sleepypod.service', {'ActiveState': 'active', 'MainPID': '456'}),
                               ('sleepypod-calibrator.service', {'UnitFileState': 'enabled'}),
                               ('free-sleep.service', {'MainPID': '0'})]:
            original = self.states[name].copy()
            self.states[name].update(changes)
            with self.assertRaises(ValueError): provision.install(self.directory, self.context)
            self.states[name] = original
        self.assertFalse(provision.journal_path(self.directory).exists())
        self.assertEqual(self.calls, [])

    def test_missing_service_pid_is_not_treated_like_a_stopped_socket(self):
        state = self.state(maintenance_plan.SERVICE, loaded='not-found', enabled='')
        state.pop('MainPID')
        self.states[maintenance_plan.SERVICE] = state
        with self.assertRaisesRegex(ValueError, 'already exists'):
            provision.install(self.directory, self.context)
        self.assertFalse(provision.journal_path(self.directory).exists())
        self.assertEqual(self.calls, [])

    def test_preexisting_or_symlinked_service_is_never_overwritten(self):
        target = self.units/maintenance_plan.SERVICE
        target.symlink_to(self.foreign)
        with self.assertRaises(ValueError): provision.install(self.directory, self.context)
        self.assertTrue(target.is_symlink())
        self.assertEqual(self.foreign.read_text(), 'unrelated service')
        self.assertFalse(provision.journal_path(self.directory).exists())

    def test_journal_precedes_atomic_publication_and_crash_can_be_rolled_back(self):
        original = provision.publish_unit
        def publish(path, contents):
            self.assertEqual(provision.read_journal(self.directory, self.context)['phase'], 'installing')
            if path.name == maintenance_plan.SERVICE: raise OSError('simulated power loss')
            original(path, contents)
        with patch.object(provision, 'publish_unit', side_effect=publish):
            with self.assertRaisesRegex(OSError, 'power loss'): provision.install(self.directory, self.context)
        self.assertTrue((self.units/maintenance_plan.SOCKET).exists())
        self.assertFalse((self.units/maintenance_plan.SERVICE).exists())
        self.assertEqual(provision.rollback(self.directory, self.context)['phase'], 'rolled_back')
        self.assert_preserved()

    def test_unknown_enable_outcome_recovers_actual_enabled_state_without_replay(self):
        provision.install(self.directory, self.context)
        original = self.control
        def control(*arguments):
            result = original(*arguments)
            if arguments[0] == 'enable': raise TimeoutError('reply lost after enable')
            return result
        with patch.object(handoff, 'systemctl', side_effect=control):
            with self.assertRaises(TimeoutError): provision.enable(self.directory, self.context)
        self.assertEqual(provision.read_journal(self.directory, self.context)['phase'], 'enabling')
        with self.assertRaises(ValueError): provision.enable(self.directory, self.context)
        self.assertEqual(provision.rollback(self.directory, self.context)['phase'], 'rolled_back')
        self.assertEqual(sum(call[0] == 'enable' for call in self.calls), 1)
        self.assert_preserved()

    def test_changed_unit_or_override_is_preserved_before_stop(self):
        provision.install(self.directory, self.context)
        original = (self.units/maintenance_plan.SERVICE).read_bytes()
        (self.units/maintenance_plan.SERVICE).write_text('foreign replacement')
        before = list(self.calls)
        with self.assertRaisesRegex(ValueError, 'changed'): provision.rollback(self.directory, self.context)
        self.assertEqual((self.units/maintenance_plan.SERVICE).read_text(), 'foreign replacement')
        self.assertEqual(self.calls, before)
        (self.units/maintenance_plan.SERVICE).write_bytes(original)
        self.states[maintenance_plan.SERVICE]['DropInPaths'] = '/foreign/override.conf'
        with self.assertRaisesRegex(ValueError, 'override'): provision.rollback(self.directory, self.context)
        self.assertEqual(self.calls, before)

    def test_failed_stop_preserves_units_and_recovery_can_continue(self):
        provision.install(self.directory, self.context)
        provision.enable(self.directory, self.context)
        self.states[maintenance_plan.SERVICE].update(ActiveState='active', MainPID='999')
        original = self.control
        with patch.object(handoff, 'systemctl', side_effect=lambda *args: '' if args[0] == 'stop' else original(*args)):
            with self.assertRaisesRegex(ValueError, 'did not stop'): provision.rollback(self.directory, self.context)
        self.assertTrue(all((self.units/name).exists() for name in provision.UNITS))
        self.assertEqual(provision.rollback(self.directory, self.context)['phase'], 'rolled_back')
        self.assert_preserved()

    def test_refuses_permissive_socket_and_preserves_recovery_journal(self):
        provision.install(self.directory, self.context)
        original = self.control
        def control(*arguments):
            result = original(*arguments)
            if arguments[0] == 'enable': self.socket.chmod(0o666)
            return result
        with patch.object(handoff, 'systemctl', side_effect=control):
            with self.assertRaisesRegex(ValueError, 'permissions'): provision.enable(self.directory, self.context)
        self.assertEqual(provision.read_journal(self.directory, self.context)['phase'], 'enabling')
        provision.rollback(self.directory, self.context)
        self.assert_preserved()

    def test_active_cached_service_without_reviewed_file_requires_manual_review(self):
        provision.install(self.directory, self.context)
        (self.units/maintenance_plan.SERVICE).unlink()
        self.states[maintenance_plan.SERVICE].update(ActiveState='active', MainPID='999')
        before = list(self.calls)
        with self.assertRaisesRegex(ValueError, 'cached process'): provision.rollback(self.directory, self.context)
        self.assertEqual(self.calls, before)

    def test_changed_controller_ownership_never_records_success(self):
        original = self.control
        def control(*arguments):
            result = original(*arguments)
            self.states['free-sleep.service']['MainPID'] = '0'
            return result
        with patch.object(handoff, 'systemctl', side_effect=control):
            with self.assertRaisesRegex(ValueError, 'Retained'): provision.install(self.directory, self.context)
        self.assertEqual(provision.read_journal(self.directory, self.context)['phase'], 'installing')
        self.states['free-sleep.service']['MainPID'] = '123'
        provision.rollback(self.directory, self.context)
        self.assert_preserved()


class ContextTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory, self.controller = self.root/'maintenance-plan-fixture', self.root/'service-plan-fixture'
        self.directory.mkdir(mode=0o700)
        self.controller.mkdir(mode=0o700)
        self.environment = self.root/'controller.env'
        self.environment.write_text('SLEEPYPOD_AUTH_TOKEN=local-test-key-never-exported\n')
        self.environment.chmod(0o600)
        for directory, names in ((self.directory, (*provision.UNITS, 'maintenance-plan.json')),
                                  (self.controller, (*service_plan.CORE_UNITS, 'plan.json'))):
            for name in names:
                (directory/name).write_text('delegated renderer fixture')
                (directory/name).chmod(0o600)
        self.plan = {'units': {name: 'b'*64 for name in service_plan.CORE_UNITS},
                     'config': {**CONFIG, 'maintenanceSocket': service_plan.MAINTENANCE_SOCKET,
                                'release': str(self.root/'releases/reviewed'), 'environment': str(self.environment)}}
        self.manifest = {'controllerPlan': str(self.controller), 'release': self.plan['config']['release'],
                         'units': {name: 'c'*64 for name in provision.UNITS}}
        self.write(self.controller/'handoff.json', {'format': 'sleepypod-handoff/1', 'phase': 'installed_not_started', 'unitHashes': self.plan['units']})
        patches = [patch.object(provision, 'ROOT', self.root), patch.object(provision, 'OWNER_UID', os.getuid()),
                   patch.object(provision, 'secure_path'), patch.object(provision, 'verify_release', return_value='a'*40),
                   patch.object(maintenance_plan, 'read_plan', return_value=self.manifest),
                   patch.object(service_plan, 'read_plan', return_value=self.plan), patch.object(handoff, 'read_owner_key')]
        self.mocks = [context.start() for context in patches]
        for context in patches: self.addCleanup(context.stop)

    def write(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def test_matching_context_does_not_export_credentials(self):
        context = provision.load_context(self.directory)
        self.assertEqual(context['revision'], 'a'*40)
        self.assertNotIn('local-test-key', json.dumps(context, default=str))
        self.mocks[-1].assert_called_once_with(self.environment)

    def test_mismatched_release_or_missing_controller_opt_in_refused(self):
        self.manifest['release'] += '-different'
        with self.assertRaisesRegex(ValueError, 'does not select'): provision.load_context(self.directory)
        self.manifest['release'] = self.plan['config']['release']
        self.plan['config'].pop('maintenanceSocket')
        with self.assertRaisesRegex(ValueError, 'does not select'): provision.load_context(self.directory)

    def test_credential_environment_override_is_rejected_without_rewriting_it(self):
        value = b'SLEEPYPOD_AUTH_TOKEN=private-fixture\nSLEEPYPOD_MAINTENANCE_SOCKET=/tmp/other\n'
        self.environment.write_bytes(value)
        with self.assertRaisesRegex(ValueError, 'conflicting'): provision.load_context(self.directory)
        self.assertEqual(self.environment.read_bytes(), value)

    def test_active_cutover_refused_but_completed_controller_rollback_allows_cleanup(self):
        record = {'format': 'sleepypod-activation/1', 'unitHashes': self.plan['units'], 'phase': 'active',
                  'activeOwner': 'sleepypod-core', 'bootOwner': 'sleepypod-core'}
        self.write(self.controller/'activation.json', record)
        with self.assertRaisesRegex(ValueError, 'Roll back'): provision.load_context(self.directory)
        record.update(phase='rolled_back', activeOwner='free-sleep', bootOwner='free-sleep')
        self.write(self.controller/'activation.json', record)
        self.assertEqual(provision.load_context(self.directory)['revision'], 'a'*40)

    def test_recovery_uses_bound_journal_without_requiring_runtime_or_credentials(self):
        self.environment.unlink()
        self.mocks[3].side_effect = FileNotFoundError('runtime unavailable')
        journal = {'format': provision.JOURNAL_FORMAT, 'phase': 'enabling', 'sourceCommit': 'a'*40,
                   'unitHashes': self.manifest['units'], 'controllerPlan': str(self.controller)}
        self.write(provision.journal_path(self.directory), journal)
        context = provision.load_context(self.directory, recovery=True)
        self.assertEqual(provision.read_journal(self.directory, context), journal)
        self.mocks[3].assert_not_called()
        self.mocks[-1].assert_not_called()
        journal['unitHashes'] = {}
        self.write(provision.journal_path(self.directory), journal)
        with self.assertRaisesRegex(ValueError, 'does not match'): provision.read_journal(self.directory, context)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        broker = self.root/'app/scripts/deployment/maintenance_broker.py'
        broker.parent.mkdir(parents=True)
        broker.write_text('# inert package fixture\n')
        (self.root/'app/.git-info').write_text(json.dumps({'commitHash': 'abcdef1'}))
        self.manifest = {'format': 'sleepypod-offline-runtime/1', 'maintenanceProtocol': 1,
                         'sourceCommit': 'abcdef1'+'0'*33,
                         'application': [{'path': name, 'sha256': provision.digest((self.root/'app'/name).read_bytes())}
                         for name in ('scripts/deployment/maintenance_broker.py', '.git-info')]}
        for target, name, value in [(provision, 'OWNER_UID', os.getuid()), (provision, 'secure_path', lambda *_args, **_kwargs: None)]:
            context = patch.object(target, name, value)
            context.start()
            self.addCleanup(context.stop)

    def verify(self):
        (self.root/'bundle-manifest.json').write_text(json.dumps(self.manifest))
        return provision.verify_release(self.root)

    def test_matching_broker_and_client_build_identity(self):
        self.assertEqual(self.verify(), self.manifest['sourceCommit'])

    def test_old_protocol_duplicate_record_or_tampered_broker_refused(self):
        for protocol in (None, True, 2):
            self.manifest['maintenanceProtocol'] = protocol
            with self.assertRaisesRegex(ValueError, 'protocol'): self.verify()
        self.manifest['maintenanceProtocol'] = 1
        self.manifest['application'].append(self.manifest['application'][0])
        with self.assertRaisesRegex(ValueError, 'manifest'): self.verify()
        self.manifest['application'].pop()
        (self.root/'app/scripts/deployment/maintenance_broker.py').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'manifest'): self.verify()

    def test_wrong_build_identity_and_shared_writable_broker_refused(self):
        self.manifest['sourceCommit'] = 'a'*40
        with self.assertRaisesRegex(ValueError, 'identity'): self.verify()
        self.manifest['sourceCommit'] = 'abcdef1'+'0'*33
        (self.root/'app/scripts/deployment/maintenance_broker.py').chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'permissions'): self.verify()

    def test_atomic_publication_refuses_existing_files_and_symlinks(self):
        target = self.root/'existing'
        target.write_bytes(b'original')
        with self.assertRaises(FileExistsError): provision.publish_unit(target, b'replacement')
        self.assertEqual(target.read_bytes(), b'original')
        link = self.root/'link'
        link.symlink_to(target)
        with self.assertRaises(FileExistsError): provision.publish_unit(link, b'replacement')
        self.assertEqual(target.read_bytes(), b'original')
        self.assertEqual(list(self.root.glob('.sleepypod-maintenance-*')), [])


if __name__ == '__main__': unittest.main()
