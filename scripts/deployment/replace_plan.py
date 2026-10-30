#!/usr/bin/env python3
"""Replace stopped, disabled Core units with another reviewed release plan."""
import argparse
from contextlib import ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

import handoff
from maintenance_plan import SERVICE as MAINTENANCE_SERVICE, SOCKET as MAINTENANCE_SOCKET
from service_plan import CORE_UNITS, LEGACY_UNITS, read_plan


def replace_unit(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix='.sleepypod-unit-', dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def replace_plan(previous, directory):
    """Switch only unit files; on failure restore exact prior bytes without starting Core."""
    if previous.resolve() == directory.resolve():
        raise ValueError('Use a distinct new service plan')
    old_plan, plan = read_plan(previous), read_plan(directory)
    old_journal = json.loads((previous / 'handoff.json').read_text())
    if old_journal.get('format') != 'sleepypod-handoff/1' or old_journal.get('unitHashes') != old_plan['units']:
        raise ValueError('Previous journal does not belong to its plan')
    if old_journal.get('phase') not in ('installed_not_started', 'trial_restored'):
        raise ValueError('Recover the previous handoff before changing its release')
    journal_path = directory / 'handoff.json'
    if journal_path.exists() or journal_path.is_symlink():
        raise ValueError('New plan already has a handoff journal')
    for name in ('data', 'environment', 'dacSocket', 'rawData'):
        if old_plan['config'][name] != plan['config'][name]:
            raise ValueError('A release replacement cannot change ' + name)
    if 'maintenanceSocket' in old_plan['config'] or 'maintenanceSocket' in plan['config']:
        for name in (MAINTENANCE_SOCKET, MAINTENANCE_SERVICE):
            path = handoff.UNIT_DIRECTORY / name
            if path.exists() or path.is_symlink() or handoff.unit_state(name).get('LoadState') != 'not-found':
                raise ValueError('Roll back the bound maintenance helper before changing the controller plan')
    handoff.validate_installed(old_plan)
    handoff.validate_legacy(old_journal)
    for name in CORE_UNITS:
        state = handoff.unit_state(name)
        if not handoff.stopped(state) or state['UnitFileState'] != 'disabled':
            raise ValueError('Core must be stopped and disabled before replacing its plan')
    for name in LEGACY_UNITS:
        state = handoff.unit_state(name)
        if state['ActiveState'] != 'active' or state['MainPID'] == '0' or state['UnitFileState'] != 'enabled':
            raise ValueError('Retained controller must be active and enabled')

    journal = {'format': 'sleepypod-handoff/1', 'phase': 'replacing_stopped_release',
               'legacy': old_journal['legacy'], 'unitHashes': plan['units'],
               'createdUnits': [], 'replacedUnits': [], 'previousPlan': str(previous),
               'bootSelectionChanged': False}
    handoff.private_json(journal_path, journal)
    try:
        for name in CORE_UNITS:
            path = handoff.UNIT_DIRECTORY / name
            if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != old_plan['units'][name]:
                raise ValueError('Installed unit changed during replacement: ' + name)
            replace_unit(path, (directory / name).read_bytes())
            journal['replacedUnits'].append(name)
            handoff.private_json(journal_path, journal)
        handoff.systemctl('daemon-reload')
        handoff.validate_installed(plan)
        journal['phase'] = 'installed_not_started'
        handoff.private_json(journal_path, journal)
    except BaseException:
        # Refuse unrelated edits, including a change made while handling failure.
        for name in CORE_UNITS:
            path = handoff.UNIT_DIRECTORY / name
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if path.is_symlink() or digest not in (old_plan['units'][name], plan['units'][name]):
                raise RuntimeError('Unit changed; replacement recovery needs review: ' + name)
        for name in CORE_UNITS:
            replace_unit(handoff.UNIT_DIRECTORY / name, (previous / name).read_bytes())
        handoff.systemctl('daemon-reload')
        handoff.validate_installed(old_plan)
        journal['phase'] = 'replacement_failed_previous_restored'
        handoff.private_json(journal_path, journal)
        raise
    return journal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous-plan', required=True, type=Path)
    parser.add_argument('--plan', required=True, type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run on the Pod as root')
    os.umask(0o077)
    with ExitStack() as stack:
        # Lock both plans in stable order, including against a concurrent trial.
        for directory in sorted({args.previous_plan.absolute(), args.plan.absolute()}):
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
                raise ValueError('Plan directories must be root-owned and private')
            descriptor = os.open(directory / 'handoff.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            lock = stack.enter_context(os.fdopen(descriptor, 'w'))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(replace_plan(args.previous_plan, args.plan)))


if __name__ == '__main__':
    main()
