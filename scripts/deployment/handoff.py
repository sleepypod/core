#!/usr/bin/env python3
"""Install reviewed service files and rehearse a bounded Core-to-Free-Sleep round trip."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import time
import urllib.error
import urllib.request
import maintenance_status
from recovery_privacy import require_legacy_recovery_data

from service_plan import CORE_UNIT, CORE_UNITS, LEGACY_UNITS, read_plan

UNIT_DIRECTORY = Path('/etc/systemd/system')


def private_json(path, value):
    temporary = path.with_suffix('.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def systemctl(*arguments):
    return subprocess.check_output(['systemctl', *arguments], text=True, stderr=subprocess.PIPE, timeout=45).strip()


def unit_state(name):
    output = systemctl('show', name, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID',
                       '-p', 'UnitFileState', '-p', 'FragmentPath', '-p', 'DropInPaths', '-p', 'KillMode')
    return dict(line.split('=', 1) for line in output.splitlines() if '=' in line)


def stopped(state):
    return state['ActiveState'] in ('inactive', 'failed') and state['MainPID'] == '0'


def stop_units(names):
    """Never allow the other controller to start until every outgoing process is gone."""
    systemctl('stop', *names)
    if not all(stopped(unit_state(name)) for name in names):
        raise RuntimeError('Outgoing controller processes are still present')


def unit_hashes(state):
    paths = [state.get('FragmentPath', '')] + state.get('DropInPaths', '').split()
    return {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in paths if path}


def validate_installed(plan):
    for name, digest in plan['units'].items():
        path = UNIT_DIRECTORY / name
        state = unit_state(name)
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('Installed service changed: ' + name)
        if state.get('DropInPaths') or state.get('FragmentPath') != str(path):
            raise ValueError('Unexpected service override: ' + name)


def validate_legacy(journal):
    for name, saved in journal['legacy'].items():
        state = unit_state(name)
        if state.get('UnitFileState') != saved['state']['UnitFileState'] or unit_hashes(state) != saved['hashes']:
            raise ValueError('Retained controller configuration changed: ' + name)


def read_owner_key(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError('Credential environment must be a root-owned private regular file')
    lines = [line[len('SLEEPYPOD_AUTH_TOKEN='):] for line in path.read_text().splitlines()
             if line.startswith('SLEEPYPOD_AUTH_TOKEN=')]
    if len(lines) != 1 or not all(character.isascii() and (character.isalnum() or character in '_-') for character in lines[0]) or len(lines[0]) < 32:
        raise ValueError('Expected one unquoted randomly generated owner key')
    return lines[0]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        raise ValueError('Unexpected redirect from local controller')


def local_json(path, token=None):
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    request = urllib.request.Request('http://127.0.0.1:3000' + path, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=5) as response:
        return json.loads(response.read(1024 * 1024))


def require_thermal_idle(status, core=False):
    """A retained target is allowed; a live countdown or priming is not idle."""
    if status.get('isPriming') is not False:
        raise RuntimeError('Idle trial requires priming to remain off')
    for side in ('left', 'right'):
        state = status.get(side + 'Side' if core else side, {})
        duration = state.get('heatingDuration' if core else 'secondsRemaining')
        if type(duration) not in (int, float) or duration != 0:
            raise RuntimeError('Idle trial detected a nonzero or unavailable heating countdown')
        if not core and (state.get('isOn') is not False or state.get('isAlarmVibrating') is not False):
            raise RuntimeError('Retained controller is not idle')


def restored_idle(sleep=time.sleep, monotonic=time.monotonic):
    deadline = monotonic() + 45
    while True:
        try:
            value = local_json('/api/deviceStatus')
        except (OSError, ValueError):
            if monotonic() >= deadline:
                raise RuntimeError('Retained controller API did not recover')
            sleep(2)
            continue
        require_thermal_idle(value)
        return True


def core_observation(token, expected_revision):
    try:
        value = local_json(maintenance_status.PATH, token)
    except urllib.error.HTTPError as error:
        # Only an older release without this route may use the legacy owner API.
        # Authentication failures, broken storage, redirects and malformed data
        # never authorize fallback to a broader surface.
        if error.code != 404:
            raise
    else:
        return maintenance_status.parse(value, expected_revision)
    value = local_json('/api/v1/capabilities', token)
    if value.get('controller', {}).get('id') != 'sleepypod-core':
        raise ValueError('Unexpected controller response')
    revision = value['controller'].get('revision')
    if not isinstance(revision, str) or len(revision) < 7 or not expected_revision.startswith(revision):
        raise ValueError('Controller revision differs from the staged release')
    return {'controller': value['controller'], 'device': value['observations']['device'],
            'temperatureRuntime': value['features']['temperatureControl']['runtime']}


def require_core_thermal_idle(token, observation):
    if 'maintenanceProtocol' in observation:
        maintenance_status.require_idle(observation)
    else:
        require_thermal_idle(local_json('/api/device/status', token), core=True)


def prerequisites(plan):
    config = plan['config']
    require_legacy_recovery_data(Path(config['data']))
    if not stat.S_ISSOCK(Path(config['dacSocket']).stat().st_mode):
        raise ValueError('The inspected firmware socket is absent')
    manifest = json.loads((Path(config['release']) / 'bundle-manifest.json').read_text())
    if manifest.get('format') != 'sleepypod-offline-runtime/1':
        raise ValueError('Missing reviewed offline runtime manifest')
    revision = manifest.get('sourceCommit', '')
    if len(revision) != 40 or any(character not in '0123456789abcdef' for character in revision):
        raise ValueError('Missing full source revision')
    read_owner_key(Path(config['environment']))
    for filename in ('sleepypod.db', 'biometrics.db'):
        path = Path(config['data']) / filename
        if path.is_symlink() or not path.is_file():
            raise ValueError('Missing separately imported database')
    for name in CORE_UNITS:
        state = unit_state(name)
        if not stopped(state):
            raise ValueError('Core must be stopped before a trial')
        if state['UnitFileState'] != 'disabled':
            raise ValueError('Trial services must remain disabled at boot')
    for name in LEGACY_UNITS:
        state = unit_state(name)
        if state['ActiveState'] != 'active' or state['MainPID'] == '0' or state['UnitFileState'] != 'enabled':
            raise ValueError('The retained controller must be active and enabled before a trial')
        if state.get('KillMode') != 'control-group':
            raise ValueError('Retained services must stop their entire control group')
    return revision


def install(directory):
    """Only create absent units; retain original enablement, runtimes, data and SSH."""
    plan = read_plan(directory)
    journal_path = directory / 'handoff.json'
    if journal_path.exists():
        raise ValueError('An installation journal already exists')
    for name in CORE_UNITS:
        if (UNIT_DIRECTORY / name).exists() or (UNIT_DIRECTORY / name).is_symlink() or unit_state(name)['LoadState'] != 'not-found':
            raise ValueError('A Core service already exists: ' + name)
    legacy = {name: {'state': unit_state(name)} for name in LEGACY_UNITS}
    for saved in legacy.values():
        if saved['state']['LoadState'] != 'loaded':
            raise ValueError('Retained controller service is missing')
        saved['hashes'] = unit_hashes(saved['state'])
    journal = {'format': 'sleepypod-handoff/1', 'phase': 'installing', 'legacy': legacy,
               'unitHashes': plan['units'], 'createdUnits': [], 'bootSelectionChanged': False}
    private_json(journal_path, journal)
    for name in CORE_UNITS:
        # O_EXCL refuses existing paths and symlinks, even if another process raced preflight.
        descriptor = os.open(UNIT_DIRECTORY / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(descriptor, 'wb') as output:
            output.write((directory / name).read_bytes())
            output.flush()
            os.fsync(output.fileno())
        journal['createdUnits'].append(name)
        private_json(journal_path, journal)
    systemctl('daemon-reload')
    validate_installed(plan)
    journal['phase'] = 'installed_not_started'
    private_json(journal_path, journal)
    return journal


def restore(plan, journal):
    # Changed units need human review; never kill an unrelated replacement service.
    validate_installed(plan)
    require_legacy_recovery_data(Path(plan['config']['data']))
    stop_units(CORE_UNITS)
    require_legacy_recovery_data(Path(plan['config']['data']))
    validate_legacy(journal)
    systemctl('start', *LEGACY_UNITS)
    states = {name: unit_state(name) for name in LEGACY_UNITS}
    if any(state['ActiveState'] != 'active' or state['MainPID'] == '0' for state in states.values()):
        raise RuntimeError('Retained controller did not recover')
    return {'services': {name: {'active': True, 'pid': state['MainPID']} for name, state in states.items()},
            'physicalOperationVerified': False}


def trial(directory, seconds, observe=core_observation, sleep=time.sleep, monotonic=time.monotonic,
          settle_seconds=0, require_idle=False):
    require_no_activation(directory)
    if not 10 <= seconds <= 300:
        raise ValueError('Trial duration must be 10–300 seconds')
    if not 0 <= settle_seconds <= min(60, seconds):
        raise ValueError('Settling period must be 0–60 seconds within the trial deadline')
    plan = read_plan(directory)
    journal_path = directory / 'handoff.json'
    journal = json.loads(journal_path.read_text())
    if journal.get('format') != 'sleepypod-handoff/1' or journal.get('unitHashes') != plan['units']:
        raise ValueError('Journal does not belong to this plan')
    if journal['phase'] not in ('installed_not_started', 'trial_restored'):
        raise ValueError('Recover the previous operation before starting another trial')
    validate_installed(plan)
    validate_legacy(journal)
    revision = prerequisites(plan)
    token = read_owner_key(Path(plan['config']['environment']))
    if require_idle:
        require_thermal_idle(local_json('/api/deviceStatus'))
    journal.update(phase='trial_starting', trialStartedAt=time.time(), observation=None, trialSucceeded=False,
                   settleSeconds=settle_seconds, requireIdle=require_idle, restoredIdleVerified=False)
    private_json(journal_path, journal)
    try:
        stop_units(LEGACY_UNITS)
        journal['phase'] = 'legacy_stopped'
        private_json(journal_path, journal)
        systemctl('start', CORE_UNIT)
        journal['phase'] = 'core_trial'
        private_json(journal_path, journal)
        deadline = monotonic() + seconds
        fresh_since = None
        while monotonic() < deadline:
            try:
                observation = observe(token, revision)
                journal['observation'] = observation
                if observation['device']['freshness'] == 'fresh':
                    if require_idle:
                        require_core_thermal_idle(token, observation)
                    observed_at = monotonic()
                    if fresh_since is None:
                        fresh_since = observed_at
                    if observed_at - fresh_since >= settle_seconds:
                        journal['trialSucceeded'] = True
                        break
                else:
                    fresh_since = None
            except (OSError, ValueError, KeyError):
                fresh_since = None  # Interrupted observations cannot satisfy a stable window.
            sleep(min(2, max(0, deadline - monotonic())))
    finally:
        journal['phase'] = 'restoring_legacy'
        private_json(journal_path, journal)
        try:
            journal['restoration'] = restore(plan, journal)
        except BaseException:
            journal['phase'] = 'recovery_required'
            journal['trialSucceeded'] = False
            private_json(journal_path, journal)
            raise
        journal['phase'] = 'trial_restored'
        journal['trialEndedAt'] = time.time()
        try:
            if require_idle:
                journal['restoredIdleVerified'] = restored_idle(sleep, monotonic)
        except BaseException:
            journal['trialSucceeded'] = False
            raise
        finally:
            private_json(journal_path, journal)
    if not journal['trialSucceeded']:
        raise RuntimeError('Core did not produce a fresh device report; Free Sleep was restored')
    return journal


def interrupt_trial(_number, _frame):
    """Let the first interruption enter finally; do not interrupt its restoration again."""
    for event in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(event, signal.SIG_IGN)
    raise KeyboardInterrupt('Restoring the retained controller before exiting')


def require_no_activation(directory):
    if (directory / 'activation.json').exists() or (directory / 'activation.json').is_symlink():
        raise ValueError('Use activate.py rollback for an activation journal; then prepare a new trial plan')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'trial', 'rollback', 'status'))
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=120)
    parser.add_argument('--settle-seconds', type=int, default=0)
    parser.add_argument('--require-idle', action='store_true', help='Require zero heating countdowns before, during and after the trial')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run the reviewed handoff on the Pod as root')
    info = args.plan.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError('The plan directory must be root-owned and private')
    os.umask(0o077)
    for event in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(event, interrupt_trial)
    descriptor = os.open(args.plan / 'handoff.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = read_plan(args.plan)
        if args.action == 'install':
            result = install(args.plan)
        elif args.action == 'trial':
            result = trial(args.plan, args.seconds, settle_seconds=args.settle_seconds, require_idle=args.require_idle)
        else:
            path = args.plan / 'handoff.json'
            result = json.loads(path.read_text())
            if result.get('format') != 'sleepypod-handoff/1' or result.get('unitHashes') != plan['units']:
                raise ValueError('Journal does not belong to this plan')
            if args.action == 'rollback':
                require_no_activation(args.plan)
                result['restoration'] = restore(plan, result)
                result['phase'] = 'trial_restored'
                private_json(path, result)
        print(json.dumps(result))


if __name__ == '__main__':
    main()
