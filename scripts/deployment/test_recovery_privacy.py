from pathlib import Path
import sqlite3
import tempfile
import unittest

from recovery_privacy import require_legacy_recovery_data, REQUIRED_TABLES


class RecoveryPrivacyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.path = self.directory/'sleepypod.db'
        self.database = sqlite3.connect(self.path)
        self.addCleanup(self.database.close)
        for name in REQUIRED_TABLES:
            self.database.execute('CREATE TABLE ' + name + ' (id INTEGER)')
        self.database.commit()

    def test_empty_migrated_schema_and_legacy_browser_session_allow_recovery(self):
        self.database.executescript('CREATE TABLE households (id TEXT); CREATE TABLE household_accounts (id TEXT); '
            'CREATE TABLE household_privacy_boundary (id INTEGER); CREATE TABLE household_browser_scopes (scope TEXT); '
            "INSERT INTO household_browser_scopes VALUES ('owner-cookie-fixture');")
        original = self.path.read_bytes()
        require_legacy_recovery_data(self.directory)
        self.assertEqual(self.path.read_bytes(), original)

    def test_all_personal_state_including_unassigned_or_revoked_preparation_blocks(self):
        for table in ('households', 'household_accounts', 'household_personal_settings', 'household_devices',
                      'household_attribution_epochs', 'household_person_records', 'household_privacy_boundary',
                      'household_arrangement_reviews', 'household_future_feature', 'household_"quoted'):
            quoted = '"' + table.replace('"', '""') + '"'
            self.database.execute('CREATE TABLE ' + quoted + ' (value TEXT)')
            self.database.execute('INSERT INTO ' + quoted + ' VALUES (?)', ('private-fixture-never-log',))
            self.database.commit()
            with self.subTest(table=table), self.assertRaisesRegex(ValueError, 'qualified recovery') as failure:
                require_legacy_recovery_data(self.directory)
            self.assertNotIn('private-fixture', str(failure.exception))
            self.database.execute('DROP TABLE ' + quoted)
            self.database.commit()

    def test_reads_committed_wal_without_checkpointing_or_waiting_for_process_exit(self):
        self.database.execute('PRAGMA journal_mode=WAL')
        self.database.execute('PRAGMA wal_autocheckpoint=0')
        self.database.executescript("CREATE TABLE household_accounts (id TEXT); INSERT INTO household_accounts VALUES ('private');")
        original = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'qualified recovery'): require_legacy_recovery_data(self.directory)
        self.assertEqual(self.path.read_bytes(), original)

    def test_missing_corrupt_or_locked_database_never_counts_as_no_accounts(self):
        for name in ('missing', 'corrupt'):
            directory = self.directory/name
            directory.mkdir()
            if name == 'corrupt': (directory/'sleepypod.db').write_bytes(b'not sqlite')
            with self.assertRaisesRegex(ValueError, 'Cannot verify'): require_legacy_recovery_data(directory)
        self.database.execute('BEGIN EXCLUSIVE')
        with self.assertRaisesRegex(ValueError, 'Cannot verify'): require_legacy_recovery_data(self.directory)
        self.database.rollback()

    def test_an_empty_or_partial_database_cannot_authorize_recovery(self):
        empty = self.directory/'empty'
        empty.mkdir()
        with sqlite3.connect(empty/'sleepypod.db'): pass
        with self.assertRaisesRegex(ValueError, 'incomplete or corrupt'):
            require_legacy_recovery_data(empty)
        self.database.execute('DROP TABLE device_settings')
        self.database.commit()
        with self.assertRaisesRegex(ValueError, 'incomplete or corrupt'):
            require_legacy_recovery_data(self.directory)

    def test_symlinked_database_directory_and_sidecars_are_refused(self):
        alias = self.directory/'alias'
        alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(ValueError): require_legacy_recovery_data(alias)
        for name in ('-wal', '-shm', '-journal'):
            link = self.path.with_name(self.path.name + name)
            link.symlink_to(self.directory/'missing-private-file')
            with self.assertRaises(ValueError): require_legacy_recovery_data(self.directory)
            link.unlink()
        self.database.close()
        self.path.unlink()
        self.path.symlink_to(self.directory/'missing-private-file')
        with self.assertRaises(ValueError): require_legacy_recovery_data(self.directory)


if __name__ == '__main__': unittest.main()
