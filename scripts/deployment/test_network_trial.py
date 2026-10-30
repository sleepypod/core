import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import network_trial as trial


class FirewallMachine:
    """Model kernel tables, retaining unrelated rules while faulting chosen operations."""
    def __init__(self):
        self.tables = {binary: [['-P', 'INPUT', 'ACCEPT'], ['-P', 'OUTPUT', 'ACCEPT'],
                               ['-A', 'OUTPUT', '-d', '203.0.113.1/32', '-j', 'DROP']]
                       for binary in trial.FIREWALLS}
        self.original = {binary: [list(rule) for rule in rules] for binary, rules in self.tables.items()}
        self.calls = []
        self.timer = False
        self.fail = lambda _command: False
        self.route = [{'dst': '10.0.1.68', 'dev': 'wlan0', 'prefsrc': '10.0.1.69'}]
        self.on_mutation = lambda: None

    def run(self, command, check=True):
        self.calls.append(command)
        if self.fail(command):
            raise RuntimeError('Injected command failure')
        binary, *arguments = command
        output = ''
        if binary in trial.FIREWALLS:
            arguments = arguments[2:]  # -w 2
            action, *rest = arguments
            rules = self.tables[binary]
            if action == '-S':
                output = '\n'.join(' '.join(rule) for rule in rules)
            else:
                self.on_mutation()
                if action == '-N':
                    rules.append(['-N', *rest])
                elif action == '-A':
                    rules.append(['-A', *rest])
                elif action == '-I':
                    rules.insert(0, ['-A', rest[0], *rest[2:]])
                elif action == '-D':
                    rules.remove(['-A', *rest])
                elif action == '-F':
                    self.tables[binary] = [rule for rule in rules if rule[:2] != ['-A', rest[0]]]
                elif action == '-X':
                    rules.remove(['-N', *rest])
                else:
                    raise AssertionError(command)
        elif binary == trial.ROUTE:
            output = json.dumps(self.route)
        elif binary == trial.SYSTEMD_RUN:
            self.timer = True
        elif binary == trial.SYSTEMCTL:
            if arguments[0] == 'is-active' and arguments[-1].endswith('.timer'):
                if not self.timer:
                    raise RuntimeError('Timer is not active')
            elif arguments[0] == 'stop':
                self.timer = False
        else:
            raise AssertionError(command)
        return subprocess.CompletedProcess(command, 0, stdout=output, stderr='')


class NetworkTrialTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.script = self.root / 'network_trial.py'
        self.script.write_text('reviewed fixture')
        self.boot = self.root / 'boot-id'
        self.boot.write_text('fixture-boot')
        self.machine = FirewallMachine()
        for target, value in [('STATE_ROOT', self.root / 'state'), ('BOOT_ID', self.boot),
                              ('secure_path', lambda *_args, **_kwargs: None), ('run', self.machine.run)]:
            context = patch.object(trial, target, value)
            context.start()
            self.addCleanup(context.stop)
        for context in [patch.dict(os.environ, {'SSH_CONNECTION': '10.0.1.68 55000 10.0.1.69 8822'}),
                        patch.object(trial.os, 'geteuid', return_value=0), patch.object(trial.os, 'access', return_value=True)]:
            context.start()
            self.addCleanup(context.stop)

    def apply(self, seconds=180):
        return trial.apply('10.0.1.68', seconds, self.script)

    def test_preflight_is_read_only_and_requires_both_families(self):
        result = trial.preflight('10.0.1.68', self.script)
        self.assertEqual(set(result['firewalls']), {'iptables', 'ip6tables'})
        self.assertEqual(self.machine.tables, self.machine.original)
        self.assertFalse(trial.STATE_ROOT.exists())
        self.machine.fail = lambda command: command[0] == trial.FIREWALLS[1]
        with self.assertRaisesRegex(RuntimeError, 'Injected'):
            self.apply()
        self.assertFalse(self.machine.timer)
        self.assertEqual(self.machine.tables, self.machine.original)

    def test_apply_arms_recovery_and_persists_intent_before_first_rule(self):
        def assert_recovery():
            self.assertTrue(self.machine.timer)
            self.assertEqual(trial.read_record()['phase'], 'armed')
        self.machine.on_mutation = assert_recovery
        record = self.apply()
        self.machine.on_mutation = lambda: None
        self.assertEqual(record['phase'], 'isolated')
        self.assertFalse(record['physicalOperationVerified'])
        for rules in self.machine.tables.values():
            self.assertEqual(sum(rule[:1] == ['-N'] for rule in rules), 2)
        self.assertEqual(trial.recover(record['id'])['phase'], 'restored')
        self.assertEqual(self.machine.tables, self.machine.original)
        self.assertFalse(self.machine.timer)
        self.assertEqual(trial.recover(record['id'])['phase'], 'restored')

    def test_timer_creation_or_verification_failure_never_changes_rules(self):
        for failure in [lambda command: command[0] == trial.SYSTEMD_RUN,
                        lambda command: command[0] == trial.SYSTEMCTL and command[-1].endswith('.timer') and command[1] == 'is-active']:
            self.machine.fail = failure
            with self.assertRaisesRegex(RuntimeError, 'Injected'):
                self.apply()
            self.assertEqual(self.machine.tables, self.machine.original)
            self.assertFalse(any(command[0] in trial.FIREWALLS and '-N' in command for command in self.machine.calls))

    def test_partial_ipv6_failure_recovers_ipv4_and_ipv6(self):
        self.machine.fail = lambda command: command[0] == trial.FIREWALLS[1] and '-I' in command
        with self.assertRaisesRegex(RuntimeError, 'Injected'):
            self.apply()
        self.assertEqual(self.machine.tables, self.machine.original)
        self.assertEqual(trial.read_record()['phase'], 'restored')

    def test_transient_cleanup_failure_keeps_recovery_available_for_retry(self):
        record = self.apply()
        self.machine.fail = lambda command: '-D' in command
        with self.assertRaisesRegex(RuntimeError, 'Recovery incomplete'):
            trial.recover(record['id'])
        self.assertTrue(self.machine.timer)
        self.assertEqual(trial.read_record()['phase'], 'restore_failed')
        self.machine.fail = lambda _command: False
        trial.recover(record['id'])
        self.assertEqual(self.machine.tables, self.machine.original)

    def test_duplicate_start_and_wrong_recovery_id_leave_active_trial_unchanged(self):
        record = self.apply()
        before = json.dumps(self.machine.tables)
        with self.assertRaisesRegex(ValueError, 'unfinished'):
            self.apply()
        with self.assertRaisesRegex(ValueError, 'does not match'):
            trial.recover('0' * 32)
        self.assertEqual(json.dumps(self.machine.tables), before)
        trial.recover(record['id'])

    def test_foreign_rule_is_detached_but_never_flushed(self):
        record = self.apply()
        plan = trial.plans('10.0.1.68', record['id'])[0]
        foreign = ['-A', plan['chain'], '-j', 'ACCEPT']
        self.machine.tables[plan['binary']].append(foreign)
        with self.assertRaisesRegex(RuntimeError, 'Foreign rules'):
            trial.recover(record['id'])
        self.assertIn(foreign, self.machine.tables[plan['binary']])
        self.assertFalse(any('sleepypod-trial-' + record['id'] in rule for rules in self.machine.tables.values() for rule in rules))

    def test_private_peer_route_and_recovery_port_required(self):
        for address in ['127.0.0.1', '8.8.8.8', '100.64.0.1', '::1', '10.0.1.71']:
            with self.assertRaises(ValueError):
                trial.preflight(address, self.script)
        self.machine.route[0]['gateway'] = '10.0.1.1'
        with self.assertRaisesRegex(ValueError, 'direct LAN'):
            self.apply()
        self.assertFalse(self.machine.timer)

    def test_out_of_range_duration_rejected_without_state_or_commands(self):
        for seconds in [-1, 0, 119, 301, 86400]:
            with self.assertRaises(ValueError):
                self.apply(seconds)
        self.assertFalse(trial.STATE_ROOT.exists())
        self.assertEqual(self.machine.calls, [])

    def test_rule_policy_does_not_allow_established_remote_sessions_or_ipv6_bypass(self):
        configuration = trial.plans('10.0.1.68', '1' * 32)
        for plan in configuration:
            self.assertEqual(plan['rules'][-1], ['-j', 'DROP'])
            self.assertNotIn('ESTABLISHED', json.dumps(plan))
            if plan['binary'] == trial.FIREWALLS[1]:
                self.assertEqual(len(plan['rules']), 2)  # loopback, then drop
            else:
                self.assertIn('10.0.1.68/32', plan['rules'][1])
                self.assertIn('8822,3000,3001', plan['rules'][1])

    def test_timer_uses_pinned_script_and_independent_retrying_system_service(self):
        record = self.apply()
        command = next(command for command in self.machine.calls if command[0] == trial.SYSTEMD_RUN)
        self.assertIn('--on-active=180s', command)
        self.assertIn('--property=Restart=on-failure', command)
        self.assertIn('--property=StartLimitIntervalSec=0', command)
        self.assertEqual(command[-5:], ['-B', str(self.script), 'recover', '--trial-id', record['id']])

    def test_recovery_rehearsal_never_installs_isolation_rules(self):
        record = trial.rehearse('10.0.1.68', self.script)
        self.assertEqual(record['phase'], 'rehearsal')
        self.assertTrue(self.machine.timer)
        self.assertEqual(self.machine.tables, self.machine.original)
        trial.recover(record['id'])
        self.assertEqual(self.machine.tables, self.machine.original)
        self.assertFalse(any(command[0] in trial.FIREWALLS and '-N' in command for command in self.machine.calls))

    def test_arming_failure_before_unit_creation_can_still_be_recovered(self):
        original = self.machine.run
        def missing_timer(command, check=True):
            if command[0] == trial.SYSTEMD_RUN:
                raise RuntimeError('Arming failed before unit creation')
            if command[:2] == [trial.SYSTEMCTL, 'stop']:
                return subprocess.CompletedProcess(command, 5, stdout='', stderr='Unit not loaded')
            if command[:2] == [trial.SYSTEMCTL, 'show']:
                return subprocess.CompletedProcess(command, 4, stdout='not-found\n', stderr='')
            return original(command, check=check)
        with patch.object(trial, 'run', missing_timer), self.assertRaisesRegex(RuntimeError, 'Arming failed'):
            self.apply()
        self.assertEqual(trial.read_record()['phase'], 'restored')
        self.assertEqual(self.machine.tables, self.machine.original)

    def test_unconfirmed_timer_stop_prevents_reusing_the_trial(self):
        record = self.apply()
        original = self.machine.run
        def stop_failure(command, check=True):
            if command[:2] == [trial.SYSTEMCTL, 'stop']:
                return subprocess.CompletedProcess(command, 1, stdout='', stderr='Manager unavailable')
            if command[:2] == [trial.SYSTEMCTL, 'show']:
                return subprocess.CompletedProcess(command, 1, stdout='', stderr='Manager unavailable')
            return original(command, check=check)
        with patch.object(trial, 'run', stop_failure), self.assertRaisesRegex(RuntimeError, 'timer stopped'):
            trial.recover(record['id'])
        self.assertEqual(trial.read_record()['phase'], 'restore_failed')
        with self.assertRaisesRegex(ValueError, 'unfinished'):
            self.apply()
        trial.recover(record['id'])


class SecurePathTests(unittest.TestCase):
    def test_recovery_rejects_symlink_and_user_writable_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'script').write_text('fixture')
            (root / 'linked').symlink_to(root / 'script')
            for path in [root / 'linked', root / 'script']:
                with self.assertRaises(ValueError):
                    trial.secure_path(path)


if __name__ == '__main__':
    unittest.main()
