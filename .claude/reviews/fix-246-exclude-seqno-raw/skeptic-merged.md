# Skeptic Challenge Report — fix/246-exclude-seqno-raw

## Overview

The PR makes three changes: (1) a one-line SEQNO exclusion in `raw_follower.py`, (2) a CI lint change from full-project to incremental lint, (3) a dynamic import path fix in `dacMonitor.instance.ts`. The Optimizer focused almost entirely on change (1) and treated change (2) as pure noise. Several of its findings misread the production context.

---

## Challenges to Optimizer Findings

### RE: Finding 1 — Missing file-size guard

- **Verdict**: ⚠️ Disagree
- **Confidence**: 85
- **Challenge**: The 100,000-byte threshold in `prototype_v2.py:511` exists for a fundamentally different reason than the Optimizer claims. The prototype is an offline batch analysis script (`if __name__ == "__main__"`) that needs at least 2 *complete* files to do meaningful signal processing — it explicitly prints "Need at least 2 complete RAW files" and exits if the condition is not met. That is a batch-analysis precondition, not a live-tailing heuristic. `RawFileFollower` is specifically designed to tail a partially-written file as it is being filled by the firmware daemon — that is its entire purpose. Blocking on a freshly created file until it reaches 100 KB would introduce a startup delay of potentially minutes and would mean the follower silently emits no records while the device is actively recording. The tight 10 ms poll against a partial file is not a bug; it is the expected steady state during normal recording. The Optimizer treats the prototype as authoritative field experience when it is actually a different tool solving a different problem.
- **Alternative**: No size guard is appropriate for a live follower. If startup lag on a brand-new file is a concern in practice, a smaller minimum (e.g. 1 byte) to exclude truly empty ghost files is reasonable — but that is already partially handled by the `_safe_mtime(p) > 0` guard, since a zero-byte file still has a valid mtime. A separate `_safe_size` helper is unnecessary complexity.
- **Risk if applied as-is**: Adding a 100,000-byte guard would cause the follower to skip all data from a freshly rotated file for the first several minutes of recording, producing a real gap in biometric output. This is arguably worse than the original SEQNO bug.

---

### RE: Finding 2 — Hardcoded string "SEQNO.RAW"

- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 70
- **Challenge**: The suggestion to define `_NON_DATA_RAW_FILES = frozenset({"SEQNO.RAW"})` is over-engineered for the current situation. There is exactly one known metadata file. The frozenset buys nothing until a second file is known, and treating this as an "allowlist architecture" problem signals a level of future-proofing that is disproportionate to a two-commit module with no external contributors. The naming-convention alternative ("digits only before `.RAW`") is even worse — it encodes an undocumented firmware assumption that is more fragile than the explicit exclusion.
- **Alternative**: The only part of Finding 2 worth applying is the inline comment. A single line like `# SEQNO.RAW is a 16-byte firmware metadata file, not sensor data; see issue #246` costs nothing and permanently documents the reasoning. The constant can be added later if a second exclusion is ever needed.
- **Risk if applied as-is**: Low risk, but the frozenset approach adds indirection that makes the code slightly harder to read for no practical gain at current scale. The naming-convention suggestion would be actively harmful.

---

### RE: Finding 3 — Empty-candidates case is silent

- **Verdict**: ⚠️ Disagree
- **Confidence**: 75
- **Challenge**: The Optimizer frames this as a new observability gap created by the SEQNO exclusion. But this case is not new: before this PR, if zero `.RAW` files existed, `_find_latest()` also returned `None` silently. The caller in `read_records()` already logs `"Switched to RAW file: %s"` when it does find a file, which serves as a positive confirmation. The scenario "SEQNO.RAW is the only `.RAW` file" is a genuine edge case during very early boot, but it is a transient condition (seconds at most) before the firmware creates the first data file. Adding a `log.debug` that fires once per second during this window will produce repetitive log churn with no actionable information — an operator watching logs during boot cannot act on it differently than "waiting for data file".
- **Alternative**: If boot observability is a concern, the log belongs in `read_records()` where the 1-second sleep is, not in `_find_latest()`. But even then, the existing silence is harmless.
- **Risk if applied as-is**: Low. The debug log is inaccurate in the "no RAW files at all" sub-case (it would say "non-data files excluded" when no files exist). A correct implementation requires distinguishing two sub-cases, making the fix more complex than presented.

---

### RE: Finding 4 — Race window comment

- **Verdict**: ✅ Agree
- **Confidence**: 90
- **Challenge**: No substantive disagreement. An explanatory comment is warranted. However, the Optimizer's own suggested comment text slightly overstates the mechanism — "It is excluded because the daemon updates its mtime frequently, causing it to rank ahead of legitimate data files" is an inference about daemon behavior, not a verified fact from the issue report. The simpler factual version ("SEQNO.RAW is a firmware metadata file, not sensor data; it must be excluded to prevent it from being selected as the live data file. See #246.") is less likely to mislead a future reader if the mtime behavior turns out to be more nuanced.
- **Alternative**: Apply the comment, but use factual language rather than inferred daemon behavior.
- **Risk if applied as-is**: Negligible. Comment-only change.

---

### RE: Finding 5 — Calibrator does not filter SEQNO.RAW

- **Verdict**: ⚠️ Disagree
- **Confidence**: 80
- **Challenge**: The Optimizer describes this as a "Major" severity issue with "log `Skipping corrupt record in SEQNO.RAW` for every byte." This is technically accurate about the log volume but dramatically overstates the impact. Tracing the actual execution path: `read_raw_record` reads 1 byte, expects `0xa2` (CBOR map marker), SEQNO.RAW's first byte is not `0xa2`, raises `ValueError`. The calibrator catches `ValueError` at line 116, logs one `debug`-level line, and calls `continue`. The next call to `read_raw_record` reads the next byte, raises `ValueError` again. This repeats for all 16 bytes of the file, then `EOFError` is raised on byte 17, which `break`s the inner loop. The total effect is 16 `debug`-level log entries and then the calibrator moves on to the next file. This is noise, not a calibration skew risk. The claim that it "potentially skew[s] calibration timing" is not supported by the code — SEQNO.RAW contains no records that would pass the `ts` filter or appear in the `records` dict.

  Additionally, the Optimizer states there is no SEQNO exclusion in the calibrator and recommends adding one. This is correct as a completeness point, but the calibrator also has a different pre-existing problem: its `sorted()` on line 89 calls `p.stat().st_mtime` directly (not via `_safe_mtime`), so a file deleted between glob and sort raises an uncaught `FileNotFoundError`. That is a more pressing reliability gap than SEQNO parsing noise.

- **Alternative**: File a follow-up issue for the calibrator's SEQNO noise. The calibrator's unprotected `stat()` call is a higher-priority fix. Severity should be downgraded from Major to Nit/Minor (16 debug log lines, zero calibration impact).
- **Risk if applied as-is**: The suggested fix is correct and safe, but the severity framing would cause teams to over-prioritize a cosmetic log issue over the actual `FileNotFoundError` risk in the same file.

---

### RE: Finding 6 — No unit test for SEQNO exclusion

- **Verdict**: ✅ Agree
- **Confidence**: 95
- **Challenge**: No substantive disagreement. The absence of tests for `_find_latest()` is real and the suggested test cases are correct. The finding accurately notes that `test_main.py` stubs out `RawFileFollower` entirely, providing zero coverage for the specific regression being fixed.

  One nuance the Optimizer misses: creating `modules/common/test_raw_follower.py` requires a test runner configured for `modules/common/`. Looking at `modules/piezo-processor/test_main.py`, it uses `sys.modules` injection to stub dependencies — the test infrastructure exists but is per-module. A test for `raw_follower.py` using `tmp_path` (pytest fixture) would need pytest to be set up for `modules/common/`, which has no existing test file or runner config. This is a minor setup burden but not a blocker.

- **Alternative**: The suggested test cases are appropriate. Consider adding a fourth: `_find_latest()` when SEQNO.RAW has a newer mtime than the data file — this is the exact production failure scenario.
- **Risk if applied as-is**: No risk. Adding tests is unambiguously correct.

---

### RE: Finding 7 — CI is failing

- **Verdict**: ⚠️ Disagree
- **Confidence**: 85
- **Challenge**: The Optimizer treats the CI change as unrelated noise and asks the team to "confirm whether `origin/dev` CI is also failing." This misses that the PR *actively fixes the CI failures* by changing the lint command from full-project ESLint to incremental lint (only changed `*.ts`/`*.tsx` files). The new command is:
  ```
  CHANGED=$(git diff --name-only --diff-filter=d origin/${{ github.event.pull_request.base.ref }}...HEAD -- '*.ts' '*.tsx' | head -200); if [ -n "$CHANGED" ]; then echo "$CHANGED" | xargs pnpm eslint; else echo 'No TS/TSX files changed'; fi
  ```
  This means pre-existing ESLint errors in files not touched by a PR will not block merge. The CI failures in `TempScreen.tsx`, `TemperatureDial.tsx`, etc. are not files changed in this PR, so the new lint command will not flag them.

  This is a deliberate and consequential CI policy change — not housekeeping. It has a real tradeoff: new ESLint violations can now be silently introduced in unchanged files without CI catching them. The `pnpm tsc` typecheck still runs on the full project, which partially compensates. The Optimizer neither recognized this as intentional nor evaluated the tradeoff.

- **Alternative**: The Optimizer should have flagged the CI change as a separate finding about lint scope reduction, not treated the CI failures as pre-existing noise. The PR description should explicitly explain why incremental lint was chosen.
- **Risk if applied as-is**: The incremental lint is already applied in this PR. The risk of the approach is gradual ESLint debt accumulation in unchanged files. This is a team policy decision, not a bug.

---

## Missed Issues

### Missed Issue 1: Unprotected `open()` crashes the generator on file deletion
- **File**: `modules/common/raw_follower.py:66`
- **Severity**: 🟣 Pre-existing
- **Category**: Robustness
- **Problem**: `self._file = open(latest, "rb")` at line 66 sits outside the `try/except` block that starts at line 71. If the file returned by `_find_latest()` is deleted between the `_find_latest()` call and the `open()` call — a real possibility on embedded hardware that may rotate files on a schedule — a `FileNotFoundError` (which is an `OSError` subclass) propagates uncaught through the `while` loop and crashes the generator. This terminates the biometric stream for the affected module with no recovery. This is a pre-existing bug, not introduced by this PR, but the PR is a natural opportunity to fix it since it is already touching this exact code path.
- **Suggested fix**: Wrap lines 62–69 in a `try/except OSError` that clears `self._path` on failure (causing a retry on the next loop iteration) rather than propagating the crash.

### Missed Issue 2: `_safe_mtime` is called twice per file in `_find_latest`
- **File**: `modules/common/raw_follower.py:50-51`
- **Severity**: ⚪ Nit
- **Category**: Performance
- **Problem**: `_safe_mtime(p)` is called once in the list comprehension (line 50, to filter) and again in `candidates.sort(key=_safe_mtime, ...)` (line 51, to sort). Each call performs a `stat()` syscall. For a directory with N candidate files, this is 2N `stat()` calls per `_find_latest()` invocation, and `_find_latest()` is called on every loop iteration at a 10 ms poll interval. This is not introduced by this PR (line 51 is unchanged), but the PR adds a second condition on line 50 without noting the double-stat pattern.
- **Suggested fix**: Cache the mtime in the comprehension: `candidates = [(p, _safe_mtime(p)) for p in ...]`, filter on the tuple, then sort by the pre-fetched value. Minor optimization, acceptable to defer.

### Missed Issue 3: Calibrator `sorted()` uses unprotected `stat()` — FileNotFoundError on file rotation
- **File**: `modules/calibrator/main.py:89`
- **Severity**: 🟡 Major
- **Category**: Robustness
- **Problem**: `sorted(RAW_DATA_DIR.glob("*.RAW"), key=lambda p: p.stat().st_mtime, reverse=True)` calls `p.stat()` directly with no `FileNotFoundError` protection. If any `.RAW` file is deleted between the `glob()` and the `sorted()` lambda execution (e.g. during file rotation), the exception propagates uncaught. There is no `try/except` around the `sorted()` call or around the assignment on line 89. This will crash `load_recent_records()` entirely. This is separate from and more severe than the SEQNO noise issue the Optimizer flagged for this file.
- **Suggested fix**: Replace the `stat()` lambda with a safe wrapper equivalent to `_safe_mtime` from `raw_follower.py`, or import `_safe_mtime` from `common.raw_follower`. Given that `calibrator/main.py` already imports from `common.cbor_raw`, importing from `common.raw_follower` is consistent.

### Missed Issue 4: Incremental CI lint silently allows ESLint violations in unchanged files
- **File**: `.github/workflows/test.yml`
- **Severity**: 🟡 Major
- **Category**: Architecture
- **Problem**: The new incremental lint command only lints files changed in the current PR. This means a PR that does not touch TypeScript can introduce no new ESLint violations even if it merges code paths that will be used by TypeScript files with existing violations. More critically, as `origin/dev` accumulates ESLint violations, no PR will ever catch or be required to fix them unless that specific file is modified. The `pnpm tsc` typecheck partially compensates but does not enforce ESLint rules. This converts lint from a quality gate into a diff filter.
- **Suggested fix**: Consider a scheduled full-lint CI job on `dev` (not PR-gated) to track overall ESLint health, rather than silently dropping lint coverage. The PR should document this policy choice.

---

## Statistics
- Optimizer findings challenged: 5 (Findings 1, 3, 5, 6 partially, 7)
- Findings agreed with: 2 (Finding 4, Finding 6)
- Findings agreed with modifications: 1 (Finding 2)
- Findings disagreed with: 4 (Findings 1, 3, 5, 7)
- New issues found: 4 (1 pre-existing crash bug, 1 nit, 1 major robustness gap in calibrator, 1 major CI policy gap)
