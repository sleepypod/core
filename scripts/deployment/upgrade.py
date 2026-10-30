#!/usr/bin/env python3
"""Update an active isolated Core release, retaining an exact quiesced rollback copy."""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import stat
import tempfile
import time

import activate
import handoff
import maintenance_broker
import maintenance_install
import maintenance_plan
import service_plan
import stage_sensors
from recovery_privacy import require_legacy_recovery_data

FORMAT = 'sleepypod-upgrade/1'
HELPERS = (maintenance_plan.SOCKET, maintenance_plan.SERVICE)
PRESERVED_TABLES = ('bedtime_routines', 'temperature_schedules', 'power_schedules',
                    'alarm_schedules', 'base_schedules', 'side_settings', 'tap_gestures',
                    'comfort_feedback', 'journal_entries', 'room_context_settings')


def inventory(directory):
    """Hash regular files and metadata; refuse links and special files in a backup."""
    result = {}
    for path in [directory, *sorted(directory.rglob('*'))]:
        info = path.lstat()
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError('Unexpected backup entry: ' + str(path))
        result[str(path.relative_to(directory))] = {
            'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None,
        }
    return result


def copy_data(source, destination):
    """Preserve owner and modes as well as bytes, including HomeKit pairing state."""
    expected = inventory(source)
    shutil.copytree(source, destination)
    for relative, entry in expected.items():
        path = destination / relative
        if os.geteuid() == 0:
            os.chown(path, entry['uid'], entry['gid'])
        path.chmod(entry['mode'])
    if inventory(destination) != expected:
        raise RuntimeError('Backup/restore byte and metadata verification failed')
    return expected


def check_databases(directory):
    for path in directory.glob('*.db'):
        with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as database:
            if database.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('Database integrity check failed: ' + path.name)


def configuration(directory):
    """Compare user routines and history independently of changing runtime rows."""
    result = {}
    with sqlite3.connect((directory/'sleepypod.db').as_uri() + '?mode=ro', uri=True) as database:
        tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for name in PRESERVED_TABLES:
            if name in tables:
                rows = sorted(database.execute('SELECT * FROM "' + name + '"').fetchall(), key=repr)
                result[name] = hashlib.sha256(repr(rows).encode()).hexdigest()
    return result


def checkpoint(directory, record, phase):
    record.update(phase=phase, updatedAt=time.time())
    handoff.private_json(directory/'upgrade.json', record)


def validate_units(old_units, new_units=None):
    for name, digest in old_units.items():
        path = handoff.UNIT_DIRECTORY/name
        contents = maintenance_install.owned_bytes(path)
        permitted = {digest, (new_units or {}).get(name)}
        state = handoff.unit_state(name)
        if hashlib.sha256(contents).hexdigest() not in permitted or state.get('DropInPaths'):
            raise ValueError('Unrecognized installed unit: ' + name)
        if state.get('FragmentPath') != str(path):
            raise ValueError('Unexpected service location: ' + name)


def context(old_directory, new_directory, old_helpers, new_helpers):
    for directory in (old_directory, new_directory, old_helpers, new_helpers):
        maintenance_install.secure_path(directory, private=True)
    old = service_plan.read_plan(old_directory)
    new = service_plan.read_plan(new_directory)
    if old['config']['release'] == new['config']['release']:
        raise ValueError('Select a different staged release')
    if {key: value for key, value in old['config'].items() if key not in ('release', 'modules')} != {
            key: value for key, value in new['config'].items() if key not in ('release', 'modules')}:
        raise ValueError('This updater changes only the release and verified sensor source; data and credentials must remain fixed')
    if old['config'].get('modules') != new['config'].get('modules'):
        stage_sensors.verify(Path(old['config']['modules']), Path(new['config']['modules']), Path(new['config']['release']))
    helpers = [maintenance_plan.read_plan(directory) for directory in (old_helpers, new_helpers)]
    for manifest, directory, plan in zip(helpers, (old_directory, new_directory), (old, new)):
        if manifest['controllerPlan'] != str(directory) or manifest['release'] != plan['config']['release']:
            raise ValueError('Maintenance plan and controller identity differ')
    return {'old': old, 'new': new, 'oldHelpers': helpers[0], 'newHelpers': helpers[1],
            'oldUnits': {**old['units'], **helpers[0]['units']},
            'newUnits': {**new['units'], **helpers[1]['units']}}


def install_units(directory, helpers):
    for parent, names in ((directory, service_plan.CORE_UNITS), (helpers, HELPERS)):
        for name in names:
            contents = maintenance_install.owned_bytes(parent/name, private=True)
            descriptor, filename = tempfile.mkstemp(prefix='.sleepypod-upgrade-', dir=handoff.UNIT_DIRECTORY)
            temporary = Path(filename)
            try:
                with os.fdopen(descriptor, 'wb') as output:
                    output.write(contents)
                    output.flush()
                    os.fsync(output.fileno())
                temporary.chmod(0o644)
                os.replace(temporary, handoff.UNIT_DIRECTORY/name)
            finally:
                temporary.unlink(missing_ok=True)
    descriptor = os.open(handoff.UNIT_DIRECTORY, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    handoff.systemctl('daemon-reload')


def stop_helpers():
    """A socket has no process ID; verify services and sockets by their own rules."""
    handoff.systemctl('stop', *HELPERS)
    if not all(maintenance_install.helper_stopped(name, handoff.unit_state(name)) for name in HELPERS):
        raise RuntimeError('Maintenance services did not stop')


def start_and_verify(plan, token, revision, seconds):
    handoff.systemctl('start', service_plan.CORE_UNIT)
    observation = activate.settle(token, revision, seconds, handoff.core_observation, time.sleep, time.monotonic)
    handoff.validate_installed(plan)
    activate.assert_boot_selection(core=True)
    handoff.systemctl('start', maintenance_plan.SOCKET)
    if handoff.unit_state(maintenance_plan.SOCKET).get('ActiveState') != 'active':
        raise RuntimeError('Maintenance socket did not recover')
    maintenance_install.verify_socket()
    return observation


def restore(directory, details, record, seconds=120):
    """Restore the previous Core, never starting the retained Free Sleep controller."""
    validate_units(details['oldUnits'], details['newUnits'])
    data = Path(details['old']['config']['data'])
    backup = directory/'data-backup'
    require_legacy_recovery_data(data)
    if record.get('backupComplete'):
        require_legacy_recovery_data(backup)
    checkpoint(directory, record, 'restoring')
    stop_helpers()
    handoff.stop_units(service_plan.CORE_UNITS)
    # Recheck after writers have stopped. A concurrent account creation must
    # not disappear into a pre-account backup or an older runtime.
    try:
        require_legacy_recovery_data(data)
        if record.get('backupComplete'):
            require_legacy_recovery_data(backup)
    except ValueError:
        checkpoint(directory, record, 'recovery_required')
        raise
    if record.get('backupComplete'):
        if inventory(backup) != record['backupInventory']:
            raise ValueError('Rollback backup changed; refusing to overwrite live data')
        restored = directory/'restored-data'
        if restored.exists():
            raise ValueError('A previous restore needs inspection')
        copy_data(backup, restored)
        check_databases(restored)
        failed = directory/('replaced-data-' + str(time.time_ns()))
        data.rename(failed)
        restored.rename(data)
    install_units(Path(record['oldPlan']), Path(record['oldMaintenance']))
    token = handoff.read_owner_key(Path(details['old']['config']['environment']))
    record['restoredObservation'] = start_and_verify(details['old'], token, record['oldRevision'], seconds)
    if configuration(data) != record['configurationBefore']:
        raise RuntimeError('Restored configuration differs from the pre-update snapshot')
    previous = Path(record['oldPlan'])/'activation.json'
    active = json.loads(previous.read_text())
    active.update(phase='active', updatedAt=time.time())
    handoff.private_json(previous, active)
    candidate = Path(record['newPlan'])/'activation.json'
    if candidate.exists():
        current = json.loads(candidate.read_text())
        current.update(phase='rolled_back_to_previous_core', updatedAt=time.time())
        handoff.private_json(candidate, current)
    checkpoint(directory, record, 'rolled_back')
    return record


def upgrade(directory, old_directory, new_directory, old_helpers, new_helpers, seconds=180):
    details = context(old_directory, new_directory, old_helpers, new_helpers)
    old, new = details['old'], details['new']
    saved = activate.read_handoff(old_directory, old)
    active = activate.read_activation(old_directory, old)
    if active.get('phase') != 'active' or active.get('activeOwner') != 'sleepypod-core':
        raise ValueError('The outgoing Core must have a verified active record')
    for name in ('activation.json', 'handoff.json'):
        if (new_directory/name).exists() or (new_directory/name).is_symlink():
            raise ValueError('Candidate already has an installation record')
    validate_units(details['oldUnits'])
    activate.validate_legacy_definitions(saved)
    activate.assert_ownership(core=True)
    activate.assert_boot_selection(core=True)
    old_revision = maintenance_install.verify_release(Path(old['config']['release']))
    new_revision = maintenance_install.verify_release(Path(new['config']['release']))
    data = Path(old['config']['data'])
    require_legacy_recovery_data(data)
    token = handoff.read_owner_key(Path(old['config']['environment']))
    observation = handoff.core_observation(token, old_revision)
    handoff.require_core_thermal_idle(token, observation)
    # Reserve space for backup, restore rehearsal and failed-candidate data.
    needed = sum(path.stat().st_size for path in data.rglob('*') if path.is_file()) * 4 + 128*1024*1024
    if shutil.disk_usage(data).free < needed:
        raise ValueError('Insufficient space for verified backup and rollback')
    record = {'format': FORMAT, 'oldPlan': str(old_directory), 'newPlan': str(new_directory),
              'oldMaintenance': str(old_helpers), 'newMaintenance': str(new_helpers),
              'oldRevision': old_revision, 'newRevision': new_revision,
              'createdAt': time.time(), 'backupComplete': False, 'physicalOperationVerified': False,
              'configurationBefore': configuration(data)}
    checkpoint(directory, record, 'prepared')
    try:
        stop_helpers()
        handoff.stop_units(service_plan.CORE_UNITS)
        checkpoint(directory, record, 'quiesced')
        require_legacy_recovery_data(data)
        record['configurationBefore'] = configuration(data)
        record['backupInventory'] = copy_data(data, directory/'data-backup')
        check_databases(directory/'data-backup')
        record['backupInventory'] = inventory(directory/'data-backup')
        record['backupComplete'] = True
        checkpoint(directory, record, 'backed_up')
        copy_data(directory/'data-backup', directory/'restore-rehearsal')
        check_databases(directory/'restore-rehearsal')
        checkpoint(directory, record, 'restore_rehearsed')
        validate_units(details['oldUnits'])
        install_units(new_directory, new_helpers)
        # This records installation only, not an invented initial migration trial.
        handoff.private_json(new_directory/'handoff.json', {
            'format': 'sleepypod-handoff/1', 'phase': 'installed_not_started',
            'legacy': saved['legacy'], 'unitHashes': new['units'],
            'upgradedFrom': str(old_directory), 'upgradeJournal': str(directory/'upgrade.json'),
            'bootSelectionChanged': False, 'trialSucceeded': False})
        checkpoint(directory, record, 'starting_candidate')
        record['observation'] = start_and_verify(new, token, new_revision, seconds)
        if configuration(data) != record['configurationBefore']:
            raise RuntimeError('Update changed a saved routine or user history')
        handoff.private_json(new_directory/'activation.json', {
            **active, 'sourceRevision': new_revision, 'unitHashes': new['units'],
            'phase': 'active', 'createdAt': time.time(), 'updatedAt': time.time(),
            'observation': record['observation'], 'physicalOperationVerified': False,
            'upgradedFrom': str(old_directory), 'upgradeJournal': str(directory/'upgrade.json')})
        handoff.private_json(new_helpers/'maintenance-install.json', {
            'format': maintenance_install.JOURNAL_FORMAT, 'phase': 'enabled',
            'unitHashes': details['newHelpers']['units'], 'controllerPlan': str(new_directory),
            'sourceCommit': new_revision, 'coreEnvironmentChanged': False,
            'controllerStarted': False, 'upgradeJournal': str(directory/'upgrade.json')})
        handoff.private_json(old_directory/'activation.json', {
            **active, 'phase': 'superseded_by_upgrade', 'updatedAt': time.time(),
            'upgradeJournal': str(directory/'upgrade.json')})
        checkpoint(directory, record, 'active')
        return record
    except BaseException:
        record['phaseBeforeRestore'] = record['phase']
        try:
            restore(directory, details, record, seconds)
        except BaseException:
            checkpoint(directory, record, 'recovery_required')
            raise
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('apply', 'rollback'))
    parser.add_argument('--operation', required=True, type=Path)
    parser.add_argument('--old-plan', type=Path)
    parser.add_argument('--new-plan', type=Path)
    parser.add_argument('--old-maintenance', type=Path)
    parser.add_argument('--new-maintenance', type=Path)
    parser.add_argument('--seconds', type=int, default=180)
    args = parser.parse_args()
    if os.geteuid() != 0 or not 30 <= args.seconds <= 300:
        raise ValueError('Run as root with a 30–300 second readiness deadline')
    os.umask(0o077)
    for event in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(event, handoff.interrupt_trial)
    if args.action == 'apply':
        if not all((args.old_plan, args.new_plan, args.old_maintenance, args.new_maintenance)):
            parser.error('Apply requires both controller and maintenance plans')
        maintenance_install.secure_path(args.operation.parent, private=True)
        args.operation.mkdir(mode=0o700)
    else:
        maintenance_install.secure_path(args.operation, private=True)
        record = json.loads(maintenance_install.owned_bytes(args.operation/'upgrade.json', private=True, limit=16*1024*1024))
        if record.get('format') != FORMAT or record.get('phase') == 'rolled_back':
            raise ValueError('No recoverable upgrade operation')
        args.old_plan, args.new_plan = Path(record['oldPlan']), Path(record['newPlan'])
        args.old_maintenance, args.new_maintenance = Path(record['oldMaintenance']), Path(record['newMaintenance'])
    with ExitStack() as locks:
        for directory in sorted({args.old_plan, args.new_plan}):
            locks.enter_context(maintenance_broker.operation_lock(directory, 'handoff.lock'))
        if args.action == 'apply':
            result = upgrade(args.operation, args.old_plan, args.new_plan,
                             args.old_maintenance, args.new_maintenance, args.seconds)
        else:
            details = context(args.old_plan, args.new_plan, args.old_maintenance, args.new_maintenance)
            result = restore(args.operation, details, record, args.seconds)
    print(json.dumps({key: result.get(key) for key in
                     ('phase', 'oldRevision', 'newRevision', 'physicalOperationVerified')}))


if __name__ == '__main__':
    main()
