import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import maintenance_install
import service_plan
import stage_sensors


class SensorStagingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.old = self.root/'sensors/old/modules'
        self.new = self.root/'sensors/new/modules'
        self.release = self.root/'release'
        for path in (self.old, self.new.parent, self.release):
            path.mkdir(parents=True)
        self.files = {'common/calibration_identity.py': b'new shared source'}
        for name in service_plan.MODULES:
            folder = self.old/name
            (folder/'.venv/bin').mkdir(parents=True)
            (folder/'.venv/bin/python').write_bytes(b'interpreter fixture, never executed')
            (folder/'main.py').write_bytes(b'old source')
            for filename in ('pyproject.toml', 'uv.lock'):
                (folder/filename).write_bytes(b'locked fixture')
                self.files[name+'/'+filename] = b'locked fixture'
            self.files[name+'/main.py'] = b'new source'
        self.write_archive()
        for module, name, value in (
            (maintenance_install, 'ROOT', self.root),
            (maintenance_install, 'OWNER_UID', os.getuid()),
            (maintenance_install, 'secure_path', lambda *_args, **_kwargs: None),
            (maintenance_install, 'verify_release', lambda *_: 'a'*40),
        ):
            context = patch.object(module, name, value)
            context.start()
            self.addCleanup(context.stop)

    def write_archive(self, extra=None):
        archive = self.release/'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as target:
            for name, contents in self.files.items():
                member = tarfile.TarInfo('modules/'+name)
                member.size = len(contents)
                target.addfile(member, io.BytesIO(contents))
            if extra:
                target.addfile(extra)
        (self.release/'bundle-manifest.json').write_text(json.dumps({
            'sourceSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        }))

    def prepare(self):
        return stage_sensors.prepare(self.old, self.new, self.release)

    def test_staging_preserves_old_source_and_reuses_exact_environments(self):
        result = self.prepare()
        self.assertFalse(result['servicesStarted'])
        self.assertEqual(result['verifiedSourceFiles'], len(self.files))
        for name in service_plan.MODULES:
            self.assertEqual((self.old/name/'main.py').read_bytes(), b'old source')
            self.assertEqual((self.new/name/'main.py').read_bytes(), b'new source')
            self.assertEqual(os.readlink(self.new/name/'.venv'), str(self.old/name/'.venv'))
        self.assertEqual(stage_sensors.verify(self.old, self.new, self.release), result)

    def test_chained_source_releases_keep_the_original_runtime(self):
        self.prepare()
        candidate = self.root/'sensors/third/modules'
        candidate.parent.mkdir()
        stage_sensors.prepare(self.new, candidate, self.release)
        self.assertEqual(os.readlink(candidate/'sleep-detector/.venv'), str(self.old/'sleep-detector/.venv'))

    def test_dependency_change_rejects_before_creating_destination(self):
        (self.old/'sleep-detector/uv.lock').write_bytes(b'other dependencies')
        with self.assertRaisesRegex(ValueError, 'dependencies changed'):
            self.prepare()
        self.assertFalse(self.new.exists())

    def test_changed_source_or_extra_entries_fail_verification(self):
        self.prepare()
        path = self.new/'sleep-detector/main.py'
        path.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'differs from release'):
            stage_sensors.verify(self.old, self.new, self.release)
        path.write_bytes(b'new source')
        (self.new/'injected.py').write_bytes(b'extra')
        with self.assertRaisesRegex(ValueError, 'membership changed'):
            stage_sensors.verify(self.old, self.new, self.release)

    def test_runtime_link_cannot_be_redirected(self):
        self.prepare()
        link = self.new/'sleep-detector/.venv'
        link.unlink()
        link.symlink_to(self.old/'calibrator/.venv')
        with self.assertRaisesRegex(ValueError, 'link changed'):
            stage_sensors.verify(self.old, self.new, self.release)

    def test_archive_checksum_is_required(self):
        (self.release/'source.tar.gz').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.prepare()
        self.assertFalse(self.new.exists())

    def test_archive_traversal_and_links_are_refused(self):
        for name, kind in [('modules/../escape', tarfile.REGTYPE), ('modules/common/link', tarfile.SYMTYPE)]:
            with self.subTest(name=name):
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
                self.write_archive(member)
                with self.assertRaises(ValueError):
                    self.prepare()
                self.assertFalse(self.new.exists())

    def test_no_overwrite_and_no_unmanaged_destination(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, 'must be new'):
            self.prepare()
        with self.assertRaisesRegex(ValueError, 'overwrite active'):
            stage_sensors.prepare(self.old, self.old, self.release)
        with self.assertRaisesRegex(ValueError, 'managed sensor'):
            stage_sensors.prepare(self.old, self.root/'arbitrary/modules', self.release)

    def test_failed_final_verification_removes_only_candidate_source(self):
        with patch.object(stage_sensors, 'verify', side_effect=ValueError('probe failed')):
            with self.assertRaisesRegex(ValueError, 'probe failed'):
                self.prepare()
        self.assertFalse(self.new.exists())
        self.assertTrue((self.old/'sleep-detector/.venv/bin/python').is_file())


if __name__ == '__main__':
    unittest.main()
