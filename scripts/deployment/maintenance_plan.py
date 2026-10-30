#!/usr/bin/env python3
"""Render root-owned maintenance units for a specific reviewed controller plan."""
import argparse
import hashlib
import json
from pathlib import Path

from service_plan import pod_path

ROOT = Path('/persistent/sleepypod-unified')
SERVICE = 'sleepypod-control-maintenance.service'
SOCKET = 'sleepypod-control-maintenance.socket'
ENVIRONMENT_LINE = 'SLEEPYPOD_MAINTENANCE_SOCKET=/run/sleepypod-maintenance/control.sock'


def render(controller_plan, release):
    """Keep Core unprivileged; expose only one local, group-restricted socket."""
    controller_plan, release = Path(pod_path(str(controller_plan))), Path(pod_path(str(release)))
    if (controller_plan.parent != ROOT or not controller_plan.name.startswith('service-plan-')
            or release.parent != ROOT/'releases'):
        raise ValueError('Use separate managed controller-plan and release directories')
    return {
        SOCKET: '''# Generated maintenance socket; no network listener.
[Unit]
Description=SleepyPod restricted maintenance socket

[Socket]
ListenStream=/run/sleepypod-maintenance/control.sock
SocketUser=root
SocketGroup=dac
SocketMode=0660
DirectoryMode=0755
Accept=no
Backlog=8
RemoveOnStop=true

[Install]
WantedBy=sockets.target
''',
        SERVICE: f'''# Generated for one reviewed controller plan; does not own bed hardware.
[Unit]
Description=SleepyPod restricted maintenance supervisor
BindsTo={SOCKET}
After={SOCKET}
RequiresMountsFor={controller_plan} {release}
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=root
Group=root
UMask=0077
ExecStart=/usr/bin/python3 -I {release}/app/scripts/deployment/maintenance_broker.py --plan {controller_plan}
RuntimeDirectory=sleepypod-maintenance-state
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
Restart=on-failure
RestartSec=5
TimeoutStopSec=5
KillMode=control-group
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX
RestrictSUIDSGID=true
CapabilityBoundingSet=
ReadWritePaths=/run/sleepypod-maintenance-state
MemoryMax=64M
TasksMax=16
CPUQuota=10%
''',
    }


def prepare(controller_plan, release, output):
    units = render(controller_plan, release)
    if output.exists() or output.is_symlink():
        raise ValueError('Output must be a new directory')
    output.mkdir(mode=0o700)
    for name, contents in units.items():
        (output/name).write_text(contents)
        (output/name).chmod(0o600)
    manifest = {'format': 'sleepypod-maintenance-plan/1', 'controllerPlan': str(controller_plan),
                'release': str(release), 'environmentLine': ENVIRONMENT_LINE,
                'units': {name: hashlib.sha256(contents.encode()).hexdigest() for name, contents in units.items()},
                'servicesStarted': False, 'coreEnvironmentChanged': False}
    (output/'maintenance-plan.json').write_text(json.dumps(manifest, indent=2)+'\n')
    (output/'maintenance-plan.json').chmod(0o600)
    return manifest


def read_plan(directory):
    manifest_path = directory/'maintenance-plan.json'
    if manifest_path.is_symlink(): raise ValueError('Expected a regular maintenance manifest')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('format') != 'sleepypod-maintenance-plan/1' or manifest.get('environmentLine') != ENVIRONMENT_LINE:
        raise ValueError('Unexpected maintenance plan')
    expected = render(manifest['controllerPlan'], manifest['release'])
    if set(manifest.get('units', {})) != set(expected): raise ValueError('Unexpected maintenance services')
    for name, contents in expected.items():
        path = directory/name
        if path.is_symlink() or path.read_text() != contents or hashlib.sha256(contents.encode()).hexdigest() != manifest['units'][name]:
            raise ValueError('Maintenance service differs from the reviewed template')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--controller-plan', required=True, type=Path)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    arguments = parser.parse_args()
    prepare(arguments.controller_plan, arguments.release, arguments.output)
    print(json.dumps({'plan': str(arguments.output), 'servicesStarted': False, 'coreEnvironmentChanged': False}))


if __name__ == '__main__': main()
