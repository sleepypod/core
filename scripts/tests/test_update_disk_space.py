"""Run the updater's real preflight with simulated Pod filesystem layouts.

No updater side effects run: only the preflight block is executed. Invoke with
`python3 -m unittest discover -s scripts/tests -p 'test_*.py'` using Bash 4+.
"""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class UpdateDiskSpaceTests(unittest.TestCase):
    def preflight(self, *, persistent_mb=15000, root_free=3000,
                  persistent_free=3000, tmp_free=1000, work_free=1000,
                  separate_work=False, override=False, bind_override=False,
                  stale_bind=False):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            install = base / 'app'
            lib = install / 'scripts/lib'
            lib.mkdir(parents=True)
            shutil.copyfile(ROOT / 'scripts/lib/relocation-helpers', lib / 'relocation-helpers')
            # A real existing path lets require_space exercise ancestor lookup.
            nm = install / 'node_modules'
            nm.mkdir()
            work = base / 'work'
            work.mkdir()
            custom = base / 'custom'
            custom.mkdir()
            code = (ROOT / 'scripts/bin/sp-update').read_text()
            block = code.split('# Pre-flight: disk space\n', 1)[1].split('# Open WAN if blocked', 1)[0]
            setup = f'''
set -euo pipefail
INSTALL_DIR={shlex.quote(str(install))}
DATA_DIR=/persistent/sleepypod-data
TMPDIR={shlex.quote(str(work)) if separate_work else '/tmp'}
NODE_MODULES_DIR={shlex.quote(str(custom / 'missing/node_modules')) if override else "''"}
layout() {{
  fs=1; mp=/; total=6000; free={root_free}
  case "$1" in
    /persistent*) fs=2; mp=/persistent; total={persistent_mb}; free={persistent_free} ;;
    /tmp) fs=3; mp=/tmp; free={tmp_free} ;;
    "$INSTALL_DIR"*)
      if [ "$1" = "$INSTALL_DIR/node_modules" ] && {str(stale_bind).lower()}; then
        fs=2; mp="$INSTALL_DIR/node_modules"; free={persistent_free}
      fi ;;
    {shlex.quote(str(custom))}*)
      fs=4; mp=/custom; free=800
      if {str(bind_override).lower()}; then fs=1; free={root_free}; fi ;;
    {shlex.quote(str(work))}*) fs=4; mp=/work; free={work_free} ;;
  esac
}}
df() {{
  local fs mp total free
  layout "${{@: -1}}"
  if [ "$1" = -Pk ]; then total=$((total * 1024)); free=$((free * 1024)); fi
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
  printf '/dev/mock%s %s 0 %s 10%% %s\\n' "$fs" "$total" "$free" "$mp"
}}
stat() {{
  local fs mp total free
  layout "${{@: -1}}"
  printf '%s\\n' "$fs"
}}
mountpoint() {{ [ "${{@: -1}}" = /persistent ]; }}
'''
            # Only filesystem existence is virtualized; arithmetic, df parsing,
            # target selection and the final failure path remain production code.
            block = block.replace('[ ! -e "$path" ]', '[ ! -e "$path" ] && [[ "$path" != /persistent* ]]')
            return subprocess.run([shutil.which('bash'), '-c', setup + block],
                                  text=True, capture_output=True, env=os.environ)

    def test_healthy_standard_layout(self):
        result = self.preflight()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_small_persistent_does_not_block_rootfs_install(self):
        result = self.preflight(persistent_mb=966, persistent_free=100)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rootfs_target_sums_dependencies_with_code_and_modules(self):
        result = self.preflight(persistent_mb=966, root_free=1200)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('/ needs 1700MB free', result.stderr)

    def test_stale_bind_is_not_charged_when_relocation_chooses_rootfs(self):
        result = self.preflight(persistent_mb=966, persistent_free=100, stale_bind=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_override_checks_nearest_existing_ancestor(self):
        result = self.preflight(override=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('/custom needs 900MB free, only 800MB available', result.stderr)

    def test_bind_mount_and_root_share_one_budget(self):
        result = self.preflight(override=True, bind_override=True, root_free=1200)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('/ needs 1700MB free', result.stderr)

    def test_tmpdir_does_not_hide_full_rollback_volume(self):
        result = self.preflight(separate_work=True, tmp_free=100)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('/tmp needs 350MB free, only 100MB available', result.stderr)

    def test_separate_work_volume_is_checked(self):
        result = self.preflight(separate_work=True, work_free=100)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('/work needs 350MB free, only 100MB available', result.stderr)

    def test_shared_tmp_volume_sums_both_copies(self):
        result = self.preflight(tmp_free=600)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('/tmp needs 700MB free, only 600MB available', result.stderr)


if __name__ == '__main__':
    unittest.main()
