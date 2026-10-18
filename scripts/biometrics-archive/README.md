# Off-pod biometrics archive

Keep a pod's biometrics history off the pod for good. A pod keeps about four
weeks of RAW sensor archives (the pruner deletes the oldest at 80% disk) and
90 days of vitals. Every night with Apple Watch data is a labelled night for
tuning pod biometrics, so this tool pulls the pod's read-only analysis export
into a long-term store on a laptop or NAS. Run it daily or weekly.

## Pull

```sh
pnpm biometrics:archive pull --pod 192.168.1.88 --dest /Volumes/nas/sleepypod
pnpm biometrics:archive pull --pod pod.local:3000 --dest ~/sleepypod-archive --since 2026-10-01T00:00:00Z --until 2026-10-08T00:00:00Z
pnpm biometrics:archive pull --pod 192.168.1.88 --dest ~/sleepypod-archive --no-raw   # database only
```

Each pull calls `GET http://POD:3000/api/biometrics/analysis-export?start=&end=&raw=1`
([format](../../docs/biometrics-datasets.md#analysis-snapshot-export)). It's read-only on the pod.

- **Window.** Without `--since`, a pull continues from the cursor: the largest
  served window end among this pod's successful pulls. The first pull covers the
  last 14 days. `--until` defaults to now. Ranges longer than 14 days are
  split into 14-day windows, oldest first, and each window is committed on its own.
- **429** (another export is streaming): retried up to 6 times. The wait is the
  pod's `Retry-After`, or else 30 s doubling each time, at most 5 min.
- **413** (the window's RAW is over 2 GiB): the window is halved, oldest half
  first, down to 1 h. Below that the pull fails and tells you to use `--no-raw`.
- **Verification.** The tar streams into `<dest>/.staging/`, hashing each entry
  as it arrives. Nothing is stored until the export checks out: the manifest
  is valid `analysis-export-v1`, it lists exactly the files received with
  matching sizes and SHA-256s, the window is the one requested, and
  `Content-Length` matches. A corrupt, partial or refused pull leaves the store
  unchanged and doesn't move the cursor.
- **Commit order.** RAW blobs first, then the database merge in one
  transaction, then the `archive/` links, then the pull record, which is the
  cursor. If a pull dies part way, the next one repeats the same window, and
  every step is idempotent.
- **Lock.** `<dest>/.biometrics-archive.lock` allows one pull per destination.
  A lock left by a dead process on the same host is taken over. Otherwise the
  pull fails and names the holder.

## Layout

```
<dest>/
  .biometrics-archive.lock      while a pull runs
  <podId>/                      hashed pod id from the manifest; the hostname if it is null (dev machine), with a warning
    biometrics.db               long-term merged database (pod schema + archive_* tables)
    raw/<sha256>.RAW.gz         content-addressed, written once
    archive/<name>.RAW.gz       hard link to raw/ under the pod's original name
    pulls/<timestamp>.json      one per successful window
```

`archive/` names never get overwritten. If the pod reuses a name for different
bytes (counter reset, reinstall), or a file the archiver didn't write is
already there, the new one becomes `<stem>-<sha256[0:12]>.RAW.gz`. That's
listed under `raw.renamed` in the pull record and in the `archive_raw_files`
table. On filesystems without hard links the file is copied.

A pull record holds the pod's manifest verbatim and the requested window. It
also has `raw` counts (new, already stored, linked, copied, renamed), per-table
`tables` counts (snapshot rows, inserted, reassigned, ignored, updated, new
conflicts), the `rows` totals, schema tags, warnings and `cursor`.

`<dest>/<podId>` works directly as the data folder for
`analysis/watch-deviation`: it expects `biometrics.db` and `archive/*.RAW.gz`.
Add `watch.json` yourself, then
`SP_BIOMETRICS_DIR=<dest>/<podId> analysis/watch-deviation/run.sh …`. The
archive database uses a rollback journal, not WAL, so it can be opened from a
read-only mount.

## Merging the database

Each export carries the pod's whole `biometrics.db`, not just the window. The
archive database is created and migrated with this checkout's
`src/db/biometrics-migrations`, so it has the pod's schema plus
`archive_uq_<table>` unique indexes where the pod has no natural key. Before a
merge it's migrated to the newest migration the checkout knows. A snapshot
from a newer pod build fails with "update the checkout" and nothing is stored.
An older snapshot still merges: columns it lacks take their defaults.

Rules (`TABLES` in `merge.ts`):

- **Nothing is deleted.** Rows the pod has pruned (90-day retention, deleted
  sleep records, deleted reference imports) stay in the archive.
- **Integer `id` surrogates** keep the pod's id when it's free. Ids are
  monotonic on one pod. A row whose id is already taken by a different key
  gets a new archive id and counts as `reassigned`. That only happens after the
  pod's database was reset, since the pod id survives reinstalls.
  `vitals_quality.vitals_id` is remapped to the archive id of its vitals row.
- **append**: a row is written once. Insert-or-ignore on the natural key. If a
  key matches but the content differs, the archive keeps its row and the
  pod's copy goes to `archive_conflicts`, recorded once.
- **state**: the pod updates rows in place. The newest snapshot (by manifest
  `generatedAtMs`) overwrites the non-key columns. An older snapshot only
  inserts.
- A row the archive's constraints refuse is kept in `archive_conflicts` with
  reason `rejected`. A table the checkout has no rule for is merged
  append-only on its primary key, with a warning.

| Tables | Natural key | Mode |
|---|---|---|
| `vitals`, `vitals_quality`, `cap_sense_frames` | side, timestamp | append |
| `movement` | side, timestamp (added) | append |
| `bed_temp`, `freezer_temp`, `ambient_light`, `water_level_readings`, `flow_readings` | timestamp | append |
| `prime_events` | timestamp (added) | append |
| `thermal_state` | side, timestamp, is_powered (added) | append |
| `flash_write_samples` | boot_id, timestamp (added) | append |
| `calibration_runs` | side, sensor_type, created_at (added) | append |
| `reference_measurements` | import_id, record_key | append |
| `biometric_runtime_configs` | side, generation | append; after a pod reset reuses a generation, the new config is a conflict |
| `biometric_holdout_accesses` | id (text) | append |
| `biometric_shadow_samples` | run_id, sequence | append |
| `sleep_records` | side, entered_bed_at, left_bed_at (added) | state; editing a record's times on the pod adds a second row |
| `water_level_alerts` | type, started_at (added) | state (dismissed_at) |
| `pump_alerts` | timestamp, type, side (added) | state (acknowledged/dismissed) |
| `health_runs` | check_id, started_at (added) | state (last_seen_at) |
| `calibration_profiles` | side, sensor_type | state: the current profile; history is in `calibration_runs` |
| `reference_stages` | side, start, source | state: a corrected import replaces the label |
| `reference_samples` | side, metric, timestamp, source | state (Watch breathing rate and HRV SDNN) |
| `reference_vitals` | side, timestamp, source | state |
| `reference_imports` | id (text) | state (deleted_at_ms) |
| `biometric_processing_runs`, `biometric_experiments`, `biometric_backtest_jobs`, `biometric_raw_sources`, `biometric_shadow_runs`, `biometric_dataset_raw_artifacts` | id (text) | state |
| `biometric_backtest_results` | job_id | state |
| `biometric_raw_artifacts` | content_hash | state |
| `biometric_runtime_receipts` | side, component, generation | state |
| `biometric_datasets` | id (text) | state, but `snapshot` and `byte_length` keep their first value: releasing a dataset on the pod replaces them with a tombstone |

Bookkeeping tables: `archive_snapshots` (each merged snapshot's SHA-256,
`generatedAtMs` and migration), `archive_raw_files` (RAW hash → original name
→ `archive/` name) and `archive_conflicts`. A test fails when a migration adds
a table without a rule here.

## Storage interface and S3

`store.ts` defines the seam. Only `LocalStore` is implemented.

```ts
interface Store {
  put(key, stream, { sha256, size, mtimeMs? })   // atomic replace; rejects bytes that don't match
  get(key): Readable
  exists(key): boolean
  list(prefix): string[]                         // recursive, sorted
  link(from, to): 'linked' | 'copied'            // fails if `to` exists
}
```

Keys are `<podId>/raw/<sha256>.RAW.gz`, `<podId>/archive/<name>` and
`<podId>/pulls/<timestamp>.json`. The caller enforces write-once
(`exists` → skip). The SQLite merge needs a local file, so `biometrics.db`
stays outside the interface, at `<dest>/<podId>/biometrics.db`. The
staging directory and the lock file are local too.

An S3 backend would implement `put` as a multipart upload with
`x-amz-checksum-sha256`, `exists` as `HeadObject`, `list` as `ListObjectsV2`
and `link` as `CopyObject` (`'copied'`). `pull.ts` would take a local work
directory for the database, staging and lock, plus the bucket store for
everything else. After each merge the database would be uploaded as
`<podId>/biometrics.db` (versioned bucket), and on a fresh machine it would be
downloaded first. The cursor already comes from `pulls/` in the store.

## Scheduling

Nothing is installed for you. Pick a time after the night's last archive is
written (about 45 min after you get up).

cron (Linux/NAS):

```cron
30 12 * * * cd /path/to/sleepypod-core && pnpm -s biometrics:archive pull --pod 192.168.1.88 --dest /srv/sleepypod-archive >> /var/log/sleepypod-archive.log 2>&1
```

launchd (macOS), `~/Library/LaunchAgents/com.sleepypod.biometrics-archive.plist`, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sleepypod.biometrics-archive.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sleepypod.biometrics-archive</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd ~/src/sleepypod-core &amp;&amp; pnpm -s biometrics:archive pull --pod 192.168.1.88 --dest /Volumes/nas/sleepypod</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>/tmp/sleepypod-archive.log</string>
  <key>StandardErrorPath</key><string>/tmp/sleepypod-archive.log</string>
</dict>
</plist>
```

A missed run (laptop asleep, pod offline) is harmless: the next run picks up at the cursor. Only RAW older than the pod's
retention (about four weeks) is lost, so don't go longer than that between runs.

**Privacy:** the archive has the full biometrics database for both sides of the
bed plus raw sensor waveforms. Keep it on trusted machines.
