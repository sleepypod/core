# Optimizer Findings — fix/cbor-record-parsing

## Summary

This PR fixes a silent data-loss bug where the cbor2 C extension buffered reads in 4096-byte chunks, causing the file cursor to skip past most records in append-only `.RAW` biometrics files. The fix extracts a new shared `modules/common/cbor_raw.py` that hand-parses the outer `{seq, data}` CBOR wrapper using byte-by-byte `f.read()` calls, keeping the file position accurate. It also adds file position tracking (`_last_pos`), a consecutive-failure counter for corrupt-record recovery, and explicit file handle cleanup on shutdown.

---

## Findings

### Finding 1: EOFError on partial record does not seek back — record silently discarded
- **File**: `modules/common/cbor_raw.py` (EOFError paths throughout) + `modules/piezo-processor/main.py:228-230` + `modules/sleep-detector/main.py:305-306`
- **Severity**: 🔴 Critical
- **Category**: Correctness
- **Problem**: `read_raw_record` raises `EOFError` when it runs out of bytes mid-record (e.g., the hardware daemon is still writing the record). At that point the file cursor has already advanced past `_last_pos` — potentially 6–15+ bytes into the record. The `EOFError` handlers in both callers do only `time.sleep(...)` and then loop; they do **not** seek back to `_last_pos`. The next iteration therefore calls `read_raw_record` starting from a position inside the partially-consumed record, which immediately raises `ValueError("Expected outer map 0xa2, ...")`. That `ValueError` increments `_consecutive_failures`, and after 5 such failures `_last_pos` is advanced by 1 and the seek moves forward. The valid-but-incomplete record is permanently discarded — it cannot be recovered from an append-only `.RAW` file.

  Because every in-progress record is partially written at the trailing edge of the file, this will affect the most recently-written record on every polling cycle.
- **Suggested fix**: In both `read_records()` EOFError handlers, seek back to `_last_pos` before sleeping:
  ```python
  except EOFError:
      self._file.seek(self._last_pos)   # <-- add this line
      time.sleep(0.01)                   # (or 0.5 in sleep-detector)
  ```
  Alternatively, have `read_raw_record` accept the starting position and do the seek internally, or document that callers must seek on `EOFError`.
- **Rationale**: Without the seek-back, every record at the live trailing edge of the file is treated as corrupt and discarded. This is likely the most common case in a live-tailing scenario and directly undermines the fix's purpose.

---

### Finding 2: `seq` encoding only handles uint32/uint64 — first ~65 K records on any fresh device fail
- **File**: `modules/common/cbor_raw.py:38-51`
- **Severity**: 🔴 Critical
- **Category**: Correctness
- **Problem**: The parser handles only CBOR uint32 (`0x1a`) and uint64 (`0x1b`) encodings for the `seq` field. CBOR encoders always use the **minimal** encoding: values 0–23 are inline one-byte integers (`0x00`–`0x17`); values 24–255 use `0x18 <byte>`; values 256–65535 use `0x19 <2 bytes>`. Any newly provisioned device (or after factory reset) starts seq at 0 and increases monotonically. A device writing 1 record/second would emit:
  - seq 0–23: inline (fails with `ValueError`) — first 24 records lost
  - seq 24–255: `0x18`-encoded (fails with `ValueError`) — next 232 records lost
  - seq 256–65535: `0x19`-encoded (fails with `ValueError`) — next ~18 hours of records lost (at 1 rec/sec)
  - seq ≥ 65536: `0x1a`-encoded — finally works

  Each failed record cascades through the 5-failure corruption recovery path, adding 0.5 seconds of delay per failed record and permanently discarding the record.
- **Suggested fix**: Handle all five CBOR uint encodings:
  ```python
  hdr = f.read(1)
  if not hdr:
      raise EOFError
  ai = hdr[0] & 0x1f
  mt = hdr[0] >> 5
  if mt != 0:
      raise ValueError('seq must be a uint, got major type %d' % mt)
  if ai <= 23:
      pass  # inline value, no additional bytes needed
  elif ai == 24:
      if len(f.read(1)) < 1: raise EOFError
  elif ai == 25:
      if len(f.read(2)) < 2: raise EOFError
  elif ai == 26:
      if len(f.read(4)) < 4: raise EOFError
  elif ai == 27:
      if len(f.read(8)) < 8: raise EOFError
  else:
      raise ValueError('Unexpected seq encoding: 0x%02x' % hdr[0])
  ```
  (The `seq` value itself is not used by the parser, so the bytes just need to be consumed correctly.)
- **Rationale**: On any device that has ever rebooted or been factory-reset, this parser will silently discard all records until the sequence counter rolls past 65535. Given the PR's goal is zero silent data loss, this is a critical gap.

---

### Finding 3: CBOR map key order assumed, not validated — silent failure on firmware update
- **File**: `modules/common/cbor_raw.py:34-55`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: The parser assumes the two map entries always appear in the order `seq` then `data`. CBOR (RFC 8949) does not guarantee map key ordering in definite-length maps. If the firmware is updated and the encoder emits `data` before `seq` (e.g., due to a different insertion order in the firmware source dict, or a switch to a different CBOR library), the parser will raise `ValueError("Expected seq key")` on every record. This fails silently — all records are treated as corrupt and discarded without any indication that the key order changed.
- **Suggested fix**: Either (a) document this as a hard protocol contract that the firmware team must preserve and add a clear comment naming the upstream firmware commit that establishes this ordering, or (b) write a more flexible parser that reads both key/value pairs regardless of order — the total overhead is minimal since there are only two keys. Option (b) is more defensive:
  ```python
  # Read both key-value pairs in whatever order they arrive
  fields = {}
  for _ in range(2):
      key = _read_cbor_text(f)
      if key == 'seq':
          _skip_cbor_uint(f)
      elif key == 'data':
          fields['data'] = _read_cbor_bytes(f)
      else:
          raise ValueError('Unexpected map key: %r' % key)
  ```
- **Rationale**: Hardware/firmware teams change encoding details without realizing downstream software depends on them. A firmware update that reorders two dict keys could silently break all biometric collection.

---

### Finding 4: Data value major type not validated — wrong bytes silently treated as payload
- **File**: `modules/common/cbor_raw.py:57-80`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: When parsing the `data` value, the code reads the header byte and immediately masks off the additional-info bits (`ai = bs[0] & 0x1f`) without checking the major type (`mt = bs[0] >> 5`). The major type must be `2` for a byte string. If the firmware ever encodes `data` as a text string (`mt=3`, same length-encoding scheme), the code silently returns text bytes to the caller. More critically, if `mt=4` (array) or `mt=5` (map), the `ai` bits encode a **count of items**, not a byte count, so the parser reads the wrong number of bytes from the file, silently corrupting the stream position.
- **Suggested fix**: Add a one-line major type assertion immediately after reading `bs`:
  ```python
  bs = f.read(1)
  if not bs:
      raise EOFError
  if bs[0] >> 5 != 2:                          # <-- add this
      raise ValueError('data must be a byte string, got major type %d' % (bs[0] >> 5))
  ai = bs[0] & 0x1f
  ```
- **Rationale**: Correct CBOR validation requires checking the major type. Without it, any corrupt record or firmware encoding change that changes the `data` type produces silent wrong-length reads that corrupt the file cursor position in unpredictable ways.

---

### Finding 5: Corrupt recovery advances by only 1 byte — O(n × 5 × 0.1s) delay per corrupt region
- **File**: `modules/piezo-processor/main.py:233-237` + `modules/sleep-detector/main.py:309-313`
- **Severity**: 🟡 Major
- **Category**: Performance
- **Problem**: When `_consecutive_failures >= MAX_CONSECUTIVE_FAILURES`, the code advances `_last_pos` by exactly 1 byte and resets the failure counter. A 100-byte corrupt region (e.g., a partial record left by a power-interrupted write) requires 100 × 5 = 500 failed parse attempts, each sleeping 0.1 seconds — 50 seconds of stall before the processor resumes normal operation. A 1 KB corrupt run would stall for ~512 seconds. This is especially problematic for the sleep-detector which tracks session boundaries in real time.
- **Suggested fix**: After confirming a corrupt byte, scan forward in larger steps to find the next valid `0xa2` map header candidate:
  ```python
  if self._consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
      # Scan forward to next potential record boundary (0xa2 = 2-item map)
      log.warning("Corrupt data at offset %d; scanning for next record boundary", self._last_pos)
      self._file.seek(self._last_pos + 1)
      chunk = self._file.read(4096)
      next_candidate = chunk.find(b'\xa2')
      if next_candidate >= 0:
          self._last_pos += 1 + next_candidate
      else:
          self._last_pos += 1 + len(chunk)
      self._consecutive_failures = 0
  ```
- **Rationale**: The Pod is an embedded device; power interruptions are expected and the resulting corrupt trailing bytes are a normal failure mode. The recovery path must be fast enough to not visibly delay biometric collection.

---

### Finding 6: Duplicate `RawFileFollower` class — identical code in two modules
- **File**: `modules/piezo-processor/main.py:184-247` + `modules/sleep-detector/main.py:267-323`
- **Severity**: 🟡 Major
- **Category**: Architecture
- **Problem**: Both modules contain structurally identical `RawFileFollower` classes. The only difference is the `EOFError` poll interval (0.01 s in piezo-processor vs 0.5 s in sleep-detector). All four bugs above (Finding 1–4) must be fixed in two places, and any future fix will again require editing both files. The PR already established `modules/common/cbor_raw.py` as a shared library — `RawFileFollower` is the natural next candidate.
- **Suggested fix**: Move `RawFileFollower` into `modules/common/cbor_raw.py` (or a new `modules/common/raw_follower.py`) with a configurable `poll_interval` parameter:
  ```python
  follower = RawFileFollower(RAW_DATA_DIR, poll_interval=0.01)  # piezo
  follower = RawFileFollower(RAW_DATA_DIR, poll_interval=0.5)   # sleep-detector
  ```
- **Rationale**: DRY is especially important for correctness-critical I/O code. Both copies of Finding 1 exist because the EOFError handler was written identically in both files.

---

### Finding 7: Missing `__init__.py` in `modules/common/` — relies on implicit namespace packages
- **File**: `modules/common/` (directory)
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: `modules/common/` has no `__init__.py`. The import `from common.cbor_raw import read_raw_record` works only because Python 3.3+ supports implicit namespace packages (PEP 420) and `sys.path` includes `modules/`. However, several Python tooling scenarios can break without `__init__.py`: some static analysis tools, import linters, and test frameworks (e.g., pytest's rootdir detection) fail to recognize the package. Docker build steps that use `COPY modules/common /app/common` may also behave differently.
- **Suggested fix**: Add an empty `modules/common/__init__.py`:
  ```bash
  touch modules/common/__init__.py
  ```
- **Rationale**: Explicit is better than implicit. This is a one-byte fix that eliminates a class of environment-dependent import failures.

---

### Finding 8: `data` length ai=27 (uint64 byte-string length) raises `ValueError` instead of `EOFError`
- **File**: `modules/common/cbor_raw.py:79-80`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The parser handles `ai` values 0–26 for the data byte-string length but rejects `ai=27` (8-byte uint64 length) with `ValueError("Unsupported length encoding: 27")`. While a >4 GB biometric payload is impossible in practice, `ai=27` is valid CBOR. If a firmware encoder ever emits it (e.g., using a strict canonical-CBOR encoder that always uses the longest encoding for consistency), the parser will treat the record as corrupt.
- **Suggested fix**: Add an `ai == 27` branch:
  ```python
  elif ai == 27:
      lb = f.read(8)
      if len(lb) < 8:
          raise EOFError
      length = struct.unpack('>Q', lb)[0]
  ```
  Optionally add a sanity cap: `if length > 10_000_000: raise ValueError('Implausibly large data field: %d bytes' % length)`.
- **Rationale**: Low likelihood but easy to fix; also adds the opportunity to add the size-sanity cap that would prevent a corrupt length field from causing a multi-gigabyte `f.read()`.

---

### Finding 9: `_consecutive_failures` resets to 0 on file switch but not on successful record after partial read
- **File**: `modules/piezo-processor/main.py:215-226` + `modules/sleep-detector/main.py:292-303`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: When a new file is opened (`latest != self._path`), both `_last_pos` and `_consecutive_failures` are correctly reset. However, `_consecutive_failures` is also reset on every successful read and on every null-data record, so there is no edge case here. This is a note confirming the reset logic is correct, but it means a file with alternating valid/invalid records (e.g., valid → invalid → valid → invalid...) would never hit the 5-failure skip threshold. The counter resets to 0 on each valid read, so corruption isolated to a single corrupt record would retry indefinitely (once per loop without the seek-back fix from Finding 1). This becomes a real issue only if Finding 1 is not fixed.
- **Suggested fix**: The immediate fix is Finding 1 (seek back on EOFError). Additionally, consider whether `_consecutive_failures` should accumulate globally (not reset on success) for a more aggressive skip threshold.
- **Rationale**: Mild, dependent on Finding 1 being fixed first.

---

### Finding 10: No tests for `cbor_raw.py`
- **File**: `modules/common/cbor_raw.py` (no test file exists)
- **Severity**: 🟢 Minor
- **Category**: Testing
- **Problem**: The new `cbor_raw.py` module is the correctness-critical parsing layer and has no unit tests. The bugs in Findings 1–5 above could all have been caught by a small test suite covering: (a) normal round-trip, (b) EOFError at each stage of parsing, (c) seq values spanning all CBOR uint encodings (0, 23, 24, 255, 256, 65535, 65536), (d) empty `data=b''` placeholder records.
- **Suggested fix**: Add `modules/common/test_cbor_raw.py` (or `tests/python/test_cbor_raw.py`) covering at minimum:
  - One complete valid record (seq uint32, seq uint64)
  - One empty placeholder record (data=b'')
  - EOFError at each of the 7 read points inside `read_raw_record`
  - seq encoded as inline uint (0x00), uint8 (0x18), uint16 (0x19) to document expected behavior (fails today, should pass after Finding 2 fix)
- **Rationale**: Hand-written binary parsers accumulate subtle bugs without tests. This code runs on real biometric data and any parsing error means lost health data.

---

### Finding 11: (Pre-existing) `report_health` opens a new SQLite connection on every call — connection not always closed on exception
- **File**: `modules/piezo-processor/main.py:100-116` + `modules/sleep-detector/main.py:123-138`
- **Severity**: 🟣 Pre-existing
- **Category**: Correctness
- **Problem**: `report_health` opens a fresh `sqlite3.Connection` on each invocation and calls `conn.close()` after the `with conn:` block. However, if the `conn.execute(...)` inside the `with conn:` block raises an exception (which is silently caught by the outer `except Exception`), `conn.close()` is never called. The connection leaks until garbage collection. On a long-running process that calls `report_health` frequently and an error path is hit repeatedly, file descriptor exhaustion is possible on embedded targets with low FD limits.
- **Suggested fix**: Use `try/finally` or a `with contextlib.closing(conn):` wrapper:
  ```python
  conn = sqlite3.connect(str(SLEEPYPOD_DB), timeout=2.0)
  try:
      with conn:
          conn.execute(...)
  finally:
      conn.close()
  ```
- **Rationale**: Pre-existing, but worth noting for embedded deployment where FD limits are tight.

---

### Finding 12: (Pre-existing) `_find_latest()` uses `st_mtime` to pick newest file — race condition on same-second writes
- **File**: `modules/piezo-processor/main.py:197-199` + `modules/sleep-detector/main.py:275-277`
- **Severity**: 🟣 Pre-existing
- **Category**: Correctness
- **Problem**: `_find_latest` sorts `.RAW` candidates by `st_mtime`. If two `.RAW` files are created within the same second (or the same mtime tick on a filesystem with 1-second resolution), the sort order is non-deterministic. The follower may jump between files on consecutive calls to `_find_latest`, reopening the file and resetting `_last_pos` each time.
- **Suggested fix**: Sort by filename (which likely encodes a timestamp) as a tiebreaker, or compare `st_mtime_ns` for sub-second resolution:
  ```python
  candidates = sorted(..., key=lambda p: p.stat().st_mtime_ns, reverse=True)
  ```
- **Rationale**: Pre-existing, noted for awareness on filesystems with coarse mtime resolution (FAT32 on embedded SD cards uses 2-second granularity).

---

## Statistics

| # | Title | Severity |
|---|-------|----------|
| 1 | EOFError on partial record does not seek back | 🔴 Critical |
| 2 | seq encoding only handles uint32/uint64 | 🔴 Critical |
| 3 | CBOR map key order assumed, not validated | 🟡 Major |
| 4 | Data value major type not validated | 🟡 Major |
| 5 | Corrupt recovery advances by only 1 byte | 🟡 Major |
| 6 | Duplicate RawFileFollower class | 🟡 Major |
| 7 | Missing `__init__.py` in `modules/common/` | 🟢 Minor |
| 8 | data length ai=27 raises ValueError not EOFError | 🟢 Minor |
| 9 | _consecutive_failures interaction with Finding 1 | 🟢 Minor |
| 10 | No tests for cbor_raw.py | 🟢 Minor |
| 11 | report_health connection leak on exception | 🟣 Pre-existing |
| 12 | _find_latest mtime race condition | 🟣 Pre-existing |

- **Total findings**: 12
- **🔴 Critical**: 2 (Findings 1, 2)
- **🟡 Major**: 4 (Findings 3, 4, 5, 6)
- **🟢 Minor**: 4 (Findings 7, 8, 9, 10)
- **🟣 Pre-existing**: 2 (Findings 11, 12)

### Priority order for fixes before merge

1. **Finding 1** (EOFError no seek-back) — one-line fix, eliminates live-edge record loss
2. **Finding 2** (seq encoding gap) — ~10-line fix, eliminates data loss on device boot/reset
3. **Finding 4** (data major type) — one-line fix, closes a silent misparse vector
4. **Finding 5** (byte-at-a-time recovery) — modest fix, prevents 50+ second stalls after power interruption
5. **Finding 3** (key order) — add a comment or refactor; low likelihood but high-consequence failure mode
6. **Finding 6** (duplicate class) — housekeeping, but blocks Finding 1 from needing two fixes
