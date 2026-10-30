#!/usr/bin/env python3
"""Root-owned Unix-socket maintenance broker for the isolated Core deployment."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import struct
import subprocess
import tempfile
import time

SOCKET_PATH = '/run/sleepypod-maintenance/control.sock'
STATE_DIRECTORY = Path('/run/sleepypod-maintenance-state')
CORE = 'sleepypod.service'
TARGETS = (CORE, 'sleepypod-piezo-processor.service', 'sleepypod-sleep-detector.service',
           'sleepypod-environment-monitor.service')
PLAN_UNITS = set(TARGETS) | {'sleepypod-calibrator.service'}
MAX_REQUEST_BYTES = 1024
REQUEST_LIFETIME_MS = 5000
COOLDOWN_SECONDS = 60


class Rejected(Exception):
    """A request refused before any service command was submitted."""


def unique_json(value):
    def object_pairs(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError('Duplicate JSON field')
            result[key] = item
        return result
    return json.loads(value, object_pairs_hook=object_pairs,
                      parse_constant=lambda _value: (_ for _ in ()).throw(ValueError('Non-finite JSON')))


def private_directory(path, owner=0):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o077:
        raise ValueError('Expected a private, owned directory')


def regular_bytes(path, owner=0, private=True):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner
                or info.st_mode & (0o077 if private else 0o022) or info.st_size > 64 * 1024):
            raise ValueError('Unexpected file ownership, mode or size')
        return source.read()


@contextmanager
def operation_lock(directory, filename, owner=0, create=True):
    """Share the selected plan lock with handoff, activation and plan replacement."""
    private_directory(directory, owner)
    descriptor = os.open(directory / filename, (os.O_RDWR | os.O_CREAT if create else os.O_RDONLY) | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+' if create else 'r') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & 0o077:
            raise ValueError('Unexpected lock file')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Rejected('Controller maintenance or migration is already in progress.') from error
        yield


def validate_request(request, now_ms):
    if not isinstance(request, dict) or set(request) != {'version', 'requestId', 'invocationId', 'unit', 'issuedAt', 'expiresAt'}:
        raise Rejected('Invalid maintenance request.')
    if (type(request['version']) is not int or request['version'] != 1
            or not isinstance(request['requestId'], str)
            or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', request['requestId'])
            or not isinstance(request['invocationId'], str)
            or not re.fullmatch(r'[a-f0-9]{32}', request['invocationId'])
            or request['unit'] not in TARGETS):
        raise Rejected('Unsupported maintenance request.')
    issued, expiry = request['issuedAt'], request['expiresAt']
    if (type(issued) is not int or type(expiry) is not int
            or not 0 < expiry - issued <= REQUEST_LIFETIME_MS or not issued <= now_ms <= expiry):
        raise Rejected('Maintenance request expired or has an invalid timestamp.')
    return request


def response(request, outcome, message):
    return {'requestId': request.get('requestId'), 'outcome': outcome, 'message': message}


class StateStore:
    """One durable attempt is enough: its cooldown exceeds every request's lifetime."""
    def __init__(self, directory, owner=0):
        self.directory, self.owner = directory, owner
        private_directory(directory, owner)
        self.path = directory / 'attempt.json'

    def read(self):
        try:
            value = unique_json(regular_bytes(self.path, self.owner))
        except FileNotFoundError:
            return None
        if (not isinstance(value, dict) or set(value) != {'request', 'outcome', 'message', 'monotonic'}
                or value['outcome'] not in ('submitting', 'accepted', 'rejected', 'unknown')
                or type(value['monotonic']) not in (int, float) or not math.isfinite(value['monotonic'])
                or value['monotonic'] < 0 or not isinstance(value['message'], str)):
            raise ValueError('Maintenance receipt needs operator review')
        # Validate its structure at its original issuance time, not as a new action.
        validate_request(value['request'], value['request']['issuedAt'])
        return value

    def write(self, value):
        descriptor, filename = tempfile.mkstemp(prefix='.attempt-', dir=self.directory)
        temporary = Path(filename)
        try:
            with os.fdopen(descriptor, 'w') as output:
                json.dump(value, output, allow_nan=False)
                output.flush()
                os.fsync(output.fileno())
            temporary.chmod(0o600)
            os.replace(temporary, self.path)
            descriptor = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        finally:
            temporary.unlink(missing_ok=True)


class Systemd:
    def __init__(self, account_uid, proc=Path('/proc'), units=Path('/etc/systemd/system')):
        self.account_uid, self.proc, self.units = account_uid, proc, units

    def properties(self, unit):
        result = subprocess.run(['/bin/systemctl', 'show', unit, '--no-pager',
                                 '--property=MainPID,ActiveState,SubState,ControlGroup,InvocationID,FragmentPath,DropInPaths,Job,NoNewPrivileges'],
                                capture_output=True, text=True, check=True, timeout=2)
        return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

    def authorize(self, peer, request, hashes):
        """Fence by kernel peer UID/PID, systemd invocation, cgroup and reviewed unit bytes."""
        peer_pid, peer_uid, _peer_gid = peer
        if peer_uid != self.account_uid or peer_pid <= 1:
            raise Rejected('Only the running Core controller may request maintenance.')
        core = self.properties(CORE)
        if (core.get('ActiveState') != 'active' or core.get('SubState') != 'running'
                or core.get('MainPID') != str(peer_pid) or core.get('InvocationID') != request['invocationId']
                or core.get('NoNewPrivileges') != 'yes' or not core.get('ControlGroup')):
            raise Rejected('The requesting Core invocation is no longer active.')
        groups = [line.split(':', 2) for line in (self.proc / str(peer_pid) / 'cgroup').read_text().splitlines()]
        if not any(len(item) == 3 and item[1] in ('', 'name=systemd') and item[2] == core['ControlGroup'] for item in groups):
            raise Rejected('Controller process membership could not be verified.')
        units = sorted(PLAN_UNITS) if request['unit'] == CORE else (CORE, request['unit'])
        for unit in units:
            state = core if unit == CORE else self.properties(unit)
            filename = self.units / unit
            if (state.get('FragmentPath') != str(filename) or state.get('DropInPaths')
                    or state.get('Job') not in ('', '0')
                    or hashlib.sha256(regular_bytes(filename, private=False)).hexdigest() != hashes[unit]):
                raise Rejected('Selected services changed or already have a pending job.')

    def submit(self, unit):
        # try-restart can never start an inactive Core during rollback. A sensor
        # recovery may start a failed module, but only while its parent is current.
        if unit not in TARGETS:
            raise Rejected('Unsupported maintenance service.')
        action = 'try-restart' if unit == CORE else 'restart'
        result = subprocess.run(['/bin/systemctl', '--no-block', '--job-mode=fail', action, unit],
                                capture_output=True, text=True, timeout=3)
        if result.returncode != 0:
            raise RuntimeError('Systemd did not confirm submission')
        return True


def read_hashes(plan):
    value = unique_json(regular_bytes(plan / 'plan.json'))
    hashes = value.get('units') if isinstance(value, dict) else None
    if (not isinstance(value, dict) or value.get('format') != 'sleepypod-service-plan/1' or not isinstance(hashes, dict)
            or set(hashes) != PLAN_UNITS or any(not isinstance(item, str) or not re.fullmatch(r'[a-f0-9]{64}', item) for item in hashes.values())):
        raise ValueError('Unsupported reviewed controller plan')
    return hashes


class Broker:
    def __init__(self, plan, store, system, now=time.time, monotonic=time.monotonic):
        self.plan, self.store, self.system = plan, store, system
        self.now, self.monotonic = now, monotonic

    def request(self, request, peer):
        """Persist before submission; never replay a timed-out or interrupted attempt."""
        validate_request(request, int(self.now() * 1000))
        with operation_lock(self.plan, 'handoff.lock', create=False):
            hashes = read_hashes(self.plan)
            self.system.authorize(peer, request, hashes)
            previous = self.store.read()
            if previous:
                if previous['request']['requestId'] == request['requestId']:
                    if previous['request'] != request:
                        raise Rejected('Request identifier was reused with different contents.')
                    outcome = 'unknown' if previous['outcome'] == 'submitting' else previous['outcome']
                    return response(request, outcome, previous['message'])
                if (previous['outcome'] in ('submitting', 'unknown')
                        and previous['request']['invocationId'] == request['invocationId']):
                    raise Rejected('An earlier attempt has an unknown outcome. Inspect the service before clearing its maintenance receipt.')
                if self.monotonic() - previous['monotonic'] < COOLDOWN_SECONDS:
                    raise Rejected('Wait 60 seconds after the previous maintenance attempt.')
            attempt = {'request': request, 'outcome': 'submitting',
                       'message': 'Restart submission could not be confirmed. Reconnect and inspect service health.',
                       'monotonic': self.monotonic()}
            self.store.write(attempt)
            # Recheck after durable IO, while holding the same migration lock.
            try:
                validate_request(request, int(self.now() * 1000))
                self.system.authorize(peer, request, hashes)
                validate_request(request, int(self.now() * 1000))
            except Exception:
                attempt.update(outcome='rejected', message='Controller ownership or request freshness changed before submission.')
                self.store.write(attempt)
                return response(request, attempt['outcome'], attempt['message'])
            try:
                accepted = self.system.submit(request['unit'])
                if accepted is True:
                    attempt.update(outcome='accepted', message='Restart requested. Reconnect to check its status.')
                else:
                    attempt['outcome'] = 'unknown'
            except Exception:
                # A timeout or interrupted client can occur after systemd accepted
                # the job. Retain the uncertainty; do not issue another command.
                attempt['outcome'] = 'unknown'
            self.store.write(attempt)
            return response(request, attempt['outcome'], attempt['message'])


def serve_connection(connection, broker):
    request = {}
    try:
        connection.settimeout(2)
        peer = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        data = bytearray()
        while b'\n' not in data and len(data) <= MAX_REQUEST_BYTES:
            chunk = connection.recv(min(256, MAX_REQUEST_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > MAX_REQUEST_BYTES or not data.endswith(b'\n') or data.count(b'\n') != 1:
            raise Rejected('Invalid maintenance frame.')
        request = unique_json(data)
        if not isinstance(request, dict):
            raise Rejected('Invalid maintenance request.')
        reply = broker.request(request, peer)
    except Rejected as error:
        reply = response(request if isinstance(request, dict) else {}, 'rejected', str(error))
    except Exception:
        reply = response(request if isinstance(request, dict) else {}, 'unknown', 'Maintenance could not be confirmed. Reconnect and inspect service health.')
    try:
        connection.sendall((json.dumps(reply) + '\n').encode())
    except OSError:
        pass  # The durable receipt, not delivery of this reply, controls retries.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True, type=Path)
    arguments = parser.parse_args()
    if os.geteuid() != 0 or os.environ.get('LISTEN_PID') != str(os.getpid()) or os.environ.get('LISTEN_FDS') != '1':
        raise ValueError('Run only as a root systemd socket-activated service')
    private_directory(arguments.plan)
    store = StateStore(STATE_DIRECTORY)
    broker = Broker(arguments.plan, store, Systemd(pwd.getpwnam('dac').pw_uid))
    with operation_lock(STATE_DIRECTORY, 'broker.lock'), socket.socket(fileno=3) as listener:
        if listener.family != socket.AF_UNIX or listener.type != socket.SOCK_STREAM or listener.getsockname() != SOCKET_PATH:
            raise ValueError('Unexpected activated listener')
        while True:
            connection, _address = listener.accept()
            with connection:
                serve_connection(connection, broker)


if __name__ == '__main__':
    main()
