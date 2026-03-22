# Code Review Summary — fix/246-exclude-seqno-raw (PR #247)
Date: 2026-03-22
Depth: Standard (Sonnet Optimizer + Sonnet Skeptic)
Branch: fix/246-exclude-seqno-raw -> dev

## What changed
Adds `p.name != "SEQNO.RAW"` filter to `RawFileFollower._find_latest()` so the firmware metadata file is never selected as sensor data. Fixes a production bug causing total biometric data loss on affected devices.

## Mechanical checks
- TypeScript: pass
- Build: pass
- Tests: 242 passed, 1 skipped, 1 failed (pre-existing — `snoozeManager.test.ts` fails on dev too)
- Lint: pre-existing ESLint failures in unrelated TS files

## Findings

### Confirmed — should fix in this PR (2)

**1. Add inline comment explaining the SEQNO.RAW exclusion**
- File: `modules/common/raw_follower.py:49-50`
- Severity: Minor
- Both agents agree (Optimizer F4 + Skeptic). Without context, a future maintainer may remove the filter as dead code.
- Suggested: `# SEQNO.RAW is a firmware metadata file, not sensor data (see #246)`

**2. Add unit tests for `_find_latest()` SEQNO exclusion**
- File: `modules/common/test_raw_follower.py` (new)
- Severity: Major
- Both agents agree (Optimizer F6, Skeptic confidence 95). This is a regression fix for a production outage with zero test coverage. Key test cases:
  - Only SEQNO.RAW present -> returns None
  - SEQNO.RAW has newer mtime than data file -> returns data file
  - Empty directory -> returns None

### Disputed — not applicable (3)

**Missing size guard (Optimizer F1)**: Skeptic correctly identified the 100K threshold is from a batch analysis script, not a live follower. The follower is *designed* to tail partially-written files. Adding a size guard would introduce startup gaps. **Rejected.**

**Silent empty-candidates (Optimizer F3)**: Pre-existing behavior, transient boot condition, debug log would be noisy and inaccurate. **Rejected.**

**Calibrator SEQNO gap (Optimizer F5)**: Impact overstated — only 16 debug-level log lines, zero calibration skew. Downgraded from Major to Nit. **Deferred.**

### Pre-existing issues noted (3)

**1. Unprotected `open()` in raw_follower.py:66** (Skeptic)
- `open(latest, "rb")` sits outside the try/except block. File deletion between `_find_latest()` and `open()` crashes the generator unrecoverably.
- Severity: Minor (pre-existing, not introduced by this PR)

**2. Calibrator unprotected `stat()` in main.py:89** (Skeptic)
- `sorted(..., key=lambda p: p.stat().st_mtime)` with no FileNotFoundError protection. File rotation during glob crashes `load_recent_records()`.
- Severity: Major (pre-existing)

**3. Double `stat()` calls in `_find_latest()`** (Skeptic)
- `_safe_mtime` called in both filter and sort = 2N stat syscalls per poll.
- Severity: Nit (pre-existing)

## Recommendation

**Approve with minor suggestions.** The core fix is correct and minimal. The two confirmed items (comment + tests) are worth adding but not blocking for a production hotfix.
