# Skeptic Challenge Report — fix/cbor-record-parsing

## Preamble

All findings were validated against the actual source files (`modules/common/cbor_raw.py`,
`modules/piezo-processor/main.py:184-247`, `modules/sleep-detector/main.py:267-323`),
the full git diff (`origin/dev...fix/cbor-record-parsing`), the upstream PR body
(`throwaway31265/free-sleep#46`), and the upstream commit `7e25c012` source for
`biometrics/load_raw_files.py` and `biometrics/stream/stream.py`. `cbor2` version
5.6.5 was verified via the GitHub tag tree.

---

## Challenges to Optimizer Findings

### RE: Finding 1 — EOFError on partial record does not seek back

- **Verdict**: ⚠️ Disagree
- **Challenge**: The Optimizer's description of what happens is partially correct but the
  severity rating and the claim that "every record at the live trailing edge is permanently
  discarded" are both wrong in the context of this code.

  The claim is that after an `EOFError`, the cursor is advanced past `_last_pos`, the next
  call immediately raises `ValueError("Expected outer map 0xa2 …")`, and that `ValueError`
  increments `_consecutive_failures`. After 5 such increments the byte at `_last_pos` is
  skipped. Read the actual `ValueError` handler (both files, line 241/317):

  ```python
  self._file.seek(self._last_pos)   # <-- this is ALREADY there
  time.sleep(0.1)
  ```

  The seek back to `_last_pos` already exists in the `ValueError` / `CBORDecodeError`
  branch. The Optimizer is correct that it is **absent** from the `EOFError` branch, but
  the consequence is different from what was described. After an `EOFError` without a
  seek, the cursor sits somewhere inside the partially-consumed record. The **next** loop
  iteration immediately calls `read_raw_record` again. The first byte it reads is some
  interior byte of the incomplete record, which (almost certainly) is not `0xa2`, so it
  raises `ValueError`. The `ValueError` handler then seeks back to `_last_pos`. Net result:
  one wasted iteration and a 0.1-second sleep, but the record is **not lost** — the position
  is recovered on the very next failure. The record will be re-read correctly once the
  firmware finishes writing it.

  The record is only ever permanently skipped if the `_consecutive_failures` counter reaches
  5 before a full record becomes available. In the steady-state tailing scenario that means
  the hardware would have to remain silent for at least 0.5 seconds (5 × 0.1 s sleep) after
  emitting a partial record. That is a real possibility for the sleep-detector (which
  can poll infrequently), but it is not the "every live-edge record" catastrophe described.

  The Optimizer is correct that a `seek(self._last_pos)` in the `EOFError` handler is a
  simple hardening improvement. But the severity should be **🟡 Major** (risk of record
  loss under slow-hardware conditions), not **🔴 Critical** (certain data loss on every
  cycle). The suggested fix itself (add `self._file.seek(self._last_pos)` before the
  sleep) is the right call and should be applied.

- **Alternative**: Apply the fix exactly as suggested. Lower severity to 🟡 Major.
- **Risk if applied as-is**: No risk. The fix is correct. The over-stated severity is the
  only issue.

---

### RE: Finding 2 — `seq` encoding only handles uint32/uint64 — first ~65 K records fail

- **Verdict**: ⚠️ Disagree — severity is correct in theory but contradicted by upstream
  evidence.
- **Challenge**: The Optimizer assumes the firmware uses a standards-compliant CBOR encoder
  that applies minimal-length encoding. But the upstream PR (`throwaway31265/free-sleep#46`,
  commit `7e25c012`) ships **the identical parser** — same `if hdr[0] == 0x1a … elif
  hdr[0] == 0x1b … else raise ValueError` — without any fix for small-value seq encoding.
  The upstream PR was tested on a live Pod 5 and recorded 846 vitals rows in a single night.
  This is direct empirical evidence that the Pod firmware always emits `seq` as a uint32
  (`0x1a`) or uint64 (`0x1b`), never as a small inline uint.

  The most plausible explanation is that the firmware's CBOR encoder was written in C or
  Rust and unconditionally encodes `seq` as a fixed-width uint32. Many embedded CBOR
  encoders (tinycbor, nanocbor, cbor-cpp) use fixed-width encodings for integer fields
  when the field type is declared as `uint32_t`, regardless of the value. The Pod firmware
  almost certainly does this.

  The Optimizer's concern is theoretically valid CBOR knowledge, but there is no evidence
  that this firmware behaves this way, and the upstream implementers explicitly chose not
  to handle it. The correct response is a comment in the code explaining the constraint,
  not a full re-implementation of the seq parser.

  The suggested fix (handle all five uint encodings) is not harmful, but it adds ~15 lines
  of code to defend against a failure mode that has no empirical basis, based on a
  misreading of "CBOR encoders always use minimal encoding" (true for the reference Python
  cbor2 encoder, not for embedded C encoders).

- **Alternative**: Add a code comment: "Pod firmware encodes seq as a fixed-width uint32
  (0x1a) or uint64 (0x1b); inline and uint8/uint16 encodings are not emitted." Lower
  severity from 🔴 Critical to 🟢 Minor (documentation gap on a known protocol constraint).
- **Risk if applied as-is**: No functional risk — the fix is correct CBOR. The cost is
  added complexity that no device will ever exercise.

---

### RE: Finding 3 — CBOR map key order assumed, not validated

- **Verdict**: 🔄 Agree with modifications
- **Challenge**: The Optimizer is right that CBOR does not guarantee map key order, and
  right that a firmware change reordering the keys would silently break parsing. However,
  the suggested flexible parser is more complex than necessary. There are only two keys;
  a loop-and-dispatch approach adds branching and a dict allocation for a structure whose
  layout is defined by a hardware protocol that changes only on firmware updates.

  The more practical fix is exactly what the Optimizer lists as option (a): add a
  comment that explicitly names the protocol contract and links to the firmware commit or
  hardware spec. This gives the firmware team a clear, searchable signal that the order
  matters, without adding runtime complexity.

  If the flexible parser route is taken, the suggested code has a latent bug: if `seq`
  appears after `data` in the stream, `_skip_cbor_uint(f)` must already handle all uint
  encodings (the same gap as Finding 2). The suggested fix thus couples Finding 2 and
  Finding 3, making them both mandatory if either is applied.

- **Alternative**: Add a comment documenting the protocol contract. Accept 🟡 Major
  severity as reasonable — this is a real failure mode with real consequences.
- **Risk if applied as-is**: The flexible parser is functionally correct if Finding 2 is
  also fixed. Without Finding 2, `_skip_cbor_uint` would have the same small-value gap.
  The coupling is not called out by the Optimizer.

---

### RE: Finding 4 — Data value major type not validated

- **Verdict**: ✅ Agree
- **Challenge**: No substantive objection. The major type check is missing and the
  consequence of `mt=4` or `mt=5` (misinterpreting an item count as a byte count) is
  exactly as described — silent stream corruption. The one-line fix is correct and low
  risk. 🟡 Major severity is appropriate.
- **Alternative**: None. Apply as suggested.
- **Risk if applied as-is**: None.

---

### RE: Finding 5 — Corrupt recovery advances by only 1 byte

- **Verdict**: ⚠️ Disagree — the proposed fix introduces a false-positive risk that is
  worse than the problem it solves.
- **Challenge**: The suggested "scan forward to next `0xa2` candidate" approach has a
  critical flaw: `0xa2` is a common byte value. In CBOR, it means "2-item map" but it
  also appears as a data byte inside any binary payload. A typical piezo-dual record
  contains hundreds of int32 samples; the byte value `0xa2` (decimal 162) will appear
  frequently inside sensor data. Scanning for the next `0xa2` after a corrupt region will
  almost certainly land mid-payload, not at a true record boundary. The parser will then
  attempt to decode from that position, get a plausible-looking `0xa2` header, consume
  garbage as the `seq` key, and either raise `ValueError` (immediately, unlikely to match
  `\x63\x73\x65\x71` in mid-payload) or — worse — accidentally match the seq-key bytes by
  coincidence, corrupt `_last_pos` to a position inside a record, and produce cascading
  misparses.

  For this specific file format, a false-boundary hit is more damaging than the slow
  byte-by-byte scan, because a false boundary resets `_consecutive_failures` to 0,
  making the corruption recovery silent and harder to detect.

  The performance concern is also less severe than claimed: the 5 × 0.1s delay (0.5 s)
  happens only when parsing fails AND the failures are not separated by successes. Power-
  interrupted trailing bytes are typically < 50 bytes (a partial record header), not
  100–1000 bytes, so the real-world stall is more like 0.5–5 seconds, not 50–512 seconds.

  The 1-byte-at-a-time scan is the safer approach. If performance of corruption recovery
  matters, the right fix is to lower `MAX_CONSECUTIVE_FAILURES` from 5 to 2 or 3,
  which caps the stall at 0.2–0.3 s without introducing false-boundary risk.

- **Alternative**: Keep the 1-byte advance. Lower `MAX_CONSECUTIVE_FAILURES` to 2 if the
  recovery latency is genuinely unacceptable. Do not scan for `0xa2` in payload data.
  Downgrade severity to 🟢 Minor.
- **Risk if applied as-is**: The `0xa2` scan creates a new failure mode (false-positive
  record boundaries inside payload data) that produces silent data corruption or cascading
  misparses. This is worse than the original problem.

---

### RE: Finding 6 — Duplicate `RawFileFollower` class

- **Verdict**: ✅ Agree
- **Challenge**: No substantive objection to the diagnosis. The two classes are indeed
  structurally identical except for the poll interval. The suggestion to move
  `RawFileFollower` to `modules/common/` with a configurable `poll_interval` is correct.
  🟡 Major severity is a bit high for a pure DRY issue — the only concrete consequence is
  that all other findings must be fixed in two places. But given the correctness-critical
  nature of this code, DRY here has direct safety implications.
- **Alternative**: Accept as-is. A configurable `poll_interval` parameter is the right
  abstraction.
- **Risk if applied as-is**: None. Straightforward refactor.

---

### RE: Finding 7 — Missing `__init__.py` in `modules/common/`

- **Verdict**: 🔄 Agree with modifications
- **Challenge**: The Optimizer is right that implicit namespace packages can cause problems
  with some tooling. However, the severity claim ("some static analysis tools, import
  linters, and test frameworks fail to recognize the package") is speculative and not
  validated against the actual tooling in this repo. The import `from common.cbor_raw
  import read_raw_record` is already in two production files and appears to work (the PR
  was validated on a live device). The `sys.path.insert(0, ...)` call at the top of each
  module explicitly makes `modules/` the root, which is sufficient for PEP 420 namespace
  packages.

  This is a real nit but not a blocker. 🟢 Minor is the right severity.

- **Alternative**: Add the `__init__.py` (it is a one-line change) but do not overstate
  the risk.
- **Risk if applied as-is**: None.

---

### RE: Finding 8 — `data` length ai=27 raises `ValueError` instead of `EOFError`

- **Verdict**: ⚠️ Disagree on the title framing; the actual content is partially correct
  but the severity is wrong.
- **Challenge**: The finding title says "raises `ValueError` instead of `EOFError`", which
  is the wrong framing. `ai=27` is not a truncation case — it is a valid CBOR encoding for
  a 64-bit byte-string length that this parser simply does not support. The code raises
  `ValueError('Unsupported length encoding: 27')` which is exactly the right exception for
  an unsupported but well-formed encoding. It is not a partial-read that should be
  `EOFError`.

  The upstream reference implementation (`throwaway31265/free-sleep`, commit `7e25c012`)
  has the identical `else: raise ValueError('Unsupported length encoding: %d' % ai)` and
  explicitly chose not to handle `ai=27`. Given that biometric payloads are measured in
  kilobytes, a uint64 byte-string length is impossible in practice.

  The sanity-cap suggestion (reject lengths > 10 MB) is genuinely useful and independent
  of the `ai=27` handling — a corrupt `ai=26` field encoding a 4 GB length could cause
  a huge `f.read()` allocation. That is the real risk, and it applies to `ai=26` as much
  as to a hypothetical `ai=27`. The Optimizer buries the useful suggestion inside a
  low-likelihood scenario. Severity should be ⚪ Nit, not 🟢 Minor.

- **Alternative**: Add a length sanity cap after all `length =` assignments (applies to
  `ai=24`, `ai=25`, `ai=26`):
  ```python
  if length > 1_000_000:
      raise ValueError('Implausibly large data field: %d bytes' % length)
  ```
  Do not add `ai=27` handling unless the firmware is known to use it.
- **Risk if applied as-is**: No risk to the `ai=27` branch addition. But the framing
  (title says "EOFError" when the real issue is the missing sanity cap) may mislead
  reviewers into thinking the error type matters more than the missing bounds check.

---

### RE: Finding 9 — `_consecutive_failures` resets to 0 on file switch but not on partial read

- **Verdict**: ✅ Agree
- **Challenge**: The Optimizer correctly identifies this as a minor issue dependent on
  Finding 1. No substantive objection. The note that a valid/invalid alternating pattern
  would loop forever without Finding 1's seek-back is accurate. 🟢 Minor is right.
- **Alternative**: None needed beyond Finding 1.
- **Risk if applied as-is**: N/A (finding is an observation, not a proposed code change).

---

### RE: Finding 10 — No tests for `cbor_raw.py`

- **Verdict**: ✅ Agree
- **Challenge**: No substantive objection. Hand-written binary parsers without tests are a
  reliability risk, especially on correctness-critical paths. The test matrix described is
  exactly what is needed. 🟢 Minor is appropriate. Worth noting that many of the bugs
  described in Findings 1–4 would be immediately visible with a five-line pytest file.
- **Alternative**: None.
- **Risk if applied as-is**: N/A.

---

### RE: Finding 11 — (Pre-existing) `report_health` connection leak on exception

- **Verdict**: 🔄 Agree with modifications
- **Challenge**: The Optimizer's description of the leak is correct: if `conn.execute()`
  raises inside the `with conn:` block, `conn.close()` on the line after the block is
  skipped. However, the severity claim ("file descriptor exhaustion is possible") is
  overstated for the actual call pattern. `report_health` is called on startup, on clean
  shutdown, and on fatal error. That is at most a handful of calls in the lifetime of the
  process, not a frequent call path. The `except Exception` outer handler silently swallows
  any exception, meaning this is not a high-frequency failure mode.

  The `try/finally` fix is correct and is a one-for-one swap with no downsides.
  🟣 Pre-existing is the right classification. The severity within that class is low.

- **Alternative**: Apply the `try/finally` fix. Keep as pre-existing.
- **Risk if applied as-is**: None.

---

### RE: Finding 12 — (Pre-existing) `_find_latest()` uses `st_mtime` — race on same-second writes

- **Verdict**: ✅ Agree
- **Challenge**: The concern is real on FAT32/FAT16 SD cards (2-second mtime granularity)
  but the consequence in the actual file-following pattern is less severe than described.
  `_find_latest` is called at the top of every loop iteration, but the file switch only
  triggers when `latest != self._path`. If two files have the same mtime and the sort
  flips between them on consecutive calls, `_last_pos` resets to 0 each time, causing
  re-reading from the start of whichever file is picked. This is a real bug (duplicate
  records fed downstream) but it requires two files with identical mtime, which is
  itself rare.

  The `st_mtime_ns` suggestion is correct. Adding the filename as a secondary sort key
  is also viable if the filename encodes a timestamp (which is common for `.RAW` files
  named by creation time).

  🟣 Pre-existing, low severity within that class.

- **Alternative**: Sort by `(st_mtime_ns, name)` as a tiebreaker. Correct as suggested.
- **Risk if applied as-is**: None.

---

## Missed Issues

### Missed Issue 1: `cbor2.CBORDecodeError` in the except clause may not catch all inner decode failures

- **File**: `modules/piezo-processor/main.py:231` + `modules/sleep-detector/main.py:307`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The except clause catches `(ValueError, cbor2.CBORDecodeError, OSError)`.
  In cbor2 5.6.5, `CBORDecodeError` is the base class for decode errors, but its two
  subclasses `CBORDecodeEOF` and `CBORDecodeValueError` are separate names. The C
  extension (`_cbor2`) re-exports all of them, but if the C extension is not available and
  the pure-Python path is used, exception class identity can behave unexpectedly between
  the public `cbor2.CBORDecodeError` and the `cbor2._types.CBORDecodeError` it wraps.
  More concretely: `CBORDecodeEOF` is a subclass of both `CBORDecodeError` *and* `EOFError`
  (confirmed by the upstream PR description: "Calling `cbor2.loads(b'')` raises
  `CBORDecodeEOF`, which is a subclass of `EOFError`"). The current except chain catches
  `EOFError` before `cbor2.CBORDecodeError`. Because `CBORDecodeEOF` is a subclass of
  `EOFError`, it will be caught by the `except EOFError` branch — which does only a sleep
  and no seek-back. If `cbor2.loads(data_bytes)` raises `CBORDecodeEOF` (e.g., if
  `data_bytes` is a truncated inner CBOR record), the code sleeps 0.01 s and retries
  from the same cursor position, re-reading the same truncated `data_bytes` indefinitely
  until a new record arrives. This is an infinite retry loop on corrupt inner data, not a
  live-tail wait. The failure counter is never incremented.
- **Suggested fix**: Catch `cbor2.CBORDecodeError` before `EOFError` in the except chain,
  or catch it alongside `ValueError` before the `EOFError` branch. Since the inner
  `cbor2.loads(data_bytes)` call does not touch the file, a `CBORDecodeError` from it
  should be treated as a corrupt record (increment failures, seek back) not as EOF:
  ```python
  except (ValueError, cbor2.CBORDecodeError, OSError) as e:
      # corrupt record handling ...
  except EOFError:
      time.sleep(0.01)
  ```
  Swap the order of the two except branches.

---

### Missed Issue 2: `f.read(4)` for the "seq" key does not raise `EOFError` on short read — raises `ValueError` instead

- **File**: `modules/common/cbor_raw.py:35-36`
- **Severity**: 🟢 Minor
- **Category**: Edge Case / Correctness
- **Problem**: The `seq` key is read as `if f.read(4) != b'\x63\x73\x65\x71': raise
  ValueError('Expected seq key')`. If the file ends after reading only 1–3 bytes (i.e.,
  `f.read(4)` returns a short but non-empty bytes object), the comparison fails and
  `ValueError` is raised rather than `EOFError`. This means a partial seq key is treated
  as corrupt data rather than as an incomplete record, incrementing `_consecutive_failures`
  instead of triggering the poll sleep. The exact same issue applies to the `data` key at
  line 54: `if f.read(5) != b'\x64\x64\x61\x74\x61':`. Both are partial-read scenarios
  that should be `EOFError` (record not yet fully written) but are misclassified as
  `ValueError` (corrupt record). The upstream implementation has the same gap. This is a
  real issue in the live-tailing scenario where the hardware daemon may flush the record
  header bytes before the key bytes.
- **Suggested fix**: Check the read length before comparing:
  ```python
  seq_key = f.read(4)
  if len(seq_key) < 4:
      raise EOFError
  if seq_key != b'\x63\x73\x65\x71':
      raise ValueError('Expected seq key')
  ```
  Apply the same pattern to the `data` key read (`f.read(5)`).

---

### Missed Issue 3: `not data` check for empty placeholder fires on zero-length reads, not just empty-marker records

- **File**: `modules/common/cbor_raw.py:85-86`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: The empty placeholder check is:
  ```python
  data = f.read(length)
  if len(data) < length:
      raise EOFError
  if not data:
      return None  # empty placeholder record, caller should skip
  ```
  If `length == 0` (CBOR `ai=0`, a zero-byte string), `f.read(0)` returns `b''`. `len(b'')
  < 0` is false, so the `EOFError` check passes. `not data` is true so `None` is returned.
  This is intentional (the firmware empty placeholder has `length=0`). However, if `length`
  is somehow non-zero but `f.read(length)` returns `b''` due to a file descriptor error
  or OS quirk, `len(data) < length` would catch it and raise `EOFError` correctly — so the
  `not data` check is redundant after the length check for the non-zero case. The code
  is correct but the intent is unclear: a comment explaining that `length==0` is the
  firmware placeholder marker would prevent future maintainers from removing what looks
  like a dead branch.
- **Suggested fix**: Add a comment:
  ```python
  if not data:  # length==0: firmware placeholder record (sequence-number marker)
      return None
  ```

---

### Missed Issue 4: `_consecutive_failures` is not reset in the `EOFError` handler — can accumulate across EOF/ValueError interleaving

- **File**: `modules/piezo-processor/main.py:228-230` + `modules/sleep-detector/main.py:305-306`
- **Severity**: 🟢 Minor
- **Category**: Edge Case
- **Problem**: As noted in Finding 9, `_consecutive_failures` is reset on a successful read
  and on a file switch, but NOT in the `EOFError` handler. Combined with the missing seek
  (Finding 1), the following sequence can accumulate failures toward the skip threshold
  without any actual corruption: (1) partial record causes `EOFError`, no seek; (2) next
  iteration reads interior byte, gets `ValueError`, `_consecutive_failures` becomes 1,
  seek to `_last_pos`; (3) same partial record causes `EOFError` again; (4) repeat. Each
  round-trip through this loop increments `_consecutive_failures` by 1. After 5 round-
  trips (which take 5 × 0.1 s = 0.5 s), the record is skipped as corrupt even though it
  was only a timing issue. This is a concrete path to the record loss that Finding 1
  describes — it is the actual mechanism, not the abstract one the Optimizer presents. The
  Optimizer correctly identifies that `_consecutive_failures` should be reset on `EOFError`;
  the proposed fix (seek back) largely resolves it, but explicitly resetting the counter in
  the `EOFError` handler too is belt-and-suspenders:
  ```python
  except EOFError:
      self._file.seek(self._last_pos)      # Finding 1 fix
      self._consecutive_failures = 0       # prevent false corruption detection
      time.sleep(0.01)
  ```
- **Suggested fix**: Reset `_consecutive_failures = 0` in the `EOFError` handler alongside
  the Finding 1 seek.

---

### Missed Issue 5: `RawFileFollower` docstring on `read_records` says "Blocks between records" but the method is a generator — it yields, not blocks

- **File**: `modules/piezo-processor/main.py:201`
- **Severity**: ⚪ Nit
- **Category**: Consistency
- **Problem**: The docstring `"""Yield decoded CBOR records as they arrive. Blocks between
  records."""` is correct in spirit but calling it "Blocks" is misleading. The method is
  a generator; it yields via `yield inner`. Between records it sleeps inside the generator
  body (which suspends the generator frame), but from the caller's perspective `for record
  in follower.read_records()` does not "block" in the traditional sense — it suspends at
  each `yield`. If this code is ever moved into an async context the distinction matters.
- **Suggested fix**: Update the docstring to: `"""Yield decoded CBOR records as they arrive,
  sleeping between poll attempts."""`

---

### Missed Issue 6: The `_find_latest()` calls `p.stat()` inside `sorted()` — `FileNotFoundError` if a file is deleted between `glob()` and `stat()`

- **File**: `modules/piezo-processor/main.py:198` + `modules/sleep-detector/main.py:276`
- **Severity**: 🟢 Minor
- **Category**: Race Condition
- **Problem**: `_find_latest()` does:
  ```python
  candidates = sorted(self.data_dir.glob("*.RAW"), key=lambda p: p.stat().st_mtime, reverse=True)
  ```
  If a `.RAW` file is deleted between the `glob()` enumeration and the `p.stat()` call
  inside `sorted()`, `FileNotFoundError` propagates out of `sorted()`, out of
  `_find_latest()`, and out of `read_records()`. Since `read_records()` is called inside
  a `for record in follower.read_records():` loop in `main()`, the `except Exception`
  handler at line 322/352 catches it, calls `report_health("down", ...)`, and calls
  `sys.exit(1)`. A single deleted file kills the entire process. The upstream implementation
  explicitly handles this case with a `_safe_getmtime` helper that catches
  `FileNotFoundError` and returns 0.
- **Suggested fix**: Wrap `p.stat().st_mtime` in a try/except or filter:
  ```python
  def _safe_mtime(p: Path) -> float:
      try:
          return p.stat().st_mtime
      except FileNotFoundError:
          return 0.0

  candidates = sorted(
      self.data_dir.glob("*.RAW"),
      key=_safe_mtime,
      reverse=True
  )
  candidates = [c for c in candidates if _safe_mtime(c) > 0.0]
  ```

---

## Statistics

- Optimizer findings challenged: 5 (Findings 1, 2, 5, 8, 11)
- Findings agreed with: 5 (Findings 4, 6, 9, 10, 12)
- Findings agreed with modifications: 3 (Findings 3, 7, 11)
  - Note: Finding 11 is counted in both "challenged" (severity overstated) and "agreed
    with modifications" (fix is correct, classification is right)
- New issues found: 6 (Missed Issues 1–6)

### Priority order for missed issues

1. **Missed Issue 1** (CBORDecodeEOF swallowed by EOFError branch) — infinite retry loop
   on corrupt inner records; one-line fix.
2. **Missed Issue 6** (`FileNotFoundError` in `_find_latest` kills process) — crashes the
   biometric pipeline on a race condition the upstream repo specifically guards against.
3. **Missed Issue 2** (partial key read misclassified as corrupt) — correctness issue in
   live-tailing; same pattern as Finding 1 but in `cbor_raw.py` itself.
4. **Missed Issue 4** (`_consecutive_failures` not reset on EOFError) — complement to
   Finding 1; prevents false corruption detection.
5. **Missed Issue 3** (empty placeholder comment) — nit.
6. **Missed Issue 5** (docstring) — nit.
