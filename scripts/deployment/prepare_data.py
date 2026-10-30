#!/usr/bin/env python3
"""Capture quiesced Free Sleep data, restore its services, then import for review."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

import activation_checks
import handoff
from service_plan import CORE_UNITS, LEGACY_UNITS, read_plan

ROOT = Path(__file__).resolve().parents[2]
FORMAT = 'sleepypod-quiesced-import/1'


def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def source_hashes(legacy):
    return {name: activation_checks.source_digest(legacy, name, required)
            for name, required in activation_checks.SOURCE_FILES.items()}


def require_core_stopped():
    for name in CORE_UNITS:
        state = handoff.unit_state(name)
        if not handoff.stopped(state) or state['UnitFileState'] != 'disabled':
            raise ValueError('Core must remain stopped and disabled: ' + name)


def validate_plan(directory):
    """Share the installed handoff identity; never operate on replacement services."""
    handoff.require_no_activation(directory)
    plan = read_plan(directory)
    journal = json.loads((directory / 'handoff.json').read_text())
    if (journal.get('format') != 'sleepypod-handoff/1' or journal.get('unitHashes') != plan['units']
            or journal.get('phase') not in ('installed_not_started', 'trial_restored')
            or set(journal.get('legacy', {})) != set(LEGACY_UNITS)):
        raise ValueError('Recover the handoff before preparing data')
    handoff.validate_installed(plan)
    handoff.validate_legacy(journal)
    require_core_stopped()
    for name in LEGACY_UNITS:
        state = handoff.unit_state(name)
        if state['UnitFileState'] != 'enabled' or state.get('KillMode') != 'control-group':
            raise ValueError('Retained services must be enabled with control-group ownership')
    return plan, journal


def run_tool(arguments, log, timeout):
    """Keep tool output private; subprocess failures never dump backup data to the console."""
    descriptor = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        subprocess.run(arguments, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=timeout)


def phase(output, record, value):
    record['phase'] = value
    handoff.private_json(output / 'preparation.json', record)


def restore_retained(directory, output, record):
    """Restore only the unchanged original writers; no database, boot or actuator changes."""
    try:
        validate_plan(directory)
        # Restart before another journal write: a full backup disk must not prevent restoration.
        handoff.systemctl('start', *LEGACY_UNITS)
        states = {name: handoff.unit_state(name) for name in LEGACY_UNITS}
        if any(state['ActiveState'] != 'active' or state['MainPID'] == '0'
               or state['UnitFileState'] != 'enabled' for state in states.values()):
            raise RuntimeError('Retained controller services did not recover')
        record['restoredIdleVerified'] = handoff.restored_idle()
        record['servicesAfter'] = {name: {'active': True, 'pid': value['MainPID']}
                                   for name, value in states.items()}
        record['restoredAt'] = time.time()
    except BaseException:
        record['restoredIdleVerified'] = False
        try:
            phase(output, record, 'recovery_required')
        except OSError:
            pass  # Keep the original restoration failure when storage also fails.
        raise
    phase(output, record, 'free_sleep_restored')


def prepare(directory, legacy, backup_tool, expected_backup_hash, output):
    """Bound writer downtime to capture. Migration and all warnings wait until restoration."""
    legacy = legacy.absolute()
    output = output.parent.resolve(strict=True) / output.name
    if not legacy.is_dir() or legacy.is_symlink() or legacy.resolve() != legacy:
        raise ValueError('Use the canonical existing retained data directory')
    if output.exists() or output.is_symlink():
        raise ValueError('Output must be a new directory')
    for protected in (legacy, directory.resolve(), ROOT):
        if output == protected or protected in output.parents or output in protected.parents:
            raise ValueError('Output must be separate from data, the plan and source code')
    if (not backup_tool.is_file() or backup_tool.is_symlink()
            or not re.fullmatch('[a-f0-9]{64}', expected_backup_hash)
            or digest(backup_tool) != expected_backup_hash):
        raise ValueError('Backup tool does not match its independently reviewed SHA-256')
    plan, journal = validate_plan(directory)
    for field in ('release', 'modules', 'data', 'environment'):
        protected = Path(plan['config'][field]).resolve()
        if output == protected or protected in output.parents or output in protected.parents:
            raise ValueError('Output overlaps an installed controller path')
    for name in LEGACY_UNITS:
        state = handoff.unit_state(name)
        if state['ActiveState'] != 'active' or state['MainPID'] == '0':
            raise ValueError('Free Sleep must be running before preparation')
    # Fail before downtime if the same interpreter cannot resolve the source timezone.
    importer = ROOT / 'scripts/migration/free_sleep.py'
    settings = json.loads((legacy / 'lowdb/settingsDB.json').read_text())
    subprocess.run([sys.executable, str(importer), '--check-timezone', settings['timeZone']],
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=15)
    original_hashes = source_hashes(legacy)
    handoff.require_thermal_idle(handoff.local_json('/api/deviceStatus'))
    output.mkdir(mode=0o700)
    record = {'format': FORMAT, 'createdAt': time.time(), 'planHash': digest(directory / 'plan.json'),
              'legacy': journal['legacy'], 'legacyData': str(legacy), 'sourceHashes': original_hashes,
              'backupToolSha256': expected_backup_hash, 'importerSha256': digest(importer),
              'coreStarted': False, 'bootSelectionChanged': False, 'liveDataReplaced': False,
              'readyForCutover': False, 'restoredIdleVerified': False, 'captureComplete': False}
    phase(output, record, 'prepared')
    try:
        phase(output, record, 'stopping_free_sleep')
        handoff.stop_units(LEGACY_UNITS)
        require_core_stopped()
        if original_hashes != source_hashes(legacy) or digest(backup_tool) != expected_backup_hash:
            raise ValueError('Configuration or backup tool changed before capture')
        record['quiescedAt'] = time.time()
        phase(output, record, 'capturing')
        run_tool([sys.executable, str(backup_tool), '--data', str(legacy), '--output', str(output / 'backup')],
                 output / 'capture.log', 300)
        if not all(handoff.stopped(handoff.unit_state(name)) for name in LEGACY_UNITS):
            raise RuntimeError('Retained writers restarted during capture')
        require_core_stopped()
        manifest = json.loads((output / 'backup/manifest.json').read_text())
        if (manifest.get('format') != 'free-sleep-migration/1'
                or original_hashes != source_hashes(legacy)
                or any(manifest.get('files', {}).get('data/' + name) != expected
                       for name, expected in original_hashes.items())):
            raise ValueError('Captured configuration differs from the quiesced sources')
        record.update(captureComplete=True, capturedAt=time.time(),
                      backupManifestSha256=digest(output / 'backup/manifest.json'))
        phase(output, record, 'captured')
    except BaseException as error:
        record['captureErrorType'] = type(error).__name__
        raise
    finally:
        restore_retained(directory, output, record)
    try:
        phase(output, record, 'importing')
        run_tool([sys.executable, str(importer), '--backup', str(output / 'backup'),
                  '--output', str(output / 'candidate')], output / 'import.log', 300)
        report = json.loads((output / 'candidate/migration-report.json').read_text())
        if (report.get('format') != 'sleepypod-free-sleep-import/1'
                or report.get('readyForCutover') is not False or report.get('controllersChanged') is not False):
            raise ValueError('Expected an inert migration review report')
        record.update(importedAt=time.time(), reviewItems=len(report['reviewRequired']),
                      migrationReportSha256=digest(output / 'candidate/migration-report.json'))
        phase(output, record, 'imported_for_review')
        return record
    except BaseException as error:
        record['importErrorType'] = type(error).__name__
        phase(output, record, 'import_failed_free_sleep_restored')
        raise


def recover(directory, output):
    """After an interrupted capture, restore unchanged services without repeating any capture/import."""
    record = json.loads((output / 'preparation.json').read_text())
    if record.get('format') != FORMAT or record.get('planHash') != digest(directory / 'plan.json'):
        raise ValueError('Preparation journal belongs to another plan')
    _, journal = validate_plan(directory)
    if record.get('legacy') != journal['legacy']:
        raise ValueError('Retained service identity differs from the preparation journal')
    if record.get('phase') not in ('stopping_free_sleep', 'capturing', 'captured',
                                 'restoring_free_sleep', 'recovery_required'):
        raise ValueError('No interrupted writer capture requires recovery')
    restore_retained(directory, output, record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('capture', 'recover'))
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--legacy-data', type=Path)
    parser.add_argument('--backup-tool', type=Path)
    parser.add_argument('--backup-sha256')
    args = parser.parse_args()
    if args.action == 'capture' and any(value is None for value in (args.legacy_data, args.backup_tool, args.backup_sha256)):
        parser.error('Capture requires --legacy-data, --backup-tool and its independently reviewed --backup-sha256')
    if os.geteuid() != 0:
        raise ValueError('Run the reviewed preparation on the Pod as root')
    for folder in (args.plan, *((args.output,) if args.action == 'recover' else ())):
        info = folder.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError('Existing plan and recovery directories must be root-owned and private')
    os.umask(0o077)
    for event in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(event, handoff.interrupt_trial)
    descriptor = os.open(args.plan / 'handoff.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = (prepare(args.plan, args.legacy_data, args.backup_tool, args.backup_sha256, args.output)
                  if args.action == 'capture' else recover(args.plan, args.output))
        print(json.dumps({key: result[key] for key in ('phase', 'captureComplete', 'restoredIdleVerified',
                                                      'coreStarted', 'readyForCutover')}))


if __name__ == '__main__':
    main()
