# ADR: tmpfs for live RAW frames + gzip cold archive on eMMC

## Context

Frankenfirmware writes ~1 GB/day of CBOR-encoded `*.RAW` frames into `/persistent` (eMMC). Three concerns drove a redesign:

1. **eMMC wear** — cheap consumer eMMC TBW budgets survive years at 1 GB/day, but write-amplification (FTL block remap, garbage collection, partial-block updates) compresses that. The pod runs unattended for years; reducing live writes is cheap insurance.
2. **Forensic window** — frank prunes RAW to ~24 h on disk by default. Several Pod 3 dialect bugs (#395, #486) were diagnosable only because reporters manually attached `.RAW` files to draft PRs. That workflow doesn't scale.
3. **Take-my-data-with-me** — users with multiple weeks of biometric history have no path to extract or migrate it.

`biometrics.db` (the *processed* HR/HRV/sleep-record metrics surfaced in the iOS/web app) already lives durably on disk and is unaffected. RAW is the upstream signal that sidecar processors consume and discard.

## Decision

Mount a **500 MB tmpfs at `/persistent/biometrics`**, redirect frankenfirmware's CWD there, and run an **archiver + pruner** that gzips RAW frames into `/persistent/biometrics-archive/` on eMMC.

```
frank → /persistent/biometrics/         (tmpfs, hot live RAW)
           ↓ linker every 1 min: hard-link the live frame (same tmpfs, same inode)
        /persistent/biometrics/.pending/<seqno>.RAW
           ↓ archiver every 15 min: gzip released frames, atomic rename
        /persistent/biometrics-archive/<seqno>.RAW.gz
           ↓ pruner every 15 min: drop oldest until df < 80%
```

The linker exists because the firmware deletes a finished frame before any
periodic archiver can see it — see "Rotation deletes the finished frame" below.

### Firmware integration without a binary patch

Frank is `cd /persistent && exec frankenfirmware`. The binary writes RAW with relative paths and updates `SEQNO.RAW` (sequence counter) in place. Three things made the migration safe without recompiling firmware:

1. RAW filenames are relative (`%08lX.RAW`) — changing CWD redirects them.
2. `SEQNO.RAW` is overwritten via `fopen("w")` truncate-write — verified empirically by inode stability (Pod 5: inode 13 unchanged since 2025-06-13). A symlink at `/persistent/biometrics/SEQNO.RAW → /persistent/SEQNO.RAW` lets writes pass through to the eMMC target.
3. State subdirectories (`deviceinfo/`, `settings/`, `heat/`, `vector/`, `system-connections/`, `free-sleep-data/`) are also symlinked from tmpfs back to `/persistent` — firmware reads/writes them transparently.

`PodConfiguration.json` uses an absolute path (`/persistent/PodConfiguration.json`) and is unaffected.

The `frank.sh` patch is a single-line `cd` change with a timestamped backup and rollback path baked into `sp-uninstall`.

## Volatility tradeoff

tmpfs loses contents on reboot. The acceptable loss window is bounded by the archiver cadence:

- **Clean reboot**: archiver runs on shutdown? No — it's a periodic timer, not an `OnShutdown` hook. Files newer than 15 min are unarchived. Same as unclean reboot.
- **Unclean reboot**: up to ~30 min of live waveform lost (one rotation period the archiver hadn't picked up yet, plus the in-progress file the archiver intentionally skips while firmware is still writing it).
- **`biometrics.db` rows are unaffected** — sidecar processors (piezo-processor, sleep-detector, environment-monitor) consume RAW frames as they stream and persist HR/HRV/BR/session rows to SQLite on the same `/persistent/sleepypod-data/` (eMMC) path. Vitals durability is unchanged.

Loss of 30 min of upstream waveform is a worthwhile trade for years of eMMC wear avoidance plus an indefinitely growable cold archive (capped by the pruner at 80% disk).

## Rotation deletes the finished frame (the linker)

The archiver as first designed selected `find "$TMPFS_DIR" -name '*.RAW' -mmin
"+$KEEP_RECENT_MIN"` — everything except the frame the firmware might still be
writing. On current firmware that set is *always* empty: every run logged
`archiver: archived=0 removed=0 failed=0` and the cold archive stayed at
whatever the one-time install migration put there.

Measured on a Pod 4 (read-only observation of a live rotation):

- The logger rotates every **~15 min**, ~10 MB per frame (≈1 GB/day).
- At rotation the previous name is **already gone** from the directory — within
  a second of the successor appearing. The firmware's file descriptors have both
  moved to the new frame and tmpfs usage drops straight back to the size of the
  fresh file, so the inode is fully released: there is no deleted-but-open
  grace period to exploit either.
- Journal order per rotation: `raw_logger.h startNewLogFile|[logger] writing to
  <new>.RAW` → `[Upload] Ending Batch` → `[seq] save - checkpoint: <previous>`
  → `[cloud] [Upload] File complete/File to upload -> <new>.RAW` → `[Upload]
  Starting Batch`.
- Nothing in this repo removes `*.RAW` on a schedule: the archiver only after a
  successful gzip, the pruner only inside `biometrics-archive/`, and
  `POST /raw/files/delete` only when asked. The firmware also ships
  `/opt/eight/bin/defibrillator.sh`, whose `cleanup_raw_if_out_of_space` sweeps
  `find /persistent/ -name '*.RAW'` when free space runs low — an emergency path,
  not the per-rotation delete, and it spares the `*.RAW.gz` archive.

So the deleter is frankenfirmware itself, at rotation, and the deletion window
is effectively zero. No cadence and no mtime/newest-file threshold can win that
race — the old design also happened to pair a 15-minute `KEEP_RECENT_MIN` with a
15-minute rotation, which would have made it marginal even against a firmware
that left the file behind.

**Decision: pin frames with a second hard link while the firmware still holds
them.** `sleepypod-biometrics-linker.timer` runs every minute and hard-links each
live `*.RAW` into `/persistent/biometrics/.pending/`. While both names exist they
are one inode — no extra tmpfs, no copy, and everything the firmware appends
after the link still lands in the pinned frame. When the firmware unlinks its
own name, ours keeps the inode alive; the archiver's second pass gzips a pinned
frame to eMMC once the live name is gone, then drops the link.

Properties that matter:

- **eMMC wear unchanged in kind.** Linking is tmpfs-only. The gzip pass keeps its
  15-minute batch cadence, so eMMC still sees one sequential compressed write
  per frame instead of a continuous append stream. What does change is that the
  archive now actually grows (≈gzip of ~1 GB/day), and the pruner's 80% cap turns
  that into a disk-bounded window — days to a couple of weeks of replayable raw
  frames depending on free space, which is the outcome this ADR wanted.
- **Live writes are protected.** If the archiver cannot drain (eMMC full, gzip
  failing), pinned links would otherwise accumulate in the 500 MB tmpfs and
  starve the firmware. The linker caps the pending set at `PENDING_MAX_PCT`
  (default 50%) of the tmpfs and drops oldest-first, mirroring the pruner:
  recent nights are the ones worth replaying.
- **Invisible to every other reader.** `.pending/` is a dot-prefixed
  subdirectory; the sidecars (`modules/common/raw_follower.py`), `piezoStream`,
  the calibrator, `/raw/files`, the export route, `sp-status` and the NATS
  transition helper all scan one directory level for names ending in `.RAW`, so
  none of them see pinned links — and the firmware's logger never looks there.
- **Frames pinned but not yet gzipped are still volatile.** They live in tmpfs
  (lost on reboot) and are named `*.RAW` under `/persistent`, so the firmware's
  low-space sweep can drop them too. The gzipped archive is the durable copy.
- **The NATS transition still cannot lose data.** `remove_biometrics_archiver_for_nats`
  archives with `KEEP_RECENT_MIN=-1` and now refuses to unmount the tmpfs while
  any unarchived pinned link remains, exactly as it already did for live frames.

## Alternatives considered

- **Overlayfs** with tmpfs upper layer over `/persistent`: would route ALL writes (DBs, settings, etc.) through tmpfs upper, breaking durability of everything else. Per-file routing isn't supported by overlayfs.
- **LD_PRELOAD shim**: intercept `open()` for `*.RAW` and redirect. Hacky, fragile under firmware updates.
- **inotify-watch + post-write move**: doesn't reduce eMMC writes (writes happen first, then move).
- **Shorter archiver cadence / "archive everything but the newest file"** instead of pinning: still loses a sub-second race, and would have to gzip a frame the firmware may still be appending to.
- **systemd `.path` unit on `PathExistsGlob=/persistent/biometrics/*.RAW`**: path units fire on a false→true transition of the condition. The glob is *always* true (there is always a live frame), so a new frame arriving while the previous one exists never triggers it.
- **inotify watcher daemon** (`IN_CREATE` on the tmpfs): the right shape, but the pods ship no `inotifywait`, and it means a long-running daemon where a one-minute timer over a 15-minute rotation already pins every frame minutes early.
- **Tailing the journal for `startNewLogFile`**: parses firmware log text, and the rotation line is logged *after* the previous frame is already unlinked — too late.
- **Copying rather than hard-linking**: needs 2× tmpfs for the frame plus a full read every rotation, and a copy that starts after the unlink still gets nothing.
- **Archiver-only, no tmpfs**: hits the cold-archive and disk-cap goals but doesn't reduce eMMC wear. Considered as a fallback if the firmware patch had been unsafe; not needed once `SEQNO.RAW` write-through was verified.

## Rollback

`scripts/bin/sp-uninstall` restores `frank.sh` from `frank.sh.bak-pre-tmpfs-*` (most recent), tears down mount unit + drop-ins + timers, and leaves the cold archive intact for forensics.

## Firmware-variant applicability

The frank.sh-shim assumption holds on a shrinking slice of the fleet. As of 2026-05, three firmware generations coexist:

| Era | `frank.sh` | `nats-server` | `/persistent/jetstream` | RAW write path | Helper behavior |
|---|---|---|---|---|---|
| Old (Pod 3, Pod 4, early Pod 5) | present | absent | absent | frankenfirmware via `cd /persistent` shim | Patch shim → cwd `/persistent/biometrics`; mount + archive + prune as designed in this ADR |
| Mid (~2025 → April 2026) | **absent** | absent | absent | frankenfirmware writes `/persistent/*.RAW` directly (shim removed in firmware ~year ago) | No shim to patch; mount + archive still useful as a cold-storage rotation against the live `/persistent/*.RAW` files |
| New (April 2026+, e.g. `rat_version ca35aafa`) | absent | active | present | frankenfirmware → NATS JetStream stream `raw` (subject `raw.>`); no `.RAW` files written | Tmpfs + cd-patch workflow inapplicable; skip install entirely. Biometrics ingestion needs a NATS consumer (sleepypod-core-54) — out of scope for this ADR |

`scripts/lib/biometrics-archiver-helpers` gates on `[ -d /persistent/jetstream ] && systemctl cat nats-server.service` (installed firmware identity, independent of transient health). On that path it archives remaining RAW frames and removes the legacy timers, firmware shim override, and tmpfs mount before skipping installation. Mid-era pods continue on the existing warn-and-continue path that has carried them for ~year. See PR #594.

## Refs

- Ticket: sleepypod-core-19
- Follow-up epic for new firmware: sleepypod-core-54 (NATS JetStream consumer)
- GH issue: #493 (full design doc)
- Live validation: Pod 5 fw ca35aafa on 2026-05-04 — see PR #499
- Rotation-delete diagnosis (`archived=0` forever) + pinning linker: observed on Pod 4 firmware, 2026-09
- Firmware-variant gating fix: PR #594
