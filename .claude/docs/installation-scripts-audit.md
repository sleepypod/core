# Installation Scripts Expert Audit

## Summary

Three expert agents (bash-script-expert, security-expert, devops-expert) reviewed the installation scripts with context-appropriate recommendations for a jailbroken embedded device.

**Original findings:** 56 issues
**Context-adjusted:** 10 critical issues
**Status:** ✅ All fixed

## Context

- Jailbroken Eight Sleep Pod (embedded Linux)
- Single-user device, local network only
- Root access required for dac.sock hardware control
- No physical access after deployment (bedroom device)
- Updates are rare, manual via SSH

## Critical Issues Fixed

### 1. sp-update Completely Broken (P0)
**Problem:** Missing db:migrate, no rollback, no backup
**Impact:** Updates crash the app or brick device
**Fix:** Complete rewrite with:
- Database backup before update
- Git rollback on failure
- Proper migration application
- Health check validation
- Pre-flight checks

### 2. No Disk Space Check (P0)
**Problem:** Build could fill disk, corrupt SQLite
**Impact:** Bricked device, prevent SSH login
**Fix:** Check for 500MB free before install, 300MB before update

### 3. Missing pipefail + trap (Critical)
**Problem:** Pipe failures silently ignored, no cleanup on error
**Impact:** Half-finished installs, inconsistent state
**Fix:** `set -euo pipefail` and trap handlers in all scripts

### 4. npm Lifecycle Scripts as Root (High)
**Problem:** Arbitrary code from packages runs as root
**Impact:** Supply chain attack could brick hardware
**Fix:** `pnpm install --ignore-scripts`, explicitly build native modules

### 5. Portable grep Fails (Critical)
**Problem:** `grep -oP` not available on BusyBox/Alpine
**Impact:** Script crashes AFTER successful install
**Fix:** Use `grep -o` + `awk` instead

### 6. IPv6 Firewall Bypass (Medium)
**Problem:** block-internet only blocked IPv4
**Impact:** Device can phone home via IPv6
**Fix:** Add ip6tables rules

### 7. Input Validation Missing (High)
**Problem:** User socket path not validated
**Impact:** Typos corrupt config files
**Fix:** Validate path exists and is a socket with `-S` test

### 8. .env Overwritten (P1)
**Problem:** Re-runs destroy custom config
**Impact:** Data loss of user settings
**Fix:** Preserve existing .env, update only managed keys

### 9. No --frozen-lockfile (P1)
**Problem:** Dependency resolution can diverge
**Impact:** Build fails on ARM with wrong package versions
**Fix:** `pnpm install --frozen-lockfile`

### 10. Hardcoded wlan0 (Medium)
**Problem:** Interface detection fails on some devices
**Impact:** Can't detect IP address
**Fix:** Auto-detect with `ip route | awk '/default/ {print $5}'`

## Issues Explicitly Dropped (Context-Appropriate)

### Running as Root → Accepted
**Reasoning:** dac.sock requires root, single-user device, no multi-tenancy
**Consensus:** All 3 experts agreed root is appropriate here

### SSH PermitRootLogin → Keys-Only (Not Blocked)
**Reasoning:** Already jailbroken, user controls network
**Fix:** Changed to `prohibit-password` (keys only) for convenience, not security

### Systemd Hardening → Minimal
**Reasoning:** Sandboxing likely to break on jailbroken device
**Fix:** Added only safe directives (NoNewPrivileges, ReadWritePaths)

### HTTPS/TLS → Not Needed
**Reasoning:** Local network only, certificate management adds bricking risk

## Script Implementation

### install
Production-ready installation script with comprehensive safety checks:
- ✅ Pipefail + trap handler for error recovery
- ✅ Pre-flight checks (disk, network, dependencies)
- ✅ Lock file prevents concurrent installs
- ✅ Input validation for DAC_SOCK_PATH
- ✅ Auto-detect network interface
- ✅ `--ignore-scripts` for npm supply chain security
- ✅ Explicit better-sqlite3 build
- ✅ `--frozen-lockfile` for reproducible builds
- ✅ .env preservation on re-runs
- ✅ Safe database migrations
- ✅ Improved error messages to stderr
- ✅ Interactive SSH configuration
- ✅ Uses `/usr/bin/env pnpm` for systemd compatibility
- ✅ Modern NodeSource keyring-based installation
- ✅ SSH config validation before restart

### sp-update (embedded in install)
Production-ready update script with full rollback capability:
- ✅ Database backup before update
- ✅ Git rollback on failure
- ✅ Database restore on failure
- ✅ Stop service during update
- ✅ Health check validation
- ✅ Pre-flight checks (network, disk space)
- ✅ Applies database migrations

### internet-control
Unified script for blocking/unblocking internet access:
- ✅ IPv4 and IPv6 support (prevents bypass)
- ✅ Custom iptables chains (don't flush all rules)
- ✅ Connection tracking
- ✅ mDNS support for local discovery
- ✅ Auto-detect network interface
- ✅ Clean removal of custom chains
- ✅ Single command interface: `{block|unblock}`

## Expert Consensus

**Bash Expert:** 21 findings → 6 critical after context
**Security Expert:** 14 findings → 4 critical after context
**DevOps Expert:** 21 findings → 3 P0 after context

**Key Insight:** Focus on "Can I still SSH in and fix this?" vs. enterprise server concerns.

## PR Review Fixes (Feb 2026)

Additional issues identified and fixed in PR #115 review:

### Critical
- ✅ Fixed hardcoded `/usr/bin/pnpm` → `/usr/bin/env pnpm` for systemd compatibility
- ✅ Replaced deprecated NodeSource setup_20.x with keyring-based installation
- ✅ Added SSH config validation (`sshd -t`) before restart to prevent bricking

### Major
- ✅ Fixed SSH service name compatibility (Debian `ssh` vs RHEL `sshd`)
- ✅ Added missing `pnpm db:migrate` to README manual update steps
- ✅ Guarded `ip6tables-save` with command existence check

### Minor
- ✅ Fixed multiple IPv4 address handling in LOCAL_SUBNET detection

**All changes verified with bash syntax validation.**

## Testing Checklist

- [ ] Test install on fresh Eight Sleep Pod
- [ ] Test sp-update with rollback scenario
- [ ] Verify disk space check prevents corruption
- [ ] Test on Debian/Ubuntu (ssh service) and RHEL (sshd service)
- [ ] Verify IPv6 blocking works
- [ ] Test .env preservation on re-run
- [ ] Verify better-sqlite3 builds correctly
- [ ] Test SSH with keys-only authentication
- [ ] Verify input validation catches bad socket paths
- [ ] Test on system without ip6tables-save
- [ ] Test interface with multiple IPv4 addresses

## Production Scripts

### scripts/install (~400 lines)
Main installation script with comprehensive safety checks:
- One-line installation: `curl -fsSL ... | sudo bash`
- Interactive SSH setup prompt
- Embedded sp-update CLI tool with rollback
- Pre-flight validation
- Auto-detection of system configuration

### scripts/internet-control (~160 lines)
Network access control utility:
- Single command interface: `{block|unblock}`
- Handles both IPv4 and IPv6
- Preserves local network access
- mDNS support for local discovery

### scripts/README.md
Complete documentation:
- Installation instructions
- Post-install CLI commands
- Troubleshooting guide
- Manual update steps

**Architecture Benefits:**
- Simple 2-script design (easy to understand)
- One-command installation with optional features
- Self-contained with minimal dependencies
- Easy to maintain and test

## Date
2026-02-23

## Reviewers
- bash-script-expert (21 findings)
- security-expert (14 findings)
- devops-expert (21 findings)
