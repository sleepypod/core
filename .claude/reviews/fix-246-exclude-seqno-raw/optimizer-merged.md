# Optimizer Findings — fix/246-exclude-seqno-raw

## Summary

`RawFileFollower._find_latest()` in `modules/common/raw_follower.py` was selecting whichever `.RAW` file had the most recent mtime, which could be `SEQNO.RAW` — a 16-byte firmware metadata file that is not CBOR sensor data. This caused the piezo processor (and potentially the sleep-detector and environment-monitor, which share the same follower) to parse junk bytes, exhaust the file at EOF, and then stall indefinitely with zero biometric output. The fix adds a single `p.name != "SEQNO.RAW"` guard to the list comprehension in `_find_latest()`, matching the pattern already present in `prototype_v2.py:511`.

---

## Findings

### Finding 1: Missing file-size guard — diverges from prototype and leaves partially-written files exposed

- **File**: `modules/common/raw_follower.py:49-50`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: The prototype filters with both `f.name != "SEQNO.RAW" and f.stat().st_size > 100_000` (line 511). The production fix only adds the name guard and drops the size check entirely. A data file that is freshly created by the firmware daemon (mtime very recent, but < a few hundred bytes written) will rank first by mtime and be opened immediately. The follower will immediately reach EOF after a handful of records, then poll in a tight 10 ms loop waiting for more data while the daemon is still filling the file. More importantly, a truncated/corrupt file from an unclean shutdown could be permanently preferred over older complete files if its mtime happens to be newest. The 100 000-byte threshold exists in the prototype precisely to skip these partial files.
- **Suggested fix**:
  ```python
  candidates = [
      p for p in self.data_dir.glob("*.RAW")
      if p.name != "SEQNO.RAW"
      and _safe_mtime(p) > 0
      and _safe_size(p) > 0  # or > some minimum, e.g. 1024
  ]
  ```
  Add a `_safe_size` helper analogous to `_safe_mtime`. Whether to use 100 000 (the prototype's threshold) or a smaller value like 1 024 depends on the minimum meaningful file size; even a 1-byte guard would protect against empty ghost files. If the team decides not to match the prototype exactly, that decision should be documented.
- **Rationale**: The prototype was written from field experience with this exact hardware. Deviating from its heuristics without a documented reason risks re-introducing the class of problem this PR is fixing.

---

### Finding 2: Hardcoded string "SEQNO.RAW" — brittle against future firmware metadata files

- **File**: `modules/common/raw_follower.py:50`
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: The exclusion `p.name != "SEQNO.RAW"` is an exact-match allowlist of one known bad name. If the firmware ever adds another metadata file (e.g. `INDEX.RAW`, `BOOT.RAW`), the same bug will silently recur. There is no central registry of "known non-data RAW files" and no comment explaining why this name is special.
- **Suggested fix**: Either (a) define a module-level constant:
  ```python
  _NON_DATA_RAW_FILES = frozenset({"SEQNO.RAW"})
  ```
  and filter with `p.name not in _NON_DATA_RAW_FILES`, or (b) use a naming convention check if the firmware guarantees that all data files match a pattern (e.g. digits only before `.RAW`). At minimum, add an inline comment explaining the exclusion.
- **Rationale**: The issue description itself explains that `SEQNO.RAW` is a "metadata/index file". That context should live in the code, not just in GitHub.

---

### Finding 3: Empty-candidates case is silent — no log when all files are excluded

- **File**: `modules/common/raw_follower.py:51-52`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: If `SEQNO.RAW` is the *only* `.RAW` file in the directory (e.g. immediately after a device boot, before the first data file is created), `_find_latest()` returns `None`, and `read_records()` silently sleeps for 1 second and retries. This is correct behavior, but there is no log message distinguishing "no RAW files at all" from "only non-data RAW files present". An operator watching logs during a boot sequence cannot tell which case they are in.
- **Suggested fix**: Add a debug log before returning `None`:
  ```python
  if not candidates:
      log.debug("No data RAW files found in %s (non-data files excluded)", self.data_dir)
      return None
  ```
- **Rationale**: Observability. The original bug was diagnosed from logs; making the normal exclusion path visible aids future debugging.

---

### Finding 4: Race window — SEQNO.RAW could be selected between boot and first data file

- **File**: `modules/common/raw_follower.py:48-52`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The issue description mentions a race: "depends on whether the sensor daemon or SEQNO update touches disk last." The fix correctly removes SEQNO.RAW from candidates, so the race is eliminated for SEQNO. However, the broader race class — where a new data file is created but has mtime equal to or slightly older than SEQNO.RAW due to filesystem timestamp resolution — is not mentioned in a comment. The fix resolves the reported symptom but a reader might not understand why SEQNO's mtime ordering was the problem in the first place.
- **Suggested fix**: No code change needed; add a comment to `_find_latest()` docstring or inline:
  ```python
  # SEQNO.RAW is a 16-byte firmware metadata/index file, not sensor data.
  # It is excluded because the daemon updates its mtime frequently, causing
  # it to rank ahead of legitimate data files. See issue #246.
  ```
- **Rationale**: Without this context, a future maintainer seeing `p.name != "SEQNO.RAW"` may remove it as "dead code" or wonder if it is a workaround for a fixed firmware bug.

---

### Finding 5: Calibrator does not filter SEQNO.RAW — same latent bug exists there

- **File**: `modules/calibrator/main.py:89`
- **Severity**: 🟡 Major
- **Category**: Completeness
- **Problem**: `modules/calibrator/main.py` has its own `glob("*.RAW")` at line 89 with no SEQNO exclusion. Although the calibrator reads all files to find recent records (not just the newest), it will open and attempt to parse SEQNO.RAW as CBOR, log `Skipping corrupt record in SEQNO.RAW` for every byte, and potentially skew calibration timing if SEQNO is within the 6-hour cutoff window. The fix in this PR is scoped only to `RawFileFollower`, leaving this identical issue in the calibrator.
- **Suggested fix**: In `calibrator/main.py` line 89, add the same exclusion:
  ```python
  raw_files = [
      p for p in sorted(RAW_DATA_DIR.glob("*.RAW"), key=lambda p: p.stat().st_mtime, reverse=True)
      if p.name not in _NON_DATA_RAW_FILES
  ]
  ```
  Or, if the calibrator is unlikely to encounter SEQNO corruption in practice, file a follow-up issue and document the gap.
- **Rationale**: The issue description mentions the calibrator crashing on this device (with a different error, but on the same device). The SEQNO parsing corruption in the calibrator is a silent background noise even when the main crash is absent. Completeness of the fix requires addressing all consumers of `*.RAW`.

---

### Finding 6: No unit test for the SEQNO exclusion behavior

- **File**: `modules/common/` (no test file exists for `raw_follower.py`)
- **Severity**: 🟡 Major
- **Category**: Testing
- **Problem**: There are zero tests for `RawFileFollower` or `_find_latest()`. The PR's test plan checks "all 57 existing piezo-processor tests pass", but those tests mock out `RawFileFollower` entirely (`_stubs["common.raw_follower"].RawFileFollower = None` in `test_main.py:25`). The specific regression — SEQNO.RAW being returned from `_find_latest()` — is not covered by any test and will not be caught if this guard is accidentally removed.
- **Suggested fix**: Add `modules/common/test_raw_follower.py` with at minimum:
  - A test that `_find_latest()` returns `None` when only `SEQNO.RAW` is present
  - A test that `_find_latest()` returns the data file when both `SEQNO.RAW` and a data file are present, even if `SEQNO.RAW` has a newer mtime
  - A test for the empty-directory case (already handled, but worth pinning)
- **Rationale**: This is a regression fix for a production outage. Without a test, the fix has no guard against future regressions. The module is small (102 lines) and entirely testable with `tmp_path` fixtures.

---

### Finding 7: CI is failing — unrelated to this PR but blocks merge

- **File**: `.github/workflows/` (CI)
- **Severity**: 🟡 Major
- **Category**: Completeness
- **Problem**: PR #247 shows "2 checks failed". Inspection of the failed run (23411780063) reveals ESLint errors in TypeScript files (`TempScreen.tsx`, `TemperatureDial.tsx`, `useSensorStream.ts`, `biometrics.ts`, `piezoStream.ts`). These are unrelated to the Python change in this PR but will prevent merge in any project that requires all-green CI.
- **Suggested fix**: The CI failures appear to be pre-existing failures from other in-flight branches that have been merged or rebased onto this branch's base. Confirm whether `origin/dev` CI is also failing; if so, this PR is not responsible. If `dev` is green and this branch introduced the failures, identify which commit caused them.
- **Rationale**: A PR that fixes a critical production bug should not be blocked by unrelated CI noise, but the noise must be explained or resolved before merging.

---

## Statistics

- **Total findings**: 7
- **By severity**:
  - 🔴 Critical: 0
  - 🟡 Major: 3 (Finding 1 — missing size guard, Finding 5 — calibrator gap, Finding 6 — no tests)
  - 🟢 Minor: 3 (Finding 2 — hardcoded string, Finding 3 — silent empty case, Finding 4 — no comment)
  - ⚪ Nit: 0
  - 🟣 Pre-existing: 1 (Finding 7 — CI failures are pre-existing and unrelated)
