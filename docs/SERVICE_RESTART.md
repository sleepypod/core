# Service restart contract

Device → Restart service uses authenticated `POST /api/health/restart-service`
with `{ "unit": "sleepypod.service" }`. The three existing sensor targets remain
supported. The endpoint never invokes the updater, downloads a version, selects
a different controller, or reboots the operating system.

The response remains `{ ok: boolean, message: string }`. An accepted Core or
broker request means **requested**, not completed or physically verified.
Definite pre-submission refusals return `ok: false`. A lost reply, interrupted
process, unsuccessful systemctl exchange, or unknown broker receipt produces an
error: clients must reconnect and inspect health before considering another
attempt. There is no automatic retry or fallback. Web Device and Health actions
show the returned message and require an explicit reconnect after acceptance or
uncertainty. Checking telemetry does not itself prove successful recovery.

## Existing installations

Without `SLEEPYPOD_MAINTENANCE_SOCKET`, the existing sudo transport is retained.
Core uses `sudo -n systemctl --no-block restart sleepypod.service`; module
commands retain their original synchronous form. The standard installer grants
only the exact additional Core command. A pre-execution failure remains a
refusal; an interrupted or unsuccessful child exchange remains uncertain.

## Isolated deployment supervisor

Core keeps `NoNewPrivileges=true`. Its optional supervisor runs separately as
root, behind `/run/sleepypod-maintenance/control.sock` (`root:dac`, mode `0660`).
It has no TCP listener, no hardware client, no API key, no shell command parser,
and no updater. It can request only Core and the three named sensor services.
The root service itself uses `NoNewPrivileges`, an empty capability bounding
set, a read-only filesystem, private devices, and a writable private runtime
receipt directory.

```mermaid
flowchart LR
  Owner[Authenticated owner request] --> Core[Unprivileged Core]
  Core --> Socket[Private Unix socket]
  Socket --> Gate[Peer + invocation + plan + expiry checks]
  Gate --> Receipt[Durable attempt]
  Receipt --> Systemd[Fixed systemd request]
  Systemd --> Reconnect[Reconnect and inspect health]
```

Every request has a random ID, the systemd invocation ID, and a lifetime of at
most five seconds. Kernel peer credentials must identify the current Core main
process under `dac`; the exact systemd cgroup and invocation must match. The
selected root-owned plan must match installed unit bytes and have no unexpected
overrides or pending jobs. A Core restart also checks its dependent sensor
units. Validation runs again after writing the attempt receipt.

The broker shares the selected plan's existing `handoff.lock` with migration,
activation, and replacement. It opens that lock read-only and cannot rewrite
the plan. A handoff trial holds the lock throughout its transition, so restart
requests are intentionally refused during that trial. It submits fixed
`systemctl --no-block --job-mode=fail` commands; Core
uses `try-restart`, so it cannot start an inactive controller during rollback.
Sensor recovery may start an inactive module only while its verified Core parent
is current. Root operator actions outside these tools still require operational
coordination.

The receipt in `/run/sleepypod-maintenance-state/attempt.json` is written and
flushed before submission, and retained across supervisor restarts. Duplicate
requests never submit again. New attempts have a 60-second cooldown. An
interrupted attempt stays unknown for that Core invocation; reconnecting does
not erase the receipt or authorize replay. After a new Core invocation, the
cooldown still applies. A corrupt or unreadable receipt refuses maintenance.

If reconciliation is needed, inspect the root-only receipt, systemd jobs, unit
status, and invocation before archiving a resolved receipt. Do not delete an
unknown receipt merely to make retry available. Receipts contain service and
request metadata, not credentials or biometric measurements.

## Deployment and qualification

`scripts/deployment/prepare_offline.py` includes the broker and declares
`maintenanceProtocol: 1` in the runtime manifest. Existing bundles without that
declaration are refused, even if a similarly named file is present. Provisioning
checks the broker's hash and the build's source identity against the manifest.

Add this optional field to the new Core service-plan configuration:

```json
"maintenanceSocket": "/run/sleepypod-maintenance/control.sock"
```

`service_plan.py` places the setting in the reviewed Core unit. Existing plans
without the field render exactly as before. Do not edit the private credential
environment: an overriding maintenance entry there is refused. Prepare and
select this new stopped Core plan using the usual `handoff.py`/`replace_plan.py`
workflow before provisioning its helper. Keep the previous plan and release.

`maintenance_plan.py` renders the two separate units for review:

```sh
python3 scripts/deployment/maintenance_plan.py \
  --controller-plan /persistent/sleepypod-unified/service-plan-REVISION \
  --release /persistent/sleepypod-unified/releases/REVISION \
  --output /persistent/sleepypod-unified/maintenance-plan-REVISION
```

Rendering does not install or start anything. With the new Core plan stopped
and disabled, and retained Free Sleep active and enabled, run as root:

```sh
python3 scripts/deployment/maintenance_install.py inspect --plan /persistent/sleepypod-unified/maintenance-plan-REVISION
python3 scripts/deployment/maintenance_install.py install --plan /persistent/sleepypod-unified/maintenance-plan-REVISION
python3 scripts/deployment/maintenance_install.py enable --plan /persistent/sleepypod-unified/maintenance-plan-REVISION
```

`inspect` is read-only and shares the existing controller lock. `install`
publishes only absent unit files, records its intent before writes, and leaves
both stopped. `enable` selects only the maintenance socket at boot and starts
its listener. The helper activates on a connection. It does not inherit Core's
environment or owner key. These commands never start Core or stop Free Sleep.

The installer verifies private root-owned plans, unchanged Core/legacy units,
safe path ownership, and matching release identity. It shares the controller's
existing `handoff.lock` and serializes its own operations. It does not rewrite
the credential file or any controller, sensor, SSH or stock firmware unit.

To recover an interrupted installation or undo enablement:

```sh
python3 scripts/deployment/maintenance_install.py rollback --plan /persistent/sleepypod-unified/maintenance-plan-REVISION
```

Rollback requires retained Free Sleep ownership too; if Core has been activated,
first use its existing controller rollback procedure. A completed activation
rollback is accepted. Cleanup uses the private installation journal and exact
unit hashes, so it can remove a failed helper even when its runtime or credential
file is unavailable. Changed units, overrides and unverified active processes
are preserved for operator review. Interrupted enablement is reconciled through
rollback rather than replaying the enable command.

Rollback stops/disables/removes only the two matching maintenance units. It
preserves plans, journals, releases, databases, credentials and broker attempt
receipts. Repeated rollback is safe after verified removal. Use a newly rendered
maintenance-plan directory for a later installation rather than erasing its
journal. Before replacing a Core plan, roll back its bound helper while the old
Core plan is stopped, then provision the matching helper for the new plan.

The broker requires live qualification on each deployment. Tests use temporary sockets, synthetic process state,
and substituted systemd effects; they cannot establish live restart behavior.
`python3 scripts/deployment/probe_maintenance.py` provides an inert Linux probe
when run as root on a host with the `dac` account. It uses the real Unix socket,
kernel peer credentials, NoNewPrivileges, and a read-only existing lock. Service
properties and submission are deliberately substituted; no service command is
executed. Its temporary `/run` files are removed on exit. This checks IPC and
receipt behavior on the target OS without qualifying a live restart.
Attended qualification must verify requested versus observed restart, Core and
sensor recovery, preserved controller ownership, interrupted replies, and the
rollback path. No unattended temperature, base, vibration, or house automation
is authorized by this maintenance feature.

References: [systemd socket permissions](https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html),
[kernel peer credentials](https://man7.org/linux/man-pages/man7/unix.7.html),
[systemd job modes and try-restart](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html),
[retained runtime directories](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html),
[No New Privileges](https://docs.kernel.org/userspace-api/no_new_privs.html).
