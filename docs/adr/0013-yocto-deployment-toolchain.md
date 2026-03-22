# ADR: Yocto-compatible deployment toolchain

## Context
The Pod runs a Yocto-based embedded Linux distribution ("Eight Layer 4.0.2", kirkstone) on aarch64. This is **not** a Debian/Ubuntu environment — there is no `apt-get`, no `dpkg`, and no general-purpose package manager. The system ships with a minimal set of tools: `curl`, `systemctl`, `python3`, `make`, `scp`, and `iptables`. Notably absent are `rsync`, `git`, and a C/C++ compiler (`gcc`/`g++`).

Our original install and deploy scripts assumed a Debian environment (apt-get for Node.js, nodesource repo, node-gyp for native modules, rsync for file sync). None of this works on the Pod's actual OS.

## Decision

### 1. Node.js via binary tarball instead of apt
We download the official Node.js prebuilt binary for `linux-arm64` from `nodejs.org/dist/` and extract it to `/usr/local/lib/nodejs`. Symlinks in `/usr/local/bin` provide `node`, `npm`, and `npx`.

**Why:** No package manager exists on the Pod. The official binary tarballs are the most portable and reliable way to install Node on any Linux distribution. This is the approach recommended by the Node.js project for systems without a supported package manager.

### 2. prebuild-install for native modules instead of node-gyp
`better-sqlite3` (our SQLite driver) supports `prebuild-install`, which downloads prebuilt native binaries for the target platform. Its install script is: `prebuild-install || node-gyp rebuild --release`. By allowing install scripts to run (removing `--ignore-scripts`), we get the prebuilt `linux-arm64` binary automatically — no compiler needed.

**Why:** The Pod has no C/C++ compiler. Cross-compiling on a Mac and transferring binaries is fragile and error-prone (glibc version mismatches, different linking). Prebuilt binaries from the module author are tested and reliable.

### 3. tar+ssh for file sync instead of rsync
The deploy script creates a tar archive locally (excluding `node_modules`, `.next`, databases), pipes it over SSH, and extracts on the Pod. Before extraction, stale files are cleaned from the remote directory while preserving generated artifacts.

**Why:** `rsync` is not available on the Pod and cannot be installed without a package manager. `tar` and `ssh` are universally available. The tar+ssh approach provides the same behavior as `rsync --delete` with excludes.

### 4. git is optional in local deploy mode
When deploying via the `deploy` script (which syncs code from a Mac), git is not required on the Pod. The `--local` flag to the install script skips all git operations. Git is only required for `sp-update` (pull-from-GitHub updates), which may not be the primary update path.

**Why:** Git is not installed on the Pod's Yocto image. The primary deployment flow is Mac -> Pod via LAN (deploy script), not Pod -> GitHub (git pull).

**Future consideration:** We may later support updates via the iOS app proxying through the deploy script.

### 5. pnpm via npm global install
After Node is installed, `pnpm` is installed via `npm install -g pnpm`. This is a single command and works on any platform with npm.

## Consequences
- The install script works on both Yocto (Pod) and Debian/Ubuntu systems
- No package manager (apt, opkg, etc.) is required
- No C/C++ compiler is required on the Pod
- WAN access is still needed during install for downloading Node binary, npm packages, and prebuilt native modules — the existing iptables unblock/reblock mechanism handles this
- `sp-update` (curl+tarball self-update on the Pod) does not require git — it downloads from GitHub's tarball API or CI release assets. Updates can also go through the deploy script from a Mac or the iOS app's remote management API
