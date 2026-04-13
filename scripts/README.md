# sleepypod installation scripts

**Two simple scripts** for deploying sleepypod to Pod hardware.

## Prerequisites

- Pod 3 (no SD card), Pod 4, or Pod 5
- Root access via JTAG
- WiFi configured
- Software updates disabled

See main [installation guide](../docs/INSTALLATION.md) for hardware setup.

## Installation

Run on the pod:

```bash
curl -fsSL https://raw.githubusercontent.com/sleepypod/core/main/scripts/install | sudo bash
```

This will:
1. **Pre-flight checks** - Verify disk space, network, dependencies
2. **Download code** - From GitHub tarball (or use `--local`)
3. **Detect pod generation** - Auto-detect dac.sock path and pod hardware (`scripts/pod/detect`)
4. **Install Node.js 22** - Binary download (no apt required)
5. **Install dependencies** - With `--frozen-lockfile`
6. **Build application** - Next.js production build (skipped if pre-built)
7. **Database migrations** - Run automatically on startup
8. **Create systemd service** - With auto-restart and hardening
9. **Install CLI tools** - From `scripts/bin/` to `/usr/local/bin/`
10. **Install uv** - Rust-based Python package manager (bypasses broken Yocto stdlib)
11. **Install biometrics modules** - `uv sync` for each module + systemd services
12. **Optional SSH setup** - Interactive prompt for SSH on port 8822 (keys only)

### Install Flow

```mermaid
flowchart TD
    Start([curl install | bash]) --> Preflight[Pre-flight checks\ndisk, network, deps]
    Preflight --> Download{Code source?}

    Download -->|--local| Local[Use code on disk]
    Download -->|default| Release{CI release\navailable?}
    Release -->|yes| Tarball[Download pre-built tarball]
    Release -->|no| Source[Download source tarball\nfallback build on pod]

    Local --> Detect
    Tarball --> Detect
    Source --> Detect

    Detect[Detect pod generation\nscripts/pod/detect] --> Node[Install Node.js 22 + pnpm]
    Node --> Deps[pnpm install --frozen-lockfile --prod]
    Deps --> Build{.next exists?}
    Build -->|yes| Skip[Skip build]
    Build -->|no| BuildApp[pnpm build\n⚠️ needs ~1GB RAM]
    Skip --> Env
    BuildApp --> Env

    Env[Write .env\nDAC_SOCK_PATH, DATABASE_URL] --> DB[Backup existing DB\nMigrations run on startup]
    DB --> Service[Create systemd service\nstart sleepypod]
    Service --> CLI[Install CLI tools\nscripts/bin/ → /usr/local/bin/]

    CLI --> UV{uv\navailable?}
    UV -->|no| InstallUV[Install uv\ncurl astral.sh]
    UV -->|yes| Modules
    InstallUV --> Modules

    Modules[Install biometrics modules] --> UVSync[uv sync per module\ncreates .venv + installs deps]
    UVSync --> ModService[Create module systemd services]

    ModService --> SSH{Interactive\nterminal?}
    SkipBio --> SSH
    SSH -->|yes| SSHSetup[Optional SSH setup\nport 8822, keys only]
    SSH -->|no| Done
    SSHSetup --> Done([Installation complete])
```

## CLI Commands

After installation (installed from `scripts/bin/`):

- `sp-status` - View service status
- `sp-restart` - Restart sleepypod + reconnect frankenfirmware
- `sp-logs` - View live logs
- `sp-update` - Update to latest version from GitHub
- `sp-freesleep` - Switch to free-sleep (persists across reboots)
- `sp-sleepypod` - Switch to sleepypod (persists across reboots)
- `sp-uninstall` - Remove sleepypod and all related services

## Internet Control

Block all WAN internet (keep local network only):

```bash
sudo scripts/internet-control block
```

Restore full internet access:
```bash
sudo scripts/internet-control unblock
```

**Features:**
- Blocks both IPv4 and IPv6 (prevents bypass)
- Preserves local network access
- Keeps mDNS for local discovery
- Connection tracking for established connections

## Service Management

```bash
# Status
systemctl status sleepypod

# Start/stop/restart
systemctl start sleepypod
systemctl stop sleepypod
systemctl restart sleepypod

# Logs
journalctl -u sleepypod -f

# Enable/disable auto-start
systemctl enable sleepypod
systemctl disable sleepypod
```

## SSH Access

During installation, you'll be prompted to configure SSH on port 8822 with keys-only authentication.

If you need to configure SSH later:
1. Edit `/etc/ssh/sshd_config`
2. Set `Port 8822` and `PermitRootLogin prohibit-password`
3. Add your public key to `/root/.ssh/authorized_keys`
4. Restart: `systemctl restart sshd`

Connect with:
```bash
ssh root@<POD_IP> -p 8822
```

## Features

After installation, sleepypod provides:

- **Temperature Scheduling** - Set temperature by day/time
- **Power Scheduling** - Daily on/off cycles with temperature
- **Alarm System** - Vibration alarms with temperature changes
- **System Automation** - Daily priming and reboot schedules
- **Hardware Control** - Direct DAC socket communication
- **Health Monitoring** - Scheduler status and hardware connectivity checks
- **Timezone Support** - Full timezone awareness for all schedules

## Script Structure

```
scripts/
├── install                  # Core orchestrator
├── lib/
│   └── iptables-helpers     # Shared WAN/iptables functions (sourced by sp-update)
├── pod/
│   └── detect               # Pod detection: DAC_SOCK_PATH, POD_GEN
├── bin/                     # CLI tools — copied to /usr/local/bin/ during install
│   ├── sp-status
│   ├── sp-restart
│   ├── sp-logs
│   ├── sp-update
│   ├── sp-freesleep
│   ├── sp-sleepypod
│   └── sp-uninstall
├── deploy                   # Dev deploy (build local, push to pod)
├── push                     # Fast push (pre-built .next only)
└── internet-control         # WAN block/unblock utility
```

## Python Environment (uv)

Biometrics modules use [uv](https://docs.astral.sh/uv/) for Python environment management. uv is a Rust-based tool that creates virtualenvs and installs packages without relying on Python's stdlib (`ensurepip`, `pyexpat`, etc.) — which are broken on Pod 3/4 Yocto images.

Each module has a `pyproject.toml` and `uv.lock`. The install script runs `uv sync` per module, which creates a `.venv` and installs locked dependencies.

## File Locations

- **Installation**: `/home/dac/sleepypod-core/`
- **Database**: `/persistent/sleepypod-data/sleepypod.db` (SQLite with Drizzle ORM)
- **Service**: `/etc/systemd/system/sleepypod.service`
- **Environment**: `/home/dac/sleepypod-core/.env`

## Troubleshooting

### Service won't start

Check logs:
```bash
sp-logs
```

Common issues:
- dac.sock path incorrect (auto-detected from `frank.sh`: Pod 3/4 uses `/deviceinfo/dac.sock`, Pod 5 uses `/persistent/deviceinfo/dac.sock`)
- Port 3000 already in use
- Database initialization failed
- Scheduler failing to start (check timezone in database)

### Web interface not accessible

1. Check service is running: `sp-status`
2. Check firewall isn't blocking port 3000
3. Verify pod IP: `ip -4 addr show "$(ip route | awk '/default/ {print $5; exit}')"`

### Database errors

Reset database:
```bash
cd /home/dac/sleepypod-core
rm /persistent/sleepypod-data/sleepypod.db
pnpm db:generate
pnpm db:push
sp-restart
```

## Deployment

The pod has limited RAM (~512MB) and cannot reliably build the Next.js app. All deployment paths build locally or in CI and ship pre-built artifacts.

### Production Updates (sp-update)

From the pod or the web UI's Software card:

```bash
sp-update              # update to latest main
sp-update feat/alarms  # update to a specific branch
```

How it works:
1. Opens WAN temporarily (toggles iptables)
2. Tries to download a **CI release tarball** first (includes pre-built `.next`) — no build needed on pod
3. Falls back to a **source tarball** from GitHub if no CI release exists
4. Only builds on-pod if `.next` is missing (risky on low-RAM pods — avoid if possible)
5. Installs prod dependencies, runs migrations on startup, restarts service
6. Re-blocks WAN, rolls back on failure

### Dev Deploys (scripts/deploy)

From your development machine:

```bash
./scripts/deploy                           # current branch → default pod (192.168.1.88)
./scripts/deploy 192.168.1.50              # current branch → different pod
./scripts/deploy 192.168.1.88 feat/alarms  # checkout + deploy a branch
```

How it works:
1. Builds Next.js **locally** on your Mac (fast, full RAM)
2. Tars source + `.next` build, pipes over SSH to the pod
3. Runs `scripts/install --local --no-ssh` on the pod (prod deps only, no build)
4. Service restarts automatically

### Fast Push (scripts/push)

Skip the build entirely — push an already-built `.next` directory:

```bash
./scripts/push                # push pre-built .next to default pod
./scripts/push 192.168.1.50   # push to different pod
```

Use this when you've already run `pnpm build` locally and just want to sync.

### Why the pod can't build

Next.js production builds require 1-2GB RAM for Turbopack. The pod has ~512MB. Attempting `pnpm build` on-pod may OOM-kill the process or produce a corrupted build. All deployment paths avoid this by shipping pre-built `.next` artifacts.
