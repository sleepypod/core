import json
import unittest
from unittest.mock import patch

import handoff
import replace_plan
import service_plan
import test_handoff

CONFIG = test_handoff.CONFIG


class ReplacementTests(unittest.TestCase):
    setUp = test_handoff.HandoffTests.setUp
    control = test_handoff.HandoffTests.control

    def prepare_replacement(self):
        handoff.install(self.directory)
        self.replacement = self.root / 'replacement'
        self.new_plan = service_plan.prepare({**CONFIG, 'release': '/persistent/sleepypod-unified/releases/def5678'}, self.replacement)
        self.calls.clear()

    def test_replaces_only_reviewed_stopped_units_without_starting_or_enabling(self):
        self.prepare_replacement()
        result = replace_plan.replace_plan(self.directory, self.replacement)
        self.assertEqual(result['phase'], 'installed_not_started')
        self.assertEqual(result['unitHashes'], self.new_plan['units'])
        self.assertEqual(self.calls, [('daemon-reload',)])
        self.assertFalse(result['bootSelectionChanged'])
        handoff.validate_installed(self.new_plan)
        self.assertEqual(json.loads((self.directory / 'handoff.json').read_text())['unitHashes'], self.plan['units'])

    def test_rejects_running_or_enabled_core_and_unavailable_legacy(self):
        self.prepare_replacement()
        for name, field, value in [('sleepypod.service', 'ActiveState', 'active'),
                                   ('sleepypod-calibrator.service', 'UnitFileState', 'enabled'),
                                   ('free-sleep.service', 'MainPID', '0')]:
            original = self.states[name][field]
            self.states[name][field] = value
            with self.assertRaises(ValueError):
                replace_plan.replace_plan(self.directory, self.replacement)
            self.states[name][field] = original
        self.assertEqual(self.calls, [])
        self.assertFalse((self.replacement / 'handoff.json').exists())

    def test_rejects_data_changes_and_unrelated_unit_changes(self):
        self.prepare_replacement()
        changed = self.root / 'changed-data'
        service_plan.prepare({**CONFIG, 'data': '/persistent/sleepypod-unified/different-data'}, changed)
        with self.assertRaisesRegex(ValueError, 'cannot change data'):
            replace_plan.replace_plan(self.directory, changed)
        (self.unit_directory / 'sleepypod.service').write_text('unrelated')
        with self.assertRaisesRegex(ValueError, 'changed'):
            replace_plan.replace_plan(self.directory, self.replacement)
        self.assertEqual(self.calls, [])

    def test_partial_failure_restores_original_bytes_and_keeps_legacy_running(self):
        self.prepare_replacement()
        original = replace_plan.replace_unit
        failed = False

        def fail_once(path, content):
            nonlocal failed
            if path.name == 'sleepypod-piezo-processor.service' and not failed:
                failed = True
                raise OSError('simulated disk failure')
            original(path, content)

        with patch.object(replace_plan, 'replace_unit', side_effect=fail_once):
            with self.assertRaisesRegex(OSError, 'simulated'):
                replace_plan.replace_plan(self.directory, self.replacement)
        handoff.validate_installed(self.plan)
        self.assertEqual(self.calls, [('daemon-reload',)])
        self.assertEqual(json.loads((self.replacement / 'handoff.json').read_text())['phase'], 'replacement_failed_previous_restored')

    def test_preserves_a_unit_modified_during_replacement(self):
        self.prepare_replacement()
        original = replace_plan.replace_unit

        def replace_then_change(path, content):
            original(path, content)
            path.write_text('external edit')
            raise OSError('interrupted')

        with patch.object(replace_plan, 'replace_unit', side_effect=replace_then_change):
            with self.assertRaisesRegex(RuntimeError, 'needs review'):
                replace_plan.replace_plan(self.directory, self.replacement)
        self.assertEqual((self.unit_directory / 'sleepypod.service').read_text(), 'external edit')
        self.assertEqual(self.calls, [])

    def test_bound_maintenance_helper_must_be_removed_before_new_controller_plan(self):
        self.prepare_replacement()
        target = self.root/'with-maintenance'
        service_plan.prepare({**CONFIG, 'release': '/persistent/sleepypod-unified/releases/def5678',
                              'maintenanceSocket': service_plan.MAINTENANCE_SOCKET}, target)
        names = (replace_plan.MAINTENANCE_SOCKET, replace_plan.MAINTENANCE_SERVICE)
        for name in names: self.states[name] = {'LoadState': 'not-found'}
        self.states[names[0]]['LoadState'] = 'loaded'
        with self.assertRaisesRegex(ValueError, 'bound maintenance'):
            replace_plan.replace_plan(self.directory, target)
        self.assertFalse((target/'handoff.json').exists())
        self.assertEqual(self.calls, [])
        self.states[names[0]]['LoadState'] = 'not-found'
        self.assertEqual(replace_plan.replace_plan(self.directory, target)['phase'], 'installed_not_started')
