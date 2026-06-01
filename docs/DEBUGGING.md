# Debugging Runbook

A task-oriented index for debugging a pod in the field: symptom → first checks →
where the authoritative detail lives. This does **not** restate the ADRs and
topic docs — it points at them. The desktop **Diagnostics console** (`/debug`)
surfaces most of these signals live.

## Getting onto a pod

Pods run `sshd` on **port 8822** (key-only), not 22.

```bash
ssh -p 8822 root@<pod-ip>
journalctl -u sleepypod.service -n 200 --no-pager   # core app
journalctl -u frank -n 200 --no-pager               # firmware: what the DAC actually did
```

SSH setup and hardening: `scripts/README.md`, `docs/DEPLOYMENT.md`.

## Data paths

| What | Path | Authoritative doc |
| --- | --- | --- |
| App database | `/persistent/sleepypod-data/` | `docs/DEPLOYMENT.md` |
| RAW frames (hot, tmpfs) | `/persistent/biometrics/*.RAW` | `docs/adr/0018-tmpfs-raw-frames.md` |
| RAW archive (cold, eMMC) | `/persistent/biometrics-archive/*.RAW.gz` | `docs/adr/0012-biometrics-module-system.md` |
| DAC socket | `/persistent/deviceinfo/dac.sock` (Pod 5) · `/deviceinfo/dac.sock` (Pod 3/4) | `docs/DEPLOYMENT.md` |

`RAW_DATA_DIR` (default `/persistent`) overrides where readers look for RAW
frames — see `src/streaming/piezoStream.ts` and `src/server/routers/raw.ts`.

## Biometrics empty / "nothing is being written"

The Biometrics page in the console shows a live **data-flow banner** — if it
reads red/amber while the bed is occupied, the ingest pipeline has stalled.

1. Confirm `RAW_DATA_DIR` matches the tmpfs hot dir (`/persistent/biometrics`,
   per ADR-0018). A mismatch makes readers see an empty directory while frank
   writes fine — the classic silent failure (`docs/sleep-detector.md` §9).
2. `ls -la /persistent/biometrics/*.RAW` — are files fresh (mtime moving)?
3. `journalctl -u frank` — is the firmware writing at all?

Deep detail: `docs/adr/0012-biometrics-module-system.md`, `docs/adr/0018-tmpfs-raw-frames.md`.

## Pump stalled but the side reads as "powered"

The Thermal page now plots per-side **target / bed / water** trends. A stalled
pump shows as water + bed flatlining away from target while the side still
reports powered. The guard logic lives in `src/hardware/pumpStallGuard.ts`
(surfaced as the `stalled` verdict via `health.thermal`).

## Database or native-module errors on the pod

The systemd unit hardcodes **`/usr/local/bin/node`** — an ad-hoc `node` on
`PATH` is often the wrong ABI for `better-sqlite3` and will fail to load. The
installer symlinks the correct binary (`scripts/install`); if you run scripts
by hand, use `/usr/local/bin/node` explicitly.

## Service / firmware reference

Service units, null-routed firmware domains, and the frank/Capybara split are
documented in `docs/DEPLOYMENT.md`.
