#!/usr/bin/env python3
"""Bounded, attended network isolation; never changes Pod hardware or routines."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import time
import uuid


STATE_ROOT = Path('/run/sleepypod-network-trial')
FIREWALLS = ('/usr/sbin/iptables', '/usr/sbin/ip6tables')
SYSTEMCTL = '/bin/systemctl'
SYSTEMD_RUN = '/usr/bin/systemd-run'
PYTHON = '/usr/bin/python3'
ROUTE = '/sbin/ip'
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')
CONTROL_PORTS = '8822,3000,3001'
MAX_SECONDS = 300
MIN_SECONDS = 120


def run(arguments, check=True):
    result = subprocess.run(arguments, text=True, capture_output=True, timeout=5)
    if check and result.returncode:
        raise RuntimeError(f'{Path(arguments[0]).name} failed: {result.stderr.strip()[:300]}')
    return result


def secure_path(path, directory=False):
    """Recovery code and state must not be replaceable by another local user."""
    if not path.is_absolute():
        raise ValueError('Use an absolute path')
    for parent in reversed((path, *path.parents)):
        metadata = parent.lstat()
        if stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise ValueError(f'Path must be root-owned, not linked or writable by others: {parent}')
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(path.stat().st_mode):
        raise ValueError('Unexpected file type')


def control_address(value):
    address = ipaddress.IPv4Address(value)
    private_ranges = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
    if not any(address in ipaddress.IPv4Network(network) for network in private_ranges):
        raise ValueError('Recovery must use a directly connected private LAN IPv4 address')
    return str(address)


def firewall_rules(binary):
    return [shlex.split(line) for line in run([binary, '-w', '2', '-S']).stdout.splitlines() if line]


def preflight(address, script):
    """Read-only: require the current direct SSH peer and both address families."""
    if os.geteuid() != 0:
        raise ValueError('Run on the Pod as root')
    address = control_address(address)
    peer = os.environ.get('SSH_CONNECTION', '').split()
    if len(peer) != 4 or peer[0] != address or peer[3] != '8822':
        raise ValueError('Control address must be this SSH session peer on Pod port 8822')
    secure_path(script)
    for binary in (*FIREWALLS, SYSTEMCTL, SYSTEMD_RUN, PYTHON, ROUTE):
        if not os.access(binary, os.X_OK):
            raise ValueError(f'Missing required executable: {binary}')
    routes = json.loads(run([ROUTE, '-j', 'route', 'get', address]).stdout)
    if len(routes) != 1 or routes[0].get('gateway') or routes[0].get('dev') == 'lo' or routes[0].get('prefsrc') != peer[2]:
        raise ValueError('Recovery peer must have a direct LAN route from the SSH destination')
    run([SYSTEMCTL, 'is-active', '--quiet', 'sleepypod.service'])
    snapshots = {}
    for binary in FIREWALLS:
        rules = firewall_rules(binary)
        if any(any(token.startswith('SPQ_') for token in rule) for rule in rules):
            raise ValueError('A previous or foreign trial chain exists; inspect and recover it first')
        snapshots[Path(binary).name] = {'rules': len(rules), 'sha256': hashlib.sha256(json.dumps(rules).encode()).hexdigest()}
    return {'controlAddress': address, 'interface': routes[0]['dev'], 'firewalls': snapshots,
            'scriptSha256': hashlib.sha256(script.read_bytes()).hexdigest(), 'physicalOperationVerified': False}


def plans(address, trial_id):
    """Preserve loopback and one management peer; block existing sessions too."""
    result = []
    for family, binary in enumerate(FIREWALLS):
        for direction in ('INPUT', 'OUTPUT'):
            incoming = direction == 'INPUT'
            chain = f'SPQ_{trial_id[:12]}_{family}{direction[0]}'
            rules = [['-i' if incoming else '-o', 'lo', '-j', 'RETURN']]
            if family == 0:
                rules.append(['-s' if incoming else '-d', address + '/32', '-p', 'tcp', '-m', 'multiport',
                              '--dports' if incoming else '--sports', CONTROL_PORTS, '-j', 'RETURN'])
                # A short trial must not accidentally discard a DHCP lease renewal.
                rules.append(['-p', 'udp', '-m', 'udp', '--sport', '67' if incoming else '68',
                              '--dport', '68' if incoming else '67', '-j', 'RETURN'])
            rules.append(['-j', 'DROP'])
            jump = ['-m', 'comment', '--comment', 'sleepypod-trial-' + trial_id, '-j', chain]
            result.append({'binary': binary, 'direction': direction, 'chain': chain, 'rules': rules, 'jump': jump})
    return result


@contextmanager
def state_lock():
    if not STATE_ROOT.exists():
        STATE_ROOT.mkdir(mode=0o700)
    secure_path(STATE_ROOT, directory=True)
    lock = STATE_ROOT / 'lock'
    descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        secure_path(lock)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def save(record):
    temporary = STATE_ROOT / 'receipt.new'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(record, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(STATE_ROOT / 'receipt.json')
    descriptor = os.open(STATE_ROOT, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_record():
    path = STATE_ROOT / 'receipt.json'
    if not path.exists():
        return None
    secure_path(path)
    record = json.loads(path.read_text())
    if not re.fullmatch('[0-9a-f]{32}', record.get('id', '')) or record.get('version') != 1:
        raise ValueError('Invalid trial receipt')
    control_address(record['controlAddress'])
    if record['bootId'] != BOOT_ID.read_text().strip():
        raise ValueError('Receipt belongs to another boot; inspect networking before continuing')
    return record


def unit_name(record):
    return 'sleepypod-net-recover-' + record['id']


def arm_recovery(record, script):
    name = unit_name(record)
    run([SYSTEMD_RUN, '--quiet', '--unit=' + name, '--on-active=' + str(record['seconds']) + 's',
         '--timer-property=AccuracySec=1s', '--timer-property=RandomizedDelaySec=0',
         '--property=Type=oneshot', '--property=Restart=on-failure', '--property=RestartSec=3s',
         '--property=StartLimitIntervalSec=0', '--property=TimeoutStartSec=45s',
         PYTHON, '-B', str(script), 'recover', '--trial-id', record['id']])
    run([SYSTEMCTL, 'is-active', '--quiet', name + '.timer'])


def restore(record):
    """Unlink only this trial, then remove its unchanged private chains."""
    errors = []
    for plan in plans(record['controlAddress'], record['id']):
        binary, chain = plan['binary'], plan['chain']
        try:
            rules = firewall_rules(binary)
            jump = ['-A', plan['direction'], *plan['jump']]
            # Remove exactly our tagged jumps, never replace the rest of the firewall.
            for _index in range(rules.count(jump)):
                run([binary, '-w', '2', '-D', plan['direction'], *plan['jump']])
            current = [rule for rule in rules if len(rule) > 1 and rule[:2] == ['-A', chain]]
            expected = [['-A', chain, *rule] for rule in plan['rules']]
            if current != expected[:len(current)]:
                raise ValueError(f'Foreign rules in {chain}; left its detached chain for inspection')
            if ['-N', chain] in rules:
                run([binary, '-w', '2', '-F', chain])
                run([binary, '-w', '2', '-X', chain])
        except (RuntimeError, ValueError, subprocess.SubprocessError) as error:
            errors.append(str(error))
    if not errors:
        try:
            timer = unit_name(record) + '.timer'
            stopped = run([SYSTEMCTL, 'stop', timer], check=False)
            if stopped.returncode:
                # Arming may have failed before systemd created either unit.
                loaded = run([SYSTEMCTL, 'show', timer, '-p', 'LoadState', '--value'], check=False)
                if loaded.stdout.strip() != 'not-found':
                    raise RuntimeError('Could not confirm recovery timer stopped')
        except (RuntimeError, subprocess.SubprocessError) as error:
            errors.append(str(error))
    record.update(phase='restore_failed' if errors else 'restored', restoredAt=time.time(), errors=errors)
    save(record)
    if errors:
        raise RuntimeError('Recovery incomplete; recovery service will retry: ' + '; '.join(errors))
    return record


def apply(address, seconds, script):
    if not MIN_SECONDS <= seconds <= MAX_SECONDS:
        raise ValueError(f'Trial duration must be {MIN_SECONDS}–{MAX_SECONDS} seconds')
    with state_lock():
        previous = read_record()
        if previous and previous['phase'] != 'restored':
            raise ValueError('An unfinished trial exists; recover it before starting another')
        observation = preflight(address, script)
        record = {'version': 1, 'id': uuid.uuid4().hex, 'phase': 'prepared', 'seconds': seconds,
                  'bootId': BOOT_ID.read_text().strip(), 'createdAt': time.time(), **observation}
        # Persist intent before arming recovery or installing any firewall rules.
        save(record)
        try:
            arm_recovery(record, script)
            record['phase'] = 'armed'
            save(record)
            deadline = time.monotonic() + 20
            for plan in plans(address, record['id']):
                commands = [[plan['binary'], '-w', '2', '-N', plan['chain']]]
                commands.extend([plan['binary'], '-w', '2', '-A', plan['chain'], *rule] for rule in plan['rules'])
                commands.append([plan['binary'], '-w', '2', '-I', plan['direction'], '1', *plan['jump']])
                for command in commands:
                    if time.monotonic() > deadline:
                        raise RuntimeError('Applying the trial exceeded its short setup deadline')
                    run(command)
            record.update(phase='isolated', isolatedAt=time.time())
            save(record)
            return record
        except BaseException:
            # SIGKILL or SSH loss cannot cancel the independent systemd timer.
            restore(record)
            raise


def recover(trial_id):
    with state_lock():
        record = read_record()
        if not record or record['id'] != trial_id:
            raise ValueError('Recovery ID does not match the saved trial; no rules changed')
        return restore(record)


def rehearse(address, script):
    """Run the real timer/recovery path without adding any isolation rules."""
    with state_lock():
        previous = read_record()
        if previous and previous['phase'] != 'restored':
            raise ValueError('An unfinished trial exists; recover it before rehearsing')
        observation = preflight(address, script)
        record = {'version': 1, 'id': uuid.uuid4().hex, 'phase': 'rehearsal', 'seconds': 10,
                  'bootId': BOOT_ID.read_text().strip(), 'createdAt': time.time(), **observation}
        save(record)
        try:
            arm_recovery(record, script)
        except BaseException:
            restore(record)
            raise
        return record


def interrupted(_number, _frame):
    raise KeyboardInterrupt('Trial interrupted; restoring networking')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('preflight')
    check.add_argument('--control-address', required=True)
    rehearsal = commands.add_parser('rehearse-recovery')
    rehearsal.add_argument('--control-address', required=True)
    start = commands.add_parser('apply')
    start.add_argument('--control-address', required=True)
    start.add_argument('--seconds', type=int, default=180)
    start.add_argument('--attended', action='store_true', required=True)
    recovery = commands.add_parser('recover')
    recovery.add_argument('--trial-id', required=True)
    arguments = parser.parse_args()
    script = Path(__file__).absolute()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    if arguments.command == 'preflight':
        result = preflight(arguments.control_address, script)
    elif arguments.command == 'rehearse-recovery':
        result = rehearse(arguments.control_address, script)
    elif arguments.command == 'apply':
        result = apply(arguments.control_address, arguments.seconds, script)
    else:
        result = recover(arguments.trial_id)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
