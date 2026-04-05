# Deployment

How code gets from development to the Pod — a Yocto-based embedded Linux device (aarch64) with 2GB RAM, no package manager, no C compiler, no git, and WAN blocked by iptables.

## Three Deployment Paths

### Path 1: Mac Deploy (Development)

Builds locally on the Mac, pushes artifacts to the Pod over LAN. No WAN needed.

```bash
./scripts/deploy                           # current branch -> 192.168.1.88
./scripts/deploy 192.168.1.50              # different pod
./scripts/deploy 192.168.1.88 feat/alarms  # specific branch
```

Uses `tar | ssh` instead of rsync (not available on Pod). Cleans stale files while preserving `node_modules`, `.env`, and databases. Requires SSH on port 8822 with key auth.

### Path 2: CI Release (Production)

GitHub Actions builds on push to `main` and version tags. Produces a tarball with source + `.next` (pre-built). Tagged releases publish as GitHub Release assets.

The Pod downloads pre-built tarballs via `sp-update`, so it never runs `next build` (which needs more RAM than the Pod has).

### Path 3: Remote Update (Web UI / iOS)

Self-update via `system.triggerUpdate` tRPC endpoint. Opens iptables temporarily, downloads release tarball, installs, closes iptables.

```bash
sp-update              # latest release
sp-update feat/alarms  # specific branch (source only, needs build)
```

If update fails: iptables restored, service restarts with existing code, database restored from backup.

## Why Build Off-Device

Next.js with Turbopack needs more memory than the Pod's 2GB (no swap). The `.next` output is platform-independent JavaScript — only `better-sqlite3` requires a platform-specific binary, handled by `prebuild-install`.

## Yocto Constraints

The Pod runs "Eight Layer 4.0.2" (Yocto kirkstone). Key constraints and solutions:

| Constraint | Solution |
|-----------|----------|
| No package manager | Node.js via binary tarball from nodejs.org |
| No C compiler | `prebuild-install` for native modules (better-sqlite3) |
| No rsync | `tar + ssh` pipe for file sync |
| No git | GitHub tarball API and release assets |
| 2GB RAM, no swap | Build off-device, deploy only runtime artifacts |

## Network Security

Two independent layers block the Pod's stock processes from phoning home:

1. **iptables** — OUTPUT chain DROPs all non-LAN, non-NTP traffic
2. **/etc/hosts null routes** — Stock firmware domains resolve to `0.0.0.0`, preventing exfiltration even when iptables are temporarily opened for updates

Blocked domains: `raw-api-upload.8slp.net`, `device-api-ws.8slp.net`, `api.8slp.net`, `app-api.8slp.net`, `client-api.8slp.net`.

Why not stop frankenfirmware? It also handles sensor/hardware communication (capSense, temperatures, pump, piezo). Stopping it breaks all biometrics. See [[hardware-protocol]].

## Pod Environment

| Component | Detail |
|-----------|--------|
| OS | Eight Layer 4.0.2 (Yocto kirkstone) |
| Arch | aarch64 (ARM64) |
| RAM | 2GB (no swap) |
| Node.js | Binary tarball install |
| DAC socket | Auto-detected from frank.sh |

Key file locations: app at `/home/dac/sleepypod-core`, config DB at `/persistent/sleepypod-data/sleepypod.db`, biometrics DB at `/persistent/sleepypod-data/biometrics.db`.

## Coexistence with free-sleep

Both services bind to port 3000. Switch with `sp-sleepypod` / `sp-freesleep`. Settings and data preserved — only changes which server handles requests.

## Sources

- `docs/DEPLOYMENT.md`
- `docs/adr/0013-yocto-deployment-toolchain.md`
