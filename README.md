<p align="center">
  <a href="https://sleepypod.github.io/"><img src="public/logo.png" width="80" height="80" alt="sleepypod" /></a>
</p>

# sleepypod — local-first Pod mattress controller

[![CI](https://github.com/sleepypod/core/actions/workflows/test.yml/badge.svg?branch=dev)](https://github.com/sleepypod/core/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/sleepypod/core/branch/dev/graph/badge.svg)](https://codecov.io/gh/sleepypod/core)
[![Release](https://img.shields.io/github/v/release/sleepypod/core?sort=semver)](https://github.com/sleepypod/core/releases/latest)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/discord/1450213183653679205?logo=discord&logoColor=white&label=discord)](https://discord.gg/UMmv5R6MXa)

Self-hosted control app for Pod 3, 4, and 5. Runs on the Pod's stock embedded Linux — replaces the cloud-bound controller with a local web UI, scheduler, on-device biometrics, and opt-in integrations for Home Assistant (MQTT), Apple Home (HomeKit), and AI assistants (MCP).

**Documentation lives at [sleepypod.github.io](https://sleepypod.github.io/getting-started/).** This README covers installing and working on the code; the docs site covers everything else.

**No Pod? [Try the live demo](https://sleepypod.vercel.app).** It runs the real web UI against simulated Pod data in your browser, so you can change temperatures, edit schedules, and browse sleep history without hardware.

<p align="center">
  <a href="https://sleepypod.github.io/core/"><img src="docs/images/core-temperature.png" width="1000" alt="sleepypod core web UI with per-side temperature controls, sidebar navigation, and the schedule and sleep timeline" /></a>
</p>

The web UI brings temperature, schedules, Autopilot, sleep, and system diagnostics into one place. Control the same Pod from the [iOS app](https://sleepypod.github.io/ios/) or a bedside [M5 rotary dial](https://sleepypod.github.io/dial/).

<p align="center">
  <a href="https://sleepypod.github.io/ios/"><img src="docs/images/ios-temperature.png" width="220" alt="sleepypod iOS app temperature control" /></a>
  &nbsp;&nbsp;
  <a href="https://sleepypod.github.io/dial/"><img src="docs/images/dial-cooling.png" width="220" alt="sleepypod rotary dial showing a cooling target" /></a>
</p>

<sub>Real product captures from the [documentation site](https://github.com/sleepypod/sleepypod.github.io/blob/d3b4e86e0153944fba3c92fe96f04aca34db7165/capture/manifest.json). The web UI capture uses disposable demo data. See [asset provenance](docs/images/README.md).</sub>

<p align="center">
  <a href="https://sleepypod.vercel.app">Live demo</a> · <a href="https://sleepypod.github.io/getting-started/">Get started</a> · <a href="https://sleepypod.github.io/core/">User guide</a> · <a href="https://sleepypod.github.io/developers/">Developer docs</a> · <a href="https://sleepypod.github.io/troubleshooting/">Troubleshooting</a> · <a href="https://github.com/sleepypod/core/issues">Issues</a>
</p>

---

## Install

1. **Get a root shell on the Pod.** Starting from a stock Pod? Follow [Open your Pod and get root access](https://sleepypod.github.io/core/root-access/) — parts list, enclosure photos, Tag-Connect wiring, and serial login. You do not need to install free-sleep first.
2. **Run the installer on the Pod** (not on your computer):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/sleepypod/core/main/scripts/install -o /tmp/sleepypod-install
   less /tmp/sleepypod-install
   bash /tmp/sleepypod-install
   ```

3. **Open `http://POD_IP:3000`** from a browser on the same network.

[Install and update Core](https://sleepypod.github.io/core/installation/) covers verification, `sp-update`, and the `sp-*` helper commands. The [script reference](scripts/README.md) documents installer flags and file locations.

## Guides

| Using sleepypod | Developing sleepypod |
|---|---|
| [Temperature and manual holds](https://sleepypod.github.io/core/temperature/) | [Architecture](https://sleepypod.github.io/developers/architecture/) |
| [Schedules and alarms](https://sleepypod.github.io/core/schedules/) · [Autopilot](https://sleepypod.github.io/core/autopilot/) | [Core development](https://sleepypod.github.io/developers/core/) · [API reference](https://sleepypod.github.io/developers/api/) |
| [Sleep and biometrics](https://sleepypod.github.io/core/biometrics/) | [Sensor pipeline and calibration](https://sleepypod.github.io/developers/sensor-pipeline/) |
| [HomeKit and MQTT](https://sleepypod.github.io/core/integrations/) ([topics and env vars](docs/integrations.md)) · [MCP for agents](https://sleepypod.github.io/core/mcp/) | [Temperature controller](https://sleepypod.github.io/developers/temperature-control/) · [Hardware](https://sleepypod.github.io/developers/hardware/) |
| [System diagnostics](https://sleepypod.github.io/core/system/) · [Settings and backups](https://sleepypod.github.io/core/settings/) | [Build, test, and release workflows](https://sleepypod.github.io/developers/workflows/) |

---

## Development

Use the Node.js major in [`.node-version`](.node-version) and the pnpm version pinned in `package.json`. Read [`AGENTS.md`](AGENTS.md) for the architecture invariants and repo conventions before changing hardware, scheduler, or database code.

```bash
pnpm install
pnpm dev              # dev server on :3000 (not a hardware simulator)
pnpm test             # Vitest
pnpm lint && pnpm tsc

pnpm db:generate              # sleepypod.db migration from schema
pnpm db:biometrics:generate   # biometrics.db migration from schema
pnpm lingui:extract           # extract new user-facing strings
```

| Variable | Default (dev) | Description |
|----------|---------------|-------------|
| `DATABASE_URL` | `file:./sleepypod.dev.db` | Path to sleepypod.db |
| `BIOMETRICS_DATABASE_URL` | `file:./biometrics.dev.db` | Path to biometrics.db |
| `DAC_SOCK_PATH` | `/persistent/deviceinfo/dac.sock` | Unix socket path for hardware control |

Deploy a local build to an installed Pod over SSH (port 8822):

```bash
./scripts/deploy POD_IP              # current checkout
./scripts/deploy POD_IP fix/my-fix   # branch from your clone's origin
./scripts/deploy --repo Kovbo/core POD_IP fix/pod3-frozen-heartbeat  # fork branch
```

See the [deployment guide](docs/DEPLOYMENT.md) for SSH requirements and fork/PR validation.

### In-repo reference

The docs site is written for people; these files track the code and change with it.

| Path | What's there |
|---|---|
| [`docs/adr/`](docs/adr/) | Architecture Decision Records |
| [`docs/wiki/`](docs/wiki/INDEX.md) | Compiled topic briefings across the codebase |
| [`docs/integrations.md`](docs/integrations.md) | HomeKit accessory map, MQTT topics, integration env vars |
| [`docs/temperature-control.md`](docs/temperature-control.md) | Temperature arbitration between manual, schedule, and Autopilot |
| [`docs/nats-frame-readers.md`](docs/nats-frame-readers.md) | RAW vs NATS sensor transport selection |
| [`docs/hardware/`](docs/hardware/) | DAC protocol, alarms, calibration, sensor profiles |
| [`docs/trpc-api-architecture.md`](docs/trpc-api-architecture.md) | tRPC router layout and REST surface |
| [`src/mcp/README.md`](src/mcp/README.md) | MCP tool catalogue and design rules |
| [`modules/`](modules/) | Python sidecars: vitals, sleep detection, calibration, environment, RAW archiving |

### Tech stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · tRPC v11 · SQLite via better-sqlite3 + Drizzle ORM · Lingui · Vitest · pnpm · Python sidecars managed by uv · hap-nodejs (HomeKit) · mqtt.js

---

## License

[AGPL-3.0](LICENSE)
