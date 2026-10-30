import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare_offline', Path(__file__).with_name('prepare_offline.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class OfflineBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def archive(self, members):
        archive = self.root / 'fixture.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            for name, content, link in members:
                member = tarfile.TarInfo(name)
                if link is not None:
                    member.type = tarfile.SYMTYPE
                    member.linkname = link
                    output.addfile(member)
                else:
                    member.size = len(content)
                    output.addfile(member, io.BytesIO(content))
        return archive

    def test_extract_preserves_safe_relative_links(self):
        archive = self.archive([('build/bin/node', b'binary', None), ('build/bin/link', b'', 'node')])
        destination = self.root / 'expanded'
        destination.mkdir()
        release.extract_verified(archive, destination, 'build')
        self.assertEqual((destination / 'build/bin/link').read_bytes(), b'binary')

    def test_rejects_traversal_escaping_links_duplicates_and_link_children(self):
        cases = [
            [('build/../outside', b'data', None)],
            [('/build/file', b'data', None)],
            [('build/link', b'', '../../outside')],
            [('build/file', b'one', None), ('build/file', b'two', None)],
            [('build/link', b'', 'folder'), ('build/link/file', b'data', None)],
        ]
        for members in cases:
            with self.subTest(members=members):
                destination = self.root / 'expanded'
                destination.mkdir(exist_ok=True)
                with self.assertRaises(ValueError):
                    release.extract_verified(self.archive(members), destination, 'build')
                self.assertEqual(list(destination.iterdir()), [])

    def test_build_copy_excludes_databases_credentials_and_host_native_modules(self):
        source = self.root / 'source'
        source.mkdir()
        for name in ['server.js', '.env', '.env.local', 'sleepypod.dev.db', 'biometrics.db-wal', 'owner.key']:
            (source / name).write_text('fixture')
        (source / 'node_modules').mkdir()
        (source / 'node_modules/native.node').write_bytes(b'MachO')
        destination = self.root / 'copy'
        destination.mkdir()
        release.copy_build(source, destination)
        self.assertEqual([entry.name for entry in destination.iterdir()], ['server.js'])

    def test_build_copy_refuses_unexpected_symlinks(self):
        source = self.root / 'source'
        source.mkdir()
        (source / 'secret').symlink_to('/etc/passwd')
        destination = self.root / 'copy'
        destination.mkdir()
        with self.assertRaises(ValueError):
            release.copy_build(source, destination)

    def test_inventory_rejects_host_native_code_and_external_links(self):
        native = self.root / 'library.so.42'
        native.write_bytes(b'MachO')
        with self.assertRaises(ValueError):
            release.inventory(self.root)
        native.unlink()
        (self.root / 'outside').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            release.inventory(self.root)

    def test_inventory_accepts_arm64_elf_and_internal_links(self):
        header = bytearray(20)
        header[:6] = b'\x7fELF\x02\x01'
        header[18:20] = (183).to_bytes(2, 'little')
        native = self.root / 'library.node'
        native.write_bytes(header)
        (self.root / 'link').symlink_to('library.node')
        records = release.inventory(self.root)
        self.assertEqual(records[0]['sha256'], release.checksum(native))
        self.assertEqual(records[1]['link'], 'library.node')

    def test_cached_checksum_mismatch_does_not_fetch_or_rewrite(self):
        artifact = self.root / 'archive.tar.gz'
        artifact.write_bytes(b'original')
        with patch('urllib.request.urlopen') as fetch:
            with self.assertRaises(ValueError):
                release.download('https://example.invalid/archive', artifact, '0' * 64)
            fetch.assert_not_called()
        self.assertEqual(artifact.read_bytes(), b'original')

    def test_existing_output_is_preserved_before_any_command(self):
        existing = self.root / 'keep'
        existing.mkdir()
        (existing / 'owner-data').write_text('preserved')
        with patch('subprocess.check_output') as command:
            with self.assertRaises(ValueError):
                release.prepare(self.root / 'repo', existing)
            command.assert_not_called()
        self.assertEqual((existing / 'owner-data').read_text(), 'preserved')


if __name__ == '__main__':
    unittest.main()
