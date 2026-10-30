import copy
from contextlib import nullcontext
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import maintenance_broker as broker


def request(**changes):
    return {'version': 1, 'requestId': '11111111-1111-4111-8111-111111111111',
            'invocationId': 'a' * 32, 'unit': broker.CORE, 'issuedAt': 100000,
            'expiresAt': 105000, **changes}


class Store:
    def __init__(self):
        self.value = None
        self.writes = []

    def read(self):
        return copy.deepcopy(self.value)

    def write(self, value):
        self.value = copy.deepcopy(value)
        self.writes.append(copy.deepcopy(value))


class RequestTests(unittest.TestCase):
    def test_valid_targets_and_clock_boundaries(self):
        for unit in broker.TARGETS:
            broker.validate_request(request(unit=unit), 100000)
            broker.validate_request(request(unit=unit), 105000)

    def test_rejects_invalid_authority_and_timing(self):
        for changed in ({'unit': 'sshd.service'}, {'unit': 'free-sleep.service'}, {'unit': '--all'},
                        {'unit': 'sleepypod.service;reboot'}, {'unit': 'sleepypod-calibrator.service'},
                        {'version': True}, {'invocationId': 'a' * 31}, {'requestId': 'reused'},
                        {'issuedAt': 100001}, {'expiresAt': 99999}, {'expiresAt': 105001},
                        {'issuedAt': True}, {'issuedAt': 100000.0}, {'additional': 'field'}):
            with self.subTest(changed=changed), self.assertRaises(broker.Rejected):
                broker.validate_request(request(**changed), 100000)
        with self.assertRaises(broker.Rejected):
            broker.validate_request(request(), 105001)

    def test_duplicate_and_nonfinite_json_refused(self):
        for value in ('{"unit":"one","unit":"two"}', '{"value":NaN}', '{"value":Infinity}'):
            with self.assertRaises(ValueError): broker.unique_json(value)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.system = Mock()
        self.system.submit.return_value = True
        self.now, self.monotonic = 100, 100
        self.lock = patch.object(broker, 'operation_lock', return_value=nullcontext()).start()
        patch.object(broker, 'read_hashes', return_value={unit: 'a' * 64 for unit in broker.PLAN_UNITS}).start()
        self.addCleanup(patch.stopall)
        self.instance = broker.Broker(Path('/reviewed'), self.store, self.system,
                                      now=lambda: self.now, monotonic=lambda: self.monotonic)

    def send(self, **changes):
        return self.instance.request(request(**changes), (111, 1000, 1000))

    def test_persists_before_command_and_deduplicates(self):
        def submit(unit):
            self.assertEqual(unit, broker.CORE)
            self.assertEqual(self.store.value['outcome'], 'submitting')
            return True
        self.system.submit.side_effect = submit
        first = self.send()
        self.assertEqual(first['outcome'], 'accepted')
        self.assertEqual(self.send(), first)
        self.assertEqual(self.system.submit.call_count, 1)
        self.assertEqual([item['outcome'] for item in self.store.writes], ['submitting', 'accepted'])

    def test_same_id_cannot_change_target(self):
        self.send()
        with self.assertRaises(broker.Rejected): self.send(unit=broker.TARGETS[1])
        self.assertEqual(self.system.submit.call_count, 1)

    def test_new_ids_respect_cooldown_even_after_core_invocation_changes(self):
        self.send()
        with self.assertRaisesRegex(broker.Rejected, '60 seconds'):
            self.send(requestId='22222222-2222-4222-8222-222222222222', invocationId='b' * 32)
        self.now = self.monotonic = 160
        self.assertEqual(self.send(requestId='22222222-2222-4222-8222-222222222222',
                                   issuedAt=160000, expiresAt=165000)['outcome'], 'accepted')

    def test_timeout_is_unknown_and_cannot_replay_after_broker_restart(self):
        self.system.submit.side_effect = subprocess.TimeoutExpired('systemctl', 3)
        self.assertEqual(self.send()['outcome'], 'unknown')
        self.instance = broker.Broker(Path('/reviewed'), self.store, self.system,
                                      now=lambda: self.now, monotonic=lambda: self.monotonic)
        self.assertEqual(self.send()['outcome'], 'unknown')
        self.now = self.monotonic = 1000
        with self.assertRaisesRegex(broker.Rejected, 'unknown outcome'):
            self.send(requestId='22222222-2222-4222-8222-222222222222', issuedAt=1000000, expiresAt=1005000)
        self.assertEqual(self.system.submit.call_count, 1)

    def test_crash_receipt_is_unknown_without_reexecution(self):
        self.store.value = {'request': request(), 'outcome': 'submitting', 'message': 'Unconfirmed', 'monotonic': 99}
        self.assertEqual(self.send()['outcome'], 'unknown')
        self.system.submit.assert_not_called()

    def test_durable_write_failure_prevents_command(self):
        self.store.write = Mock(side_effect=OSError('disk full'))
        with self.assertRaises(OSError): self.send()
        self.system.submit.assert_not_called()

    def test_failed_outcome_write_leaves_attempt_unknown_without_replay(self):
        original_write = self.store.write
        def write(value):
            if value['outcome'] != 'submitting': raise OSError('receipt flush failed')
            original_write(value)
        self.store.write = write
        with self.assertRaises(OSError): self.send()
        self.assertEqual(self.store.value['outcome'], 'submitting')
        self.assertEqual(self.send()['outcome'], 'unknown')
        self.assertEqual(self.system.submit.call_count, 1)

    def test_freshness_checked_again_after_slow_authorization(self):
        def authorize(*_args): self.now += 3
        self.system.authorize.side_effect = authorize
        self.assertEqual(self.send()['outcome'], 'rejected')
        self.system.submit.assert_not_called()

    def test_changed_owner_before_submission_refuses_action(self):
        self.system.authorize.side_effect = [None, broker.Rejected('changed')]
        self.assertEqual(self.send()['outcome'], 'rejected')
        self.system.submit.assert_not_called()

    def test_lock_contention_and_unreadable_ledger_refuse_action(self):
        self.lock.side_effect = broker.Rejected('migration in progress')
        with self.assertRaises(broker.Rejected): self.send()
        self.system.submit.assert_not_called()
        self.lock.side_effect = None
        self.store.read = Mock(side_effect=ValueError('corrupt receipt'))
        with self.assertRaises(ValueError): self.send()
        self.system.submit.assert_not_called()

    def test_unconfirmed_result_is_unknown_without_an_update_fallback(self):
        self.system.submit.return_value = False
        self.assertEqual(self.send()['outcome'], 'unknown')
        self.system.submit.assert_called_once_with(broker.CORE)


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root/'111').mkdir()
        (self.root/'111/cgroup').write_text('1:name=systemd:/system.slice/sleepypod.service\n0::/other\n')
        self.system = broker.Systemd(1000, proc=self.root, units=self.root/'units')
        self.core = {'ActiveState': 'active', 'SubState': 'running', 'MainPID': '111',
                     'InvocationID': 'a' * 32, 'ControlGroup': '/system.slice/sleepypod.service',
                     'FragmentPath': str(self.root/'units'/broker.CORE), 'DropInPaths': '', 'Job': '', 'NoNewPrivileges': 'yes'}
        self.system.properties = Mock(side_effect=lambda unit: self.core if unit == broker.CORE
                                      else {**self.core, 'FragmentPath': str(self.root/'units'/unit)})
        patch.object(broker, 'regular_bytes', return_value=b'reviewed').start()
        self.addCleanup(patch.stopall)
        self.hashes = {unit: hashlib.sha256(b'reviewed').hexdigest() for unit in broker.PLAN_UNITS}

    def authorize(self, peer=(111, 1000, 1000)):
        self.system.authorize(peer, request(), self.hashes)

    def test_current_main_process_and_exact_cgroup_accepted(self):
        self.authorize()
        (self.root/'111/cgroup').write_text('0::/system.slice/sleepypod.service\n')
        self.authorize()

    def test_shared_user_is_not_enough(self):
        for peer in [(111, 0, 0), (222, 1000, 1000), (0, 1000, 1000)]:
            with self.subTest(peer=peer), self.assertRaises(broker.Rejected): self.authorize(peer)

    def test_changed_invocation_inactive_owner_or_privilege_policy_refused(self):
        for key, value in [('InvocationID', 'b' * 32), ('ActiveState', 'inactive'), ('SubState', 'stop-sigterm'),
                           ('MainPID', '0'), ('NoNewPrivileges', 'no'), ('ControlGroup', '')]:
            original = self.core[key]
            self.core[key] = value
            with self.subTest(key=key), self.assertRaises(broker.Rejected): self.authorize()
            self.core[key] = original

    def test_cgroup_child_prefix_does_not_impersonate_main_group(self):
        (self.root/'111/cgroup').write_text('1:name=systemd:/system.slice/sleepypod.service/child\n')
        with self.assertRaises(broker.Rejected): self.authorize()

    def test_reviewed_unit_ownership_override_and_pending_jobs(self):
        for key, value in [('FragmentPath', '/tmp/other'), ('DropInPaths', '/tmp/override.conf'), ('Job', '17')]:
            original = self.core[key]
            self.core[key] = value
            with self.subTest(key=key), self.assertRaises(broker.Rejected): self.authorize()
            self.core[key] = original
        self.hashes[broker.CORE] = 'a' * 64
        with self.assertRaises(broker.Rejected): self.authorize()

    def test_fixed_systemctl_commands_never_use_shell_or_start_inactive_core(self):
        for target in broker.TARGETS:
            with patch.object(broker.subprocess, 'run', return_value=Mock(returncode=0)) as run:
                self.assertTrue(self.system.submit(target))
                self.assertEqual(run.call_args.args[0], ['/bin/systemctl', '--no-block', '--job-mode=fail',
                                 'try-restart' if target == broker.CORE else 'restart', target])
                self.assertNotIn('shell', run.call_args.kwargs)

    def test_unconfirmed_systemctl_result_is_not_proof_of_rejection(self):
        with patch.object(broker.subprocess, 'run', return_value=Mock(returncode=1)):
            with self.assertRaises(RuntimeError): self.system.submit(broker.CORE)
        with patch.object(broker.subprocess, 'run') as run:
            with self.assertRaises(broker.Rejected): self.system.submit('--all')
            run.assert_not_called()

    def test_core_restart_also_refuses_changed_dependent_unit(self):
        self.hashes['sleepypod-calibrator.service'] = 'b' * 64
        with self.assertRaises(broker.Rejected): self.authorize()


class StorageTests(unittest.TestCase):
    def test_read_only_existing_lock_coordinates_without_creating_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            with self.assertRaises(FileNotFoundError):
                with broker.operation_lock(root, 'handoff.lock', owner=os.getuid(), create=False): pass
            lock = root/'handoff.lock'
            lock.write_text('existing lock')
            lock.chmod(0o400)
            with broker.operation_lock(root, 'handoff.lock', owner=os.getuid(), create=False):
                with self.assertRaises(broker.Rejected):
                    with broker.operation_lock(root, 'handoff.lock', owner=os.getuid(), create=False): pass
            self.assertEqual(lock.read_text(), 'existing lock')
            self.assertEqual(lock.stat().st_mode & 0o777, 0o400)

    def test_atomic_receipt_survives_new_store_and_refuses_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            store = broker.StateStore(root, owner=os.getuid())
            value = {'request': request(), 'outcome': 'submitting', 'message': 'Unconfirmed', 'monotonic': 17}
            store.write(value)
            self.assertEqual(broker.StateStore(root, owner=os.getuid()).read(), value)
            self.assertEqual(store.path.stat().st_mode & 0o777, 0o600)
            store.path.write_text('{broken')
            with self.assertRaises(ValueError): store.read()

    def test_symlink_receipt_and_shared_directory_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            store = broker.StateStore(root, owner=os.getuid())
            target = root/'other'
            target.write_text('{}')
            store.path.symlink_to(target)
            with self.assertRaises(OSError): store.read()
            root.chmod(0o755)
            with self.assertRaises(ValueError): broker.StateStore(root, owner=os.getuid())

    def test_lock_is_shared_and_not_followed_through_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            with broker.operation_lock(root, 'lock', owner=os.getuid()):
                with self.assertRaises(broker.Rejected):
                    with broker.operation_lock(root, 'lock', owner=os.getuid()): pass
            (root/'lock').unlink()
            (root/'lock').symlink_to(root/'other')
            with self.assertRaises(OSError):
                with broker.operation_lock(root, 'lock', owner=os.getuid()): pass


class FrameTests(unittest.TestCase):
    def test_peer_credentials_and_partial_reads_reach_broker(self):
        connection = Mock()
        payload = json.dumps(request()).encode() + b'\n'
        connection.recv.side_effect = [payload[:31], payload[31:]]
        connection.getsockopt.return_value = struct.pack('3i', 111, 1000, 1000)
        instance = Mock()
        instance.request.return_value = broker.response(request(), 'accepted', 'Requested')
        with patch.object(broker.socket, 'SO_PEERCRED', 17, create=True): broker.serve_connection(connection, instance)
        instance.request.assert_called_once_with(request(), (111, 1000, 1000))
        self.assertEqual(json.loads(connection.sendall.call_args.args[0])['outcome'], 'accepted')

    def test_oversized_truncated_multiple_or_invalid_frames_never_dispatch(self):
        for payload in [b'x'*1025, b'{}', b'{}\n{}\n', b'[]\n', b'{"a":1,"a":2}\n']:
            connection = Mock()
            connection.recv.side_effect = [payload, b'']
            connection.getsockopt.return_value = struct.pack('3i', 111, 1000, 1000)
            instance = Mock()
            with patch.object(broker.socket, 'SO_PEERCRED', 17, create=True): broker.serve_connection(connection, instance)
            instance.request.assert_not_called()


if __name__ == '__main__': unittest.main()
