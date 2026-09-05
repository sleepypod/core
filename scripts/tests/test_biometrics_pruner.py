"""Exercise the pruner with real temporary archives and simulated disk usage."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class BiometricsPrunerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = Path(self.temp.name)

    def archive_file(self, name, age):
        path = self.archive / name
        path.write_bytes(b'x' * (600 * 1024))
        os.utime(path, (age, age))
        return path

    def prune(self, cap=1, disk_usage='20'):
        script = (ROOT / 'modules/biometrics-archiver/sleepypod-biometrics-pruner').read_text()
        script = script.replace('ARCHIVE_DIR="/persistent/biometrics-archive"',
                                'ARCHIVE_DIR=' + shlex.quote(str(self.archive)))
        # The script uses real du, ls and rm, but must never inspect a Pod disk.
        df = f'''df() {{
  pct={disk_usage}
  printf 'Filesystem Blocks Used Available Capacity Mounted on\\n'
  printf '/dev/mock 1000 0 1000 %s%% /persistent\\n' "$pct"
}}
'''
        return subprocess.run([shutil.which('bash'), '-c', df + script],
                              env={**os.environ, 'MAX_ARCHIVE_MB': str(cap),
                                   'DISK_CEIL_PCT': '80'}, text=True, capture_output=True)

    def test_prunes_oldest_then_stops_and_rerun_is_noop(self):
        old = self.archive_file('3.RAW.gz', 1000)
        middle = self.archive_file('1.RAW.gz', 2000)
        newest = self.archive_file('2.RAW.gz', 3000)
        result = self.prune()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(old.exists())
        self.assertFalse(middle.exists())
        self.assertTrue(newest.exists())
        result = self.prune()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('pruned=0', result.stdout)

    def test_unprunable_files_count_against_cap_and_fail_loudly(self):
        stray = self.archive_file('unfinished.tmp', 1000)
        result = self.prune(cap=0)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('still over budget', result.stderr)
        self.assertTrue(stray.exists())

    def test_exact_disk_ceiling_requires_pruning_below_ceiling(self):
        old = self.archive_file('1.RAW.gz', 1000)
        newest = self.archive_file('2.RAW.gz', 2000)
        # Disk falls below the ceiling after the first unlink.
        usage = '$(if [ -f "$ARCHIVE_DIR/1.RAW.gz" ]; then echo 80; else echo 79; fi)'
        result = self.prune(cap=100, disk_usage=usage)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(old.exists())
        self.assertTrue(newest.exists())


if __name__ == '__main__':
    unittest.main()
