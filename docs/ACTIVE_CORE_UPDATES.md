# Updating an active isolated Core

`scripts/deployment/upgrade.py` updates an already activated Core installation.
It does not activate the retained Free Sleep controller or change boot selection.
Use the initial migration/handoff procedure for a first installation instead.

Use the complete `scripts/deployment/` module set from the reviewed commit,
including `maintenance_status.py` and `recovery_privacy.py`; do not mix helper
versions. Current tools hold legacy update/restore when personal household
records exist, including unassigned drafts. See the [personal recovery
boundary](PERSONAL_RECOVERY_BOUNDARY.md). The hold preserves data; it is not yet
a supported personal-account recovery workflow.

Before applying, verify the complete offline release manifest, run the matching
software checks, and confirm the bed is empty, connected and filled with an
attendant nearby. The tool requires idle thermal telemetry before switching and
for a continuous 30-second readiness window afterwards. It does not send an
actuator command to make the bed idle. Saved routines can resume at startup.

Render a new controller plan and maintenance plan with `service_plan.py` and
`maintenance_plan.py`. Only the release path and an explicitly verified sensor
source may change. Data, credentials, DAC socket and maintenance socket must
stay identical. Other changes require a separately reviewed migration. Keep all
old release files.

```text
active Core → stop maintenance and all Core writers → private data backup
            → byte/owner/mode verification → restore rehearsal
            → replace reviewed units → start candidate → verify freshness
            → compare saved routines/history → retain verified release
                         failure ↓
                restore previous data and Core units
```

The operation directory must be new and beneath a private root-owned directory.
The command runs as root on the Pod. Pass actual reviewed paths:

```sh
python3 upgrade.py apply --operation /persistent/sleepypod-unified/updates/new-update \
  --old-plan /persistent/sleepypod-unified/service-plan-OLD \
  --new-plan /persistent/sleepypod-unified/service-plan-NEW \
  --old-maintenance /persistent/sleepypod-unified/maintenance-plan-OLD \
  --new-maintenance /persistent/sleepypod-unified/maintenance-plan-NEW
```

`upgrade.json` is a durable private phase record. It contains hashes and paths,
never the owner connection key. Backups contain private health and pairing data;
keep them private and make an off-Pod copy. Do not commit or publish them.

After a failed update, automatic rollback restores the previous Core and its
quiesced data only when the recovery guards still pass. Personal records created
during the update or unreadable household state prevent that replacement and
require recovery without starting the older runtime. A separate `replaced-data-*` directory retains the failed
candidate's data for inspection. Unrecognized units, a corrupt backup, failed
restoration or an interrupted restoration leave `recovery_required` instead of
silently overwriting unknown state. Inspect that state before retrying.

For an attended rollback after successful activation:

```sh
python3 upgrade.py rollback --operation /persistent/sleepypod-unified/updates/new-update
```

This restores data to the update's snapshot; newer data remains in
`replaced-data-*`. It requires an idle readiness window and is not an automatic
background downgrade. An interrupted restore may need manual path recovery.

New activation records explicitly identify the upgrade journal and do not claim
a new Free Sleep migration trial. Old records become `superseded_by_upgrade`.
Physical temperature, vibration and base behavior remain separately unverified.

Validation: `python3 -m unittest discover -s scripts/deployment -p 'test_*.py'`
covers preservation, failure after migration, changed routines, corrupt backups,
foreign units, data-path changes, backup failures and previous-Core restoration.
