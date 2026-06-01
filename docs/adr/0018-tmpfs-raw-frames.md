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
           ↓ archiver every 15 min: gzip oldest, atomic rename
        /persistent/biometrics-archive/<seqno>.RAW.gz
           ↓ pruner every 15 min: drop oldest until df < 80%
```

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

## Alternatives considered

- **Overlayfs** with tmpfs upper layer over `/persistent`: would route ALL writes (DBs, settings, etc.) through tmpfs upper, breaking durability of everything else. Per-file routing isn't supported by overlayfs.
- **LD_PRELOAD shim**: intercept `open()` for `*.RAW` and redirect. Hacky, fragile under firmware updates.
- **inotify-watch + post-write move**: doesn't reduce eMMC writes (writes happen first, then move).
- **Archiver-only, no tmpfs**: hits the cold-archive and disk-cap goals but doesn't reduce eMMC wear. Considered as a fallback if the firmware patch had been unsafe; not needed once `SEQNO.RAW` write-through was verified.

## Rollback

`scripts/bin/sp-uninstall` restores `frank.sh` from `frank.sh.bak-pre-tmpfs-*` (most recent), tears down mount unit + drop-ins + timers, and leaves the cold archive intact for forensics.

## Refs

- Ticket: sleepypod-core-19
- GH issue: #493 (full design doc)
- Live validation: Pod 5 fw a35aafa on 2026-05-04 — see PR #499
