#!/usr/bin/env python3
"""Activate a trialed imported controller, or restore its retained Free Sleep services."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import time

import activation_checks
import handoff
from service_plan import CORE_UNIT, CORE_UNITS, LEGACY_UNITS, read_plan

FORMAT = 'sleepypod-activation/1'


def read_handoff(directory, plan):
    journal = json.loads((directory / 'handoff.json').read_text())
    if (journal.get('format') != 'sleepypod-handoff/1' or journal.get('unitHashes') != plan['units']
            or set(journal.get('legacy', {})) != set(LEGACY_UNITS)):
        raise ValueError('Handoff journal does not belong to this plan')
    if any(saved['state'].get('UnitFileState') != 'enabled' for saved in journal['legacy'].values()):
        raise ValueError('Expected the original enabled Free Sleep installation')
    return journal


def validate_legacy_definitions(journal):
    # Enablement intentionally changes here; executable definitions must never change.
    for name, saved in journal['legacy'].items():
        state = handoff.unit_state(name)
        if state.get('LoadState') != 'loaded' or handoff.unit_hashes(state) != saved['hashes']:
            raise ValueError('Retained controller configuration changed: ' + name)


def read_activation(directory, plan):
    record = json.loads((directory / 'activation.json').read_text())
    if record.get('format') != FORMAT or record.get('unitHashes') != plan['units']:
        raise ValueError('Activation journal does not belong to this plan')
    return record


def phase(directory, record, value):
    record.update(phase=value, updatedAt=time.time())
    handoff.private_json(directory / 'activation.json', record)


def assert_ownership(core):
    active, inactive = (CORE_UNITS, LEGACY_UNITS) if core else (LEGACY_UNITS, CORE_UNITS)
    for name in active:
        state = handoff.unit_state(name)
        if state.get('ActiveState') != 'active' or state.get('MainPID') in (None, '0'):
            raise RuntimeError('Required controller or sensor service is not active: ' + name)
    for name in inactive:
        if not handoff.stopped(handoff.unit_state(name)):
            raise RuntimeError('Competing controller process is present: ' + name)


def assert_boot_selection(core):
    for name in (*CORE_UNITS, *LEGACY_UNITS):
        enabled = name == CORE_UNIT if core else name in LEGACY_UNITS
        expected = 'enabled' if enabled else 'disabled'
        if handoff.unit_state(name).get('UnitFileState') != expected:
            raise RuntimeError('Boot selection did not persist: ' + name)


def settle(token, revision, seconds, observe, sleep, monotonic):
    """Require all processors and a continuous 30-second fresh, idle hardware window."""
    deadline = monotonic() + seconds
    fresh_since = None
    while monotonic() < deadline:
        assert_ownership(core=True)
        try:
            observation = observe(token, revision)
            ready = (observation['device']['freshness'] == 'fresh'
                     and observation['temperatureRuntime'] == 'ready')
        except (OSError, ValueError, KeyError):
            ready = False
        if ready:
            # Unexpected thermal activity fails immediately; it is not a transient readiness error.
            handoff.require_core_thermal_idle(token, observation)
            observed_at = monotonic()
            if fresh_since is None:
                fresh_since = observed_at
            if observed_at - fresh_since >= 30:
                return observation
        else:
            fresh_since = None
        sleep(min(2, max(0, deadline - monotonic())))
    raise RuntimeError('Core did not maintain fresh, idle telemetry for 30 seconds')


def restore(directory, plan, saved, record, sleep=time.sleep, monotonic=time.monotonic):
    """Restore service ownership and boot selection, preserving both sets of databases."""
    handoff.require_legacy_recovery_data(Path(plan['config']['data']))
    record.update(bootOwner='unknown', activeOwner='transitioning')
    phase(directory, record, 'restoring_legacy')
    handoff.validate_installed(plan)
    handoff.stop_units(CORE_UNITS)
    handoff.require_legacy_recovery_data(Path(plan['config']['data']))
    validate_legacy_definitions(saved)
    handoff.systemctl('disable', *CORE_UNITS)
    handoff.systemctl('enable', *LEGACY_UNITS)
    assert_boot_selection(core=False)
    handoff.systemctl('start', *LEGACY_UNITS)
    assert_ownership(core=False)
    record.update(bootOwner='free-sleep', activeOwner='free-sleep', physicalOperationVerified=False,
                  restoredIdleVerified=False)
    # An ordinary rollback can occur during a user's live heating session; do not cancel it.
    if record.get('requireIdleOnRestore') is True:
        record['restoredIdleVerified'] = handoff.restored_idle(sleep, monotonic)
    phase(directory, record, 'rolled_back')
    return record


def activate(directory, legacy, seconds=120, observe=handoff.core_observation,
             sleep=time.sleep, monotonic=time.monotonic):
    if not 30 <= seconds <= 300:
        raise ValueError('Activation deadline must be 30–300 seconds')
    plan = read_plan(directory)
    saved = read_handoff(directory, plan)
    path = directory / 'activation.json'
    if path.exists() or path.is_symlink():
        raise ValueError('An activation journal exists; inspect it and use rollback for recovery')
    handoff.validate_installed(plan)
    handoff.validate_legacy(saved)
    revision = handoff.prerequisites(plan)
    activation_checks.require_trial(saved, revision, time.time())
    data = Path(plan['config']['data'])
    activation_checks.candidate_ready(data)
    hashes = activation_checks.unchanged_source(data, legacy)
    token = handoff.read_owner_key(Path(plan['config']['environment']))
    handoff.require_thermal_idle(handoff.local_json('/api/deviceStatus'))
    record = {'format': FORMAT, 'unitHashes': plan['units'], 'sourceRevision': revision,
              'legacyData': str(legacy), 'retainedConfigurationHashes': hashes,
              'createdAt': time.time(), 'phase': 'prepared', 'activeOwner': 'free-sleep',
              'bootOwner': 'free-sleep', 'physicalOperationVerified': False,
              'requireIdleOnRestore': True}
    record['activeOwner'] = 'transitioning'
    phase(directory, record, 'stopping_legacy')
    try:
        handoff.stop_units(LEGACY_UNITS)
        if activation_checks.unchanged_source(data, legacy) != hashes:
            raise ValueError('Retained configuration changed during handoff')
        activation_checks.candidate_ready(data)
        phase(directory, record, 'starting_core')
        handoff.systemctl('start', CORE_UNIT)
        observation = settle(token, revision, seconds, observe, sleep, monotonic)
        record['observation'] = observation
        record['activeOwner'] = 'sleepypod-core'
        # Service ownership is verified before and after the non-atomic boot-selection writes.
        record['bootOwner'] = 'unknown'
        phase(directory, record, 'selecting_boot_owner')
        handoff.validate_installed(plan)
        validate_legacy_definitions(saved)
        handoff.systemctl('disable', *LEGACY_UNITS)
        handoff.systemctl('enable', CORE_UNIT)
        assert_boot_selection(core=True)
        assert_ownership(core=True)
        observation = observe(token, revision)
        if observation['device']['freshness'] != 'fresh' or observation['temperatureRuntime'] != 'ready':
            raise RuntimeError('Core readiness changed while selecting the boot owner')
        handoff.require_core_thermal_idle(token, observation)
        record['observation'] = observation
        record['bootOwner'] = 'sleepypod-core'
        record['requireIdleOnRestore'] = False
        phase(directory, record, 'active')
        return record
    except BaseException:
        record['phaseBeforeRestore'] = record['phase']
        try:
            restore(directory, plan, saved, record, sleep, monotonic)
        except BaseException:
            phase(directory, record, 'recovery_required')
            raise
        raise


def rollback(directory):
    plan = read_plan(directory)
    saved = read_handoff(directory, plan)
    record = read_activation(directory, plan)
    record['phaseBeforeRestore'] = record['phase']
    try:
        return restore(directory, plan, saved, record)
    except BaseException:
        phase(directory, record, 'recovery_required')
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('activate', 'rollback', 'status'))
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--legacy-data', type=Path)
    parser.add_argument('--seconds', type=int, default=120)
    args = parser.parse_args()
    if args.action == 'activate' and args.legacy_data is None:
        parser.error('Activation requires --legacy-data pointing to the retained live data')
    if os.geteuid() != 0:
        raise ValueError('Run the reviewed activation on the Pod as root')
    info = args.plan.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError('The plan directory must be root-owned and private')
    os.umask(0o077)
    for event in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(event, handoff.interrupt_trial)
    descriptor = os.open(args.plan / 'handoff.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'activate':
            result = activate(args.plan, args.legacy_data, args.seconds)
        elif args.action == 'rollback':
            result = rollback(args.plan)
        else:
            result = read_activation(args.plan, read_plan(args.plan))
            result = {**result, 'services': {name: handoff.unit_state(name) for name in (*CORE_UNITS, *LEGACY_UNITS)}}
        print(json.dumps(result))


if __name__ == '__main__':
    main()
