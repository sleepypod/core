#!/usr/bin/env python3
"""Provision or remove the restricted broker while retained Free Sleep owns the Pod."""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import tempfile
import time

import handoff
import maintenance_broker
import maintenance_plan
import service_plan

OWNER_UID = 0
UNIT_DIRECTORY = Path('/etc/systemd/system')
ROOT = maintenance_plan.ROOT
UNITS = (maintenance_plan.SOCKET, maintenance_plan.SERVICE)
JOURNAL_FORMAT = 'sleepypod-maintenance-install/1'
PHASES = {'installing', 'installed_stopped', 'enabling', 'enabled', 'rolling_back', 'rolled_back'}


def digest(contents):
    return hashlib.sha256(contents).hexdigest()


def owned_bytes(path, private=False, limit=64*1024):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER_UID
                or info.st_mode & (0o077 if private else 0o022) or info.st_size > limit):
            raise ValueError('Unexpected file ownership, permissions or size: '+str(path))
        return source.read()


def secure_path(path, private=False):
    """Reject writable or symlinked ancestors before trusting managed root files."""
    if not path.is_absolute(): raise ValueError('Use an absolute managed path')
    for item in reversed((path, *path.parents)):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != OWNER_UID or info.st_mode & 0o022:
            raise ValueError('Untrusted managed path: '+str(item))
    if private and path.stat().st_mode & 0o077:
        raise ValueError('Expected a private managed path')


def verify_release(release):
    """Verify the packaged broker and build identity without executing application code."""
    secure_path(release)
    manifest = json.loads(owned_bytes(release/'bundle-manifest.json', limit=32*1024*1024))
    if (manifest.get('format') != 'sleepypod-offline-runtime/1'
            or type(manifest.get('maintenanceProtocol')) is not int or manifest['maintenanceProtocol'] != 1
            or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('sourceCommit', ''))):
        raise ValueError('Release lacks the reviewed maintenance protocol')
    for relative in ('scripts/deployment/maintenance_broker.py', '.git-info'):
        path = release/'app'/relative
        secure_path(path)
        records = [entry for entry in manifest['application'] if entry.get('path') == relative]
        contents = owned_bytes(path)
        if len(records) != 1 or records[0].get('sha256') != digest(contents):
            raise ValueError('Packaged maintenance file differs from its manifest')
        if relative == '.git-info':
            revision = json.loads(contents).get('commitHash', '')
            if not re.fullmatch(r'[a-f0-9]{7,40}', revision) or not manifest['sourceCommit'].startswith(revision):
                raise ValueError('Build identity differs from its release')
    return manifest['sourceCommit']


def load_context(directory, recovery=False):
    """Bind this installation to the selected, stopped Core plan and untouched credentials."""
    if directory.parent != ROOT or not directory.name.startswith('maintenance-plan-'):
        raise ValueError('Use a separate managed maintenance-plan directory')
    secure_path(directory, private=True)
    for name in (*UNITS, 'maintenance-plan.json'): owned_bytes(directory/name, private=True)
    manifest = maintenance_plan.read_plan(directory)
    controller = Path(manifest['controllerPlan'])
    secure_path(controller, private=True)
    for name in (*service_plan.CORE_UNITS, 'plan.json', 'handoff.json'):
        owned_bytes(controller/name, private=True)
    plan = service_plan.read_plan(controller)
    if (plan['config']['release'] != manifest['release']
            or plan['config'].get('maintenanceSocket') != service_plan.MAINTENANCE_SOCKET):
        raise ValueError('Controller plan does not select this release and maintenance socket')
    saved = json.loads(owned_bytes(controller/'handoff.json', private=True))
    if (saved.get('format') != 'sleepypod-handoff/1' or saved.get('unitHashes') != plan['units']
            or saved.get('phase') not in ('installed_not_started', 'trial_restored')):
        raise ValueError('Recover the controller handoff before provisioning maintenance')
    activation = controller/'activation.json'
    if activation.exists() or activation.is_symlink():
        record = json.loads(owned_bytes(activation, private=True))
        if (record.get('format') != 'sleepypod-activation/1' or record.get('unitHashes') != plan['units']
                or record.get('phase') != 'rolled_back' or record.get('bootOwner') != 'free-sleep'
                or record.get('activeOwner') != 'free-sleep'):
            raise ValueError('Roll back the active controller before maintenance provisioning')
    if recovery:
        # Cleanup must not require a working release or credentials. The private
        # journal and exact installed unit hashes identify what may be removed.
        record = json.loads(owned_bytes(journal_path(directory), private=True))
        revision = record.get('sourceCommit', '')
        if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision):
            raise ValueError('Recovery journal lacks its original source identity')
    else:
        environment = Path(plan['config']['environment'])
        secure_path(environment, private=True)
        if b'SLEEPYPOD_MAINTENANCE_SOCKET' in owned_bytes(environment, private=True):
            raise ValueError('Remove the conflicting maintenance setting from the private environment before provisioning')
        # Validate the existing owner key without copying it into any journal or output.
        handoff.read_owner_key(environment)
        revision = verify_release(Path(manifest['release']))
    return {'manifest': manifest, 'controller': controller, 'plan': plan, 'handoff': saved, 'revision': revision}


def require_retained_owner(context):
    handoff.validate_installed(context['plan'])
    handoff.validate_legacy(context['handoff'])
    for name in service_plan.CORE_UNITS:
        if digest(owned_bytes(UNIT_DIRECTORY/name)) != context['plan']['units'][name]:
            raise ValueError('Selected Core unit changed before provisioning')
        state = handoff.unit_state(name)
        if not handoff.stopped(state) or state.get('UnitFileState') != 'disabled':
            raise ValueError('Core must be stopped and disabled before maintenance provisioning')
    for name in service_plan.LEGACY_UNITS:
        state = handoff.unit_state(name)
        if state.get('ActiveState') != 'active' or state.get('MainPID') in (None, '0') or state.get('UnitFileState') != 'enabled':
            raise ValueError('Retained Free Sleep must be active and enabled')


def socket_present():
    path = Path(service_plan.MAINTENANCE_SOCKET)
    return path.exists() or path.is_symlink()


def helper_stopped(name, state):
    """Sockets have no MainPID; service processes still require an explicit zero."""
    if name not in UNITS or state.get('ActiveState') not in ('inactive', 'failed'):
        return False
    if name == maintenance_plan.SOCKET:
        return state.get('MainPID') in (None, '0')
    return state.get('MainPID') == '0'


def verify_socket():
    info = Path(service_plan.MAINTENANCE_SOCKET).lstat()
    if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != OWNER_UID
            or info.st_gid != pwd.getpwnam('dac').pw_gid or info.st_mode & 0o777 != 0o660):
        raise ValueError('Socket permissions differ from the reviewed plan')


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def publish_unit(path, contents):
    """Publish complete bytes with exclusive creation; never replace an existing unit."""
    descriptor, temporary = tempfile.mkstemp(prefix='.sleepypod-maintenance-', dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o644)
        os.link(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def journal_path(directory):
    return directory/'maintenance-install.json'


def write_phase(directory, journal, phase):
    now = time.time()
    journal.setdefault('startedAt', now)
    journal['updatedAt'] = now
    journal['phase'] = phase
    handoff.private_json(journal_path(directory), journal)


def read_journal(directory, context):
    journal = json.loads(owned_bytes(journal_path(directory), private=True))
    if (journal.get('format') != JOURNAL_FORMAT or journal.get('phase') not in PHASES
            or journal.get('unitHashes') != context['manifest']['units']
            or journal.get('controllerPlan') != str(context['controller'])
            or journal.get('sourceCommit') != context['revision']):
        raise ValueError('Maintenance journal does not match the reviewed plan')
    return journal


def validate_units(context, allow_missing=False):
    """Refuse foreign unit files and overrides before any stop, disable or removal."""
    states = {}
    for name in UNITS:
        path = UNIT_DIRECTORY/name
        state = handoff.unit_state(name)
        if path.exists() or path.is_symlink():
            if digest(owned_bytes(path)) != context['manifest']['units'][name]:
                raise ValueError('Maintenance unit changed; preserve it for review: '+name)
        elif not allow_missing or not helper_stopped(name, state):
            raise ValueError('Maintenance unit is missing or its cached process is active: '+name)
        if state.get('DropInPaths') or state.get('FragmentPath') not in ('', str(path)):
            raise ValueError('Unexpected maintenance service override: '+name)
        if state.get('LoadState') not in ('loaded', 'not-found'):
            raise ValueError('Maintenance service has an unexpected load state: '+name)
        if name == maintenance_plan.SERVICE and state.get('UnitFileState') not in ('', 'static'):
            raise ValueError('Maintenance service has unexpected boot configuration')
        if name == maintenance_plan.SOCKET and state.get('UnitFileState') not in ('', 'disabled', 'enabled'):
            raise ValueError('Maintenance socket has unexpected boot configuration')
        states[name] = state
    return states


def install(directory, context):
    require_retained_owner(context)
    if journal_path(directory).exists() or journal_path(directory).is_symlink():
        raise ValueError('Installation journal exists; inspect or roll back that attempt')
    for name in UNITS:
        path = UNIT_DIRECTORY/name
        state = handoff.unit_state(name)
        if path.exists() or path.is_symlink() or state.get('LoadState') != 'not-found' or not helper_stopped(name, state):
            raise ValueError('Maintenance service already exists: '+name)
    if socket_present():
        raise ValueError('Maintenance socket path already exists')
    journal = {'format': JOURNAL_FORMAT, 'phase': 'installing', 'unitHashes': context['manifest']['units'],
               'controllerPlan': str(context['controller']), 'sourceCommit': context['revision'],
               'coreEnvironmentChanged': False, 'controllerStarted': False}
    write_phase(directory, journal, 'installing')
    for name in UNITS: publish_unit(UNIT_DIRECTORY/name, owned_bytes(directory/name, private=True))
    handoff.systemctl('daemon-reload')
    states = validate_units(context)
    if any(not helper_stopped(name, state) for name, state in states.items()) or states[maintenance_plan.SOCKET].get('UnitFileState') != 'disabled':
        raise ValueError('Installed maintenance services did not remain stopped')
    require_retained_owner(context)
    write_phase(directory, journal, 'installed_stopped')
    return journal


def enable(directory, context):
    require_retained_owner(context)
    journal = read_journal(directory, context)
    if journal['phase'] != 'installed_stopped':
        raise ValueError('Enable only a fully installed, stopped maintenance plan')
    states = validate_units(context)
    if any(not helper_stopped(name, state) for name, state in states.items()) or states[maintenance_plan.SOCKET].get('UnitFileState') != 'disabled':
        raise ValueError('Maintenance state changed before enablement')
    write_phase(directory, journal, 'enabling')
    handoff.systemctl('enable', '--now', maintenance_plan.SOCKET)
    state = validate_units(context)[maintenance_plan.SOCKET]
    if state.get('ActiveState') != 'active' or state.get('UnitFileState') != 'enabled':
        raise ValueError('Socket enablement could not be confirmed; inspect and roll back')
    verify_socket()
    require_retained_owner(context)
    write_phase(directory, journal, 'enabled')
    return journal


def rollback(directory, context):
    """Recover partial installs by exact hashes; leave the controller, keys and receipts alone."""
    require_retained_owner(context)
    journal = read_journal(directory, context)
    states = validate_units(context, allow_missing=True)
    if journal['phase'] == 'rolled_back':
        if socket_present() or any((UNIT_DIRECTORY/name).exists() or state['LoadState'] != 'not-found' for name, state in states.items()):
            raise ValueError('Maintenance reappeared after rollback')
        return journal
    write_phase(directory, journal, 'rolling_back')
    # Reload first so units published just before a crash are visible to systemd.
    handoff.systemctl('daemon-reload')
    states = validate_units(context, allow_missing=True)
    loaded = [name for name, state in states.items() if state['LoadState'] == 'loaded']
    if loaded: handoff.systemctl('stop', *loaded)
    if (UNIT_DIRECTORY/maintenance_plan.SOCKET).exists(): handoff.systemctl('disable', maintenance_plan.SOCKET)
    states = validate_units(context, allow_missing=True)
    if (any(not helper_stopped(name, state) for name, state in states.items())
            or states[maintenance_plan.SOCKET].get('UnitFileState') == 'enabled' or socket_present()):
        raise ValueError('Maintenance processes did not stop; preserve units for recovery')
    for name in UNITS:
        path = UNIT_DIRECTORY/name
        if path.exists():
            if digest(owned_bytes(path)) != context['manifest']['units'][name]:
                raise ValueError('Maintenance unit changed during rollback')
            path.unlink()
            sync_directory(UNIT_DIRECTORY)
    handoff.systemctl('daemon-reload')
    final = validate_units(context, allow_missing=True)
    if socket_present() or any(state['LoadState'] != 'not-found' or not helper_stopped(name, state) for name, state in final.items()):
        raise ValueError('Maintenance removal could not be confirmed')
    require_retained_owner(context)
    write_phase(directory, journal, 'rolled_back')
    return journal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('inspect', 'install', 'enable', 'rollback'))
    parser.add_argument('--plan', required=True, type=Path)
    arguments = parser.parse_args()
    if os.geteuid() != 0: raise ValueError('Run on the Pod as root')
    os.umask(0o077)
    context = load_context(arguments.plan, recovery=arguments.action == 'rollback')
    secure_path(UNIT_DIRECTORY)
    with ExitStack() as locks:
        if arguments.action != 'inspect':
            locks.enter_context(maintenance_broker.operation_lock(arguments.plan, 'install.lock'))
        locks.enter_context(maintenance_broker.operation_lock(context['controller'], 'handoff.lock', create=False))
        # Revalidate after both locks; a plan may have changed while acquiring them.
        current = load_context(arguments.plan, recovery=arguments.action == 'rollback')
        if current != context: raise ValueError('Maintenance or controller plan changed while acquiring locks')
        if arguments.action == 'inspect':
            require_retained_owner(context)
            result = {'sourceCommit': context['revision'], 'controllerStopped': True,
                      'journalPresent': journal_path(arguments.plan).exists(), 'changesMade': False}
        else:
            result = {'install': install, 'enable': enable, 'rollback': rollback}[arguments.action](arguments.plan, context)
        print(json.dumps(result))


if __name__ == '__main__': main()
