import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import handoff
import maintenance_install
import maintenance_plan
import service_plan
import upgrade


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.data = self.root/'data'
        self.data.mkdir()
        with sqlite3.connect(self.data/'sleepypod.db') as database:
            database.execute('CREATE TABLE alarm_schedules (time TEXT, duration INTEGER)')
            database.execute("INSERT INTO alarm_schedules VALUES ('07:00', 20)")
            for name in ('device_settings', 'side_settings', 'power_schedules'):
                database.execute('CREATE TABLE ' + name + ' (id INTEGER)')
        (self.data/'homekit').mkdir()
        (self.data/'homekit'/'pairing.json').write_text('private pairing fixture')
        self.units = self.root/'units'
        self.units.mkdir()
        self.old = self.root/'old'
        self.new = self.root/'new'
        self.old_helpers = self.root/'old-helpers'
        self.new_helpers = self.root/'new-helpers'
        self.operation = self.root/'operation'
        self.operation.mkdir()
        for directory in (self.old, self.new, self.old_helpers, self.new_helpers):
            directory.mkdir()
        self.states = {}
        self.calls = []
        self.failed_start = False
        plans = []
        helpers = []
        for index, directory in enumerate((self.old, self.new)):
            config = {'release': str(self.root/('release-' + str(index))),
                      'data': str(self.data), 'environment': str(self.root/'environment')}
            units = {name: 'core version ' + str(index) + name for name in service_plan.CORE_UNITS}
            manifest = {'config': config, 'units': {name: hashlib.sha256(value.encode()).hexdigest() for name, value in units.items()}}
            for name, value in units.items(): (directory/name).write_text(value)
            plans.append(manifest)
        for index, directory in enumerate((self.old_helpers, self.new_helpers)):
            units = {name: 'helper version ' + str(index) + name for name in upgrade.HELPERS}
            manifest = {'controllerPlan': str((self.old, self.new)[index]),
                        'release': plans[index]['config']['release'],
                        'units': {name: hashlib.sha256(value.encode()).hexdigest() for name, value in units.items()}}
            for name, value in units.items(): (directory/name).write_text(value)
            helpers.append(manifest)
        self.plans, self.helpers = plans, helpers
        for name in (*service_plan.CORE_UNITS, *upgrade.HELPERS):
            parent = self.old if name in service_plan.CORE_UNITS else self.old_helpers
            (self.units/name).write_bytes((parent/name).read_bytes())
            self.states[name] = {'ActiveState': 'active', 'MainPID': '123', 'DropInPaths': '',
                                 'FragmentPath': str(self.units/name),
                                 'UnitFileState': 'enabled' if name in (service_plan.CORE_UNIT, maintenance_plan.SOCKET) else 'disabled'}
        self.saved = {'legacy': {name: {} for name in service_plan.LEGACY_UNITS}}
        self.active = {'phase': 'active', 'activeOwner': 'sleepypod-core'}
        (self.old/'activation.json').write_text(json.dumps(self.active))
        replacements = [
            (service_plan, 'read_plan', lambda path: plans[0 if path == self.old else 1]),
            (maintenance_plan, 'read_plan', lambda path: helpers[0 if path == self.old_helpers else 1]),
            (maintenance_install, 'secure_path', lambda *_args, **_kwargs: None),
            (maintenance_install, 'owned_bytes', lambda path, **_kwargs: path.read_bytes()),
            (maintenance_install, 'verify_release', lambda path: ('a' if path.name.endswith('0') else 'b') * 40),
            (handoff, 'UNIT_DIRECTORY', self.units),
            (handoff, 'unit_state', lambda name: self.states[name]),
            (handoff, 'systemctl', self.control),
            (handoff, 'read_owner_key', lambda _: 'secret-never-journaled'),
            (handoff, 'local_json', lambda *_: {'isPriming': False, 'leftSide': {'heatingDuration': 0}, 'rightSide': {'heatingDuration': 0}}),
            (handoff, 'core_observation', lambda *_: {'controller': {'revision': 'a'*40}}),
            (upgrade.activate, 'read_handoff', lambda *_: self.saved),
            (upgrade.activate, 'read_activation', lambda *_: self.active),
            (upgrade.activate, 'validate_legacy_definitions', lambda *_: None),
            (upgrade.activate, 'assert_ownership', lambda **_: None),
            (upgrade.activate, 'assert_boot_selection', lambda **_: None),
            (upgrade, 'start_and_verify', self.start),
        ]
        for module, name, value in replacements:
            context = patch.object(module, name, value)
            context.start()
            self.addCleanup(context.stop)

    def control(self, *arguments):
        self.calls.append(arguments)
        if arguments[0] == 'stop':
            for name in arguments[1:]:
                self.states[name].update(ActiveState='inactive', MainPID='0')
                if name == maintenance_plan.SOCKET:
                    self.states[name].pop('MainPID', None)

    def start(self, plan, _token, _revision, _seconds):
        self.calls.append(('start', service_plan.CORE_UNIT))
        if plan == self.plans[1] and self.failed_start:
            raise RuntimeError('candidate failed')
        return {'device': {'freshness': 'fresh'}}

    def apply(self):
        return upgrade.upgrade(self.operation, self.old, self.new, self.old_helpers, self.new_helpers)

    def assert_old_units(self):
        for name in service_plan.CORE_UNITS:
            self.assertEqual((self.units/name).read_bytes(), (self.old/name).read_bytes())

    def test_success_preserves_routines_pairings_and_never_starts_legacy(self):
        before = upgrade.inventory(self.data)
        record = self.apply()
        self.assertEqual(record['phase'], 'active')
        self.assertEqual(upgrade.inventory(self.data), before)
        self.assertEqual(upgrade.inventory(self.operation/'restore-rehearsal'), before)
        self.assertFalse(record['physicalOperationVerified'])
        self.assertNotIn('secret-never-journaled', (self.operation/'upgrade.json').read_text())
        self.assertTrue(all(not set(call) & set(service_plan.LEGACY_UNITS) for call in self.calls))
        self.assertEqual(json.loads((self.old/'activation.json').read_text())['phase'], 'superseded_by_upgrade')

    def test_failed_candidate_with_readable_schema_restores_database_and_units(self):
        original = self.start
        def start(plan, *arguments):
            if plan == self.plans[1]:
                with sqlite3.connect(self.data/'sleepypod.db') as database:
                    database.execute('ALTER TABLE alarm_schedules ADD COLUMN candidate_only TEXT')
                    database.execute("UPDATE alarm_schedules SET time='09:00'")
                (self.data/'homekit'/'pairing.json').write_text('changed candidate state')
                raise RuntimeError('failed after migration')
            return original(plan, *arguments)
        before = upgrade.inventory(self.data)
        with patch.object(upgrade, 'start_and_verify', start), self.assertRaisesRegex(RuntimeError, 'after migration'):
            self.apply()
        self.assertEqual(upgrade.inventory(self.data), before)
        self.assert_old_units()
        self.assertEqual(json.loads((self.operation/'upgrade.json').read_text())['phase'], 'rolled_back')
        self.assertEqual(len(list(self.operation.glob('replaced-data-*'))), 1)

    def test_incomplete_candidate_schema_requires_recovery_without_erasing_current_data(self):
        def start(plan, *_):
            if plan == self.plans[1]:
                with sqlite3.connect(self.data/'sleepypod.db') as database:
                    database.execute('DROP TABLE alarm_schedules')
                raise RuntimeError('candidate left incomplete schema')
            self.fail('Must not restart an old runtime against an unknown household boundary')
        with patch.object(upgrade, 'start_and_verify', start), self.assertRaisesRegex(ValueError, 'incomplete or corrupt'):
            self.apply()
        self.assertEqual(json.loads((self.operation/'upgrade.json').read_text())['phase'], 'recovery_required')
        self.assertFalse(list(self.operation.glob('replaced-data-*')))
        self.assertTrue((self.operation/'data-backup'/'sleepypod.db').is_file())

    def test_changed_routines_reject_candidate(self):
        def start(plan, *_):
            if plan == self.plans[1]:
                with sqlite3.connect(self.data/'sleepypod.db') as database:
                    database.execute("UPDATE alarm_schedules SET time='08:00'")
            return {}
        with patch.object(upgrade, 'start_and_verify', start), self.assertRaisesRegex(RuntimeError, 'saved routine'):
            self.apply()
        self.assert_old_units()

    def test_live_heat_rejects_before_stopping_anything(self):
        with patch.object(handoff, 'require_thermal_idle', side_effect=RuntimeError('not idle')):
            with self.assertRaisesRegex(RuntimeError, 'not idle'): self.apply()
        self.assertEqual(self.calls, [])

    def test_modified_unit_rejects_before_stopping_anything(self):
        (self.units/service_plan.CORE_UNIT).write_text('foreign service')
        with self.assertRaisesRegex(ValueError, 'Unrecognized'): self.apply()
        self.assertEqual(self.calls, [])

    def test_changed_data_path_rejected(self):
        self.plans[1]['config']['data'] = str(self.root/'other')
        with self.assertRaisesRegex(ValueError, 'only the release'): self.apply()
        self.assertEqual(self.calls, [])

    def test_sensor_source_update_is_verified_and_rolls_back_with_units(self):
        self.plans[0]['config']['modules'] = str(self.root/'old-sensors')
        self.plans[1]['config']['modules'] = str(self.root/'new-sensors')
        self.failed_start = True
        with patch.object(upgrade.stage_sensors, 'verify') as verify:
            with self.assertRaisesRegex(RuntimeError, 'candidate failed'):
                self.apply()
        verify.assert_called_once_with(self.root/'old-sensors', self.root/'new-sensors', self.root/'release-1')
        self.assert_old_units()
        self.assertEqual(json.loads((self.operation/'upgrade.json').read_text())['phase'], 'rolled_back')

    def test_unverified_sensor_source_rejects_before_stopping_anything(self):
        self.plans[0]['config']['modules'] = str(self.root/'old-sensors')
        self.plans[1]['config']['modules'] = str(self.root/'new-sensors')
        with patch.object(upgrade.stage_sensors, 'verify', side_effect=ValueError('sensor mismatch')):
            with self.assertRaisesRegex(ValueError, 'sensor mismatch'):
                self.apply()
        self.assertEqual(self.calls, [])

    def test_existing_candidate_record_rejected(self):
        (self.new/'activation.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'installation record'): self.apply()
        self.assertEqual(self.calls, [])

    def test_backup_failure_restarts_previous_release_without_replacing_data(self):
        with patch.object(upgrade, 'copy_data', side_effect=OSError('disk failure')):
            with self.assertRaisesRegex(OSError, 'disk failure'): self.apply()
        self.assert_old_units()
        self.assertEqual(json.loads((self.operation/'upgrade.json').read_text())['phase'], 'rolled_back')

    def test_corrupt_rollback_copy_stops_and_requires_recovery(self):
        def start(plan, *_):
            if plan == self.plans[1]:
                (self.operation/'data-backup'/'homekit'/'pairing.json').write_text('tampered')
                raise RuntimeError('failed candidate')
            return {}
        with patch.object(upgrade, 'start_and_verify', start), self.assertRaisesRegex(ValueError, 'backup changed'):
            self.apply()
        self.assertEqual(json.loads((self.operation/'upgrade.json').read_text())['phase'], 'recovery_required')

    def test_backup_rejects_symlinks(self):
        (self.data/'link').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, 'Unexpected backup entry'):
            upgrade.copy_data(self.data, self.root/'unsafe-backup')
        self.assertFalse((self.root/'unsafe-backup').exists())

    def test_rollback_after_success_retains_previous_core_identity(self):
        record = self.apply()
        details = upgrade.context(self.old, self.new, self.old_helpers, self.new_helpers)
        upgrade.restore(self.operation, details, record)
        self.assert_old_units()
        self.assertEqual(json.loads((self.old/'activation.json').read_text())['phase'], 'active')
        self.assertEqual(json.loads((self.new/'activation.json').read_text())['phase'], 'rolled_back_to_previous_core')

    def add_personal_draft(self, directory=None):
        with sqlite3.connect((directory or self.data)/'sleepypod.db') as database:
            database.execute('CREATE TABLE household_personal_settings (draft TEXT)')
            database.execute("INSERT INTO household_personal_settings VALUES ('private-fixture')")

    def test_personal_preparation_blocks_update_before_any_service_or_file_change(self):
        self.add_personal_draft()
        original = upgrade.inventory(self.data)
        with self.assertRaisesRegex(ValueError, 'qualified recovery'): self.apply()
        self.assertEqual(self.calls, [])
        self.assertEqual(upgrade.inventory(self.data), original)
        self.assertFalse((self.operation/'upgrade.json').exists())

    def test_join_during_quiescence_is_preserved_and_old_runtime_is_not_restarted(self):
        original_stop = handoff.stop_units
        def stop(names):
            original_stop(names)
            self.add_personal_draft()
        with patch.object(handoff, 'stop_units', side_effect=stop), self.assertRaisesRegex(ValueError, 'qualified recovery'):
            self.apply()
        self.assertEqual(json.loads((self.operation/'upgrade.json').read_text())['phase'], 'recovery_required')
        self.assertFalse((self.operation/'data-backup').exists())
        self.assertFalse(any(call[0] == 'start' for call in self.calls))
        self.assert_old_units()
        with sqlite3.connect(self.data/'sleepypod.db') as database:
            self.assertEqual(database.execute('SELECT draft FROM household_personal_settings').fetchone(), ('private-fixture',))

    def test_candidate_personal_write_is_not_erased_by_automatic_rollback(self):
        def start(plan, *_):
            if plan == self.plans[1]:
                self.add_personal_draft()
                raise RuntimeError('candidate failed after personal write')
            self.fail('Must not restart a legacy runtime with personal data')
        with patch.object(upgrade, 'start_and_verify', start), self.assertRaisesRegex(ValueError, 'qualified recovery'):
            self.apply()
        self.assertEqual(json.loads((self.operation/'upgrade.json').read_text())['phase'], 'recovery_required')
        self.assertFalse(list(self.operation.glob('replaced-data-*')))
        with sqlite3.connect(self.data/'sleepypod.db') as database:
            self.assertEqual(database.execute('SELECT count(*) FROM household_personal_settings').fetchone(), (1,))

    def test_manual_rollback_preserves_later_personal_data_without_stopping_current_services(self):
        record = self.apply()
        self.add_personal_draft()
        original = upgrade.inventory(self.data)
        self.calls.clear()
        with self.assertRaisesRegex(ValueError, 'qualified recovery'):
            upgrade.restore(self.operation, upgrade.context(self.old, self.new, self.old_helpers, self.new_helpers), record)
        self.assertEqual(self.calls, [])
        self.assertEqual(upgrade.inventory(self.data), original)
        self.assertFalse(list(self.operation.glob('replaced-data-*')))

    def test_personal_backup_is_not_restored_over_an_empty_current_household(self):
        record = self.apply()
        self.add_personal_draft(self.operation/'data-backup')
        # A valid checksum is not evidence that restoring private records is safe.
        record['backupInventory'] = upgrade.inventory(self.operation/'data-backup')
        self.calls.clear()
        with self.assertRaisesRegex(ValueError, 'qualified recovery'):
            upgrade.restore(self.operation, upgrade.context(self.old, self.new, self.old_helpers, self.new_helpers), record)
        self.assertEqual(self.calls, [])

    def test_manual_rollback_rechecks_after_stopping_writers(self):
        record = self.apply()
        original_stop = handoff.stop_units
        def stop(names):
            original_stop(names)
            self.add_personal_draft()
        with patch.object(handoff, 'stop_units', side_effect=stop), self.assertRaisesRegex(ValueError, 'qualified recovery'):
            upgrade.restore(self.operation, upgrade.context(self.old, self.new, self.old_helpers, self.new_helpers), record)
        self.assertEqual(json.loads((self.operation/'upgrade.json').read_text())['phase'], 'recovery_required')
        self.assertFalse(list(self.operation.glob('replaced-data-*')))


if __name__ == '__main__': unittest.main()
