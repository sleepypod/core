#!/usr/bin/env python3
"""Inert Linux IPC probe: real dac credentials, synthetic service state, no systemctl."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import socket
import tempfile
import time
import uuid

import maintenance_broker as broker


class InertSystem(broker.Systemd):
    """Exercise production authorization against synthetic units; never submit effects."""
    def __init__(self, account_uid, units):
        super().__init__(account_uid, units=units)
        self.peer_pid = None
        self.submissions = []

    def properties(self, unit):
        groups = (self.proc/str(self.peer_pid)/'cgroup').read_text().splitlines()
        control_group = next(line.split(':', 2)[2] for line in groups if line.split(':', 2)[1] in ('', 'name=systemd'))
        if 'NoNewPrivs:\t1' not in (self.proc/str(self.peer_pid)/'status').read_text():
            raise ValueError('Probe child did not retain NoNewPrivileges')
        return {'ActiveState': 'active', 'SubState': 'running', 'MainPID': str(self.peer_pid),
                'InvocationID': 'a'*32, 'ControlGroup': control_group,
                'FragmentPath': str(self.units/unit), 'DropInPaths': '', 'Job': '', 'NoNewPrivileges': 'yes'}

    def submit(self, unit):
        self.submissions.append(unit)
        return True


def client(socket_path, account, requests, output):
    """Drop credentials before connecting, so SO_PEERCRED reflects the real caller."""
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:
        raise OSError('Unable to set NoNewPrivileges')
    results = []
    for request in requests:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(str(socket_path))
            connection.sendall((json.dumps(request)+'\n').encode())
            reply = bytearray()
            while not reply.endswith(b'\n'):
                chunk = connection.recv(1024)
                if not chunk: raise ValueError('Incomplete probe reply')
                reply.extend(chunk)
            results.append(json.loads(reply)['outcome'])
    os.write(output, json.dumps(results).encode())


def round_trip(listener, instance, account, requests):
    listener_path = Path(listener.getsockname())
    reader, writer = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(reader)
            listener.close()
            client(listener_path, account, requests, writer)
            os._exit(0)
        except Exception:
            os._exit(1)
    os.close(writer)
    instance.system.peer_pid = child
    try:
        for _request in requests:
            connection, _address = listener.accept()
            with connection:
                broker.serve_connection(connection, instance)
        # The client has finished its last read before it closes its output pipe.
        result = os.read(reader, 4096)
        _pid, status = os.waitpid(child, 0)
        child = None
        if status != 0: raise ValueError('Probe client failed')
        return json.loads(result)
    finally:
        os.close(reader)
        if child is not None:
            os.kill(child, signal.SIGKILL)
            os.waitpid(child, 0)


def main():
    if os.geteuid() != 0 or not hasattr(socket, 'SO_PEERCRED'):
        raise ValueError('Run the inert probe as root on Linux')
    account = pwd.getpwnam('dac')
    with tempfile.TemporaryDirectory(prefix='sleepypod-maintenance-probe-', dir='/run') as temporary:
        root = Path(temporary)
        os.chown(root, 0, account.pw_gid)
        root.chmod(0o750)
        plan, state, units = (root/name for name in ('plan', 'state', 'units'))
        for directory in (plan, state, units): directory.mkdir(mode=0o700)
        hashes = {}
        for unit in broker.PLAN_UNITS:
            contents = b'# Inert probe fixture; never installed or executed.\n'
            (units/unit).write_bytes(contents)
            (units/unit).chmod(0o400)
            hashes[unit] = hashlib.sha256(contents).hexdigest()
        (plan/'plan.json').write_text(json.dumps({'format': 'sleepypod-service-plan/1', 'units': hashes}))
        (plan/'plan.json').chmod(0o600)
        (plan/'handoff.lock').touch(mode=0o400)
        system = InertSystem(account.pw_uid, units)
        instance = broker.Broker(plan, broker.StateStore(state), system)
        listener_path = str(root/'control.sock')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(listener_path)
            os.chown(listener_path, 0, account.pw_gid)
            os.chmod(listener_path, 0o660)
            listener.listen(1)
            listener.settimeout(5)
            def request():
                issued = int(time.time()*1000)
                return {'version': 1, 'requestId': str(uuid.uuid4()), 'invocationId': 'a'*32,
                        'unit': broker.CORE, 'issuedAt': issued, 'expiresAt': issued+5000}
            refused = round_trip(listener, instance, pwd.getpwuid(0), [request()])
            permitted = request()
            expired = {**request(), 'issuedAt': 1, 'expiresAt': 5001}
            accepted = round_trip(listener, instance, account, [permitted, permitted, expired])
        if refused != ['rejected'] or accepted != ['accepted', 'accepted', 'rejected'] or system.submissions != [broker.CORE]:
            raise ValueError('Unexpected inert probe outcome')
        print(json.dumps({'rootCaller': refused, 'dacNoNewPrivileges': accepted,
                          'simulatedSubmissions': len(system.submissions), 'physicalEffects': False,
                          'serviceState': 'synthetic', 'temporaryFilesRemovedOnExit': True}))


if __name__ == '__main__': main()
