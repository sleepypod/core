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

## Script Changes

### install (was install.sh)
- ✅ Removed .sh extension, made executable
- ✅ Added pipefail + trap handler
- ✅ Pre-flight checks (disk, network, dependencies)
- ✅ Lock file for re-entrancy
- ✅ Input validation for DAC_SOCK_PATH
- ✅ Auto-detect network interface
- ✅ `--ignore-scripts` for security
- ✅ Explicit better-sqlite3 build
- ✅ `--frozen-lockfile` for reproducibility
- ✅ .env preservation on re-runs
- ✅ Database migrations (not destructive push)
- ✅ Improved error messages to stderr

### sp-update (embedded in install)
- ✅ Complete rewrite from broken state
- ✅ Database backup before update
- ✅ Git rollback on failure
- ✅ Database restore on failure
- ✅ Stop service during update
- ✅ Health check validation
- ✅ Pre-flight checks

### setup-ssh (was setup-ssh.sh)
- ✅ Removed .sh extension
- ✅ Keys-only authentication (prohibit-password)
- ✅ Disable password auth entirely
- ✅ SSH key format validation
- ✅ Trap handler to restore on failure

### block-internet (was block-internet.sh)
- ✅ Removed .sh extension
- ✅ IPv6 support (ip6tables rules)
- ✅ Custom chain (don't flush all rules)
- ✅ Connection tracking
- ✅ mDNS support for local discovery
- ✅ Auto-detect interface

### unblock-internet (was unblock-internet.sh)
- ✅ Removed .sh extension
- ✅ IPv6 support
- ✅ Clean removal of custom chains

## Expert Consensus

**Bash Expert:** 21 findings → 6 critical after context
**Security Expert:** 14 findings → 4 critical after context
**DevOps Expert:** 21 findings → 3 P0 after context

**Key Insight:** Focus on "Can I still SSH in and fix this?" vs. enterprise server concerns.

## Testing Checklist

- [ ] Test install on fresh Eight Sleep Pod
- [ ] Test sp-update with rollback scenario
- [ ] Verify disk space check prevents corruption
- [ ] Test on system without wlan0 interface
- [ ] Verify IPv6 blocking works
- [ ] Test .env preservation on re-run
- [ ] Verify better-sqlite3 builds correctly
- [ ] Test SSH with keys-only
- [ ] Verify input validation catches bad socket paths

## Files Modified

- `scripts/install` (was install.sh) - 350 lines, comprehensive rewrite
- `scripts/sp-update` - 50 lines, embedded in install
- `scripts/setup-ssh` (was setup-ssh.sh) - 70 lines
- `scripts/block-internet` (was block-internet.sh) - 90 lines
- `scripts/unblock-internet` (was unblock-internet.sh) - 40 lines
- `scripts/README.md` - Updated for new filenames and features

## Date
2026-02-23

## Reviewers
- bash-script-expert (21 findings)
- security-expert (14 findings)
- devops-expert (21 findings)
