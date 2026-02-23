# CodeRabbit Feedback Review - PR #100

## Summary

**Total Items**: 16 (9 actionable + 7 nitpicks)
**Recommendation**: Fix 9 critical/high-severity items now, defer 7 to issues

---

## FIX NOW (9 items)

### 1. setPower ignores power-off response ⚠️ CRITICAL
- **File**: `client.ts:330-343`
- **Severity**: High | **Complexity**: Simple
- **Issue**: Response validation missing in power-off branch
- **Fix**: Add `parseSimpleResponse(response)` validation (2 lines)
- **Why**: Silent errors → inconsistent pod state

### 2. Magic numbers in temperature validation
- **File**: `client.ts:180`
- **Severity**: Medium | **Complexity**: Simple
- **Issue**: Hardcoded 55/110 instead of MIN_TEMP/MAX_TEMP constants
- **Fix**: Import constants from types.ts
- **Why**: Constants already exist, prevents drift

### 3. messageStream.destroy() doesn't reject pending promises ⚠️ CRITICAL
- **File**: `messageStream.ts:112-116`
- **Severity**: Critical | **Complexity**: Simple (after #5)
- **Issue**: Sets `pendingRead = null` without rejecting promise → caller hangs
- **Fix**: Call `pendingRead.reject()` before nulling (requires fixing #5 first)
- **Why**: Application hangs on disconnect

### 4. Promise timeout timer never cleared ⚠️ MEMORY LEAK
- **File**: `messageStream.ts:82-92`
- **Severity**: High | **Complexity**: Simple
- **Issue**: setTimeout never cleared → accumulates in long-running processes
- **Fix**: Store timer ID, clearTimeout when message arrives
- **Why**: Resource leak on every successful read

### 5. Event handlers throw instead of reject ⚠️ CRITICAL
- **File**: `messageStream.ts:39-54`
- **Severity**: Critical | **Complexity**: Moderate
- **Issue**: `throw` in event handlers → unhandled exception crash
- **Fix**: Change `pendingRead` to `{resolve, reject, timer}` object, call reject()
- **Why**: Process crashes on socket errors
- **Blocks**: Items #3, #4

### 6. split(' = ') doesn't handle values containing ' = '
- **File**: `responseParser.ts:70`
- **Severity**: Medium | **Complexity**: Simple
- **Issue**: `split(' = ')` on `"key = val = 2"` → drops line
- **Fix**: Use `split(' = ', 2)` to split only first occurrence
- **Why**: Data corruption (silently drops valid fields)

### 7. isPending() always returns wrong value ⚠️ BROKEN
- **File**: `sequentialQueue.ts:28-30`
- **Severity**: High | **Complexity**: Simple
- **Issue**: Compares to new Promise each call → always false
- **Fix**: Use `pendingCount` counter instead
- **Why**: Method completely broken

### 8. Socket errors not wrapped in HardwareError
- **File**: `socketClient.ts:268-271`
- **Severity**: Medium | **Complexity**: Simple
- **Issue**: Timeout rejects with ConnectionTimeoutError, error rejects with raw Error
- **Fix**: Wrap in HardwareError for consistency
- **Why**: Breaks error-specific catch blocks

### 9. Regex validation lacks end anchors ⚠️ SECURITY
- **File**: `types.ts:39-54`
- **Severity**: High | **Complexity**: Simple
- **Issue**: `/-?\d+/` matches `"123abc"` (partial match)
- **Fix**: Add `$` anchor: `/^-?\d+$/`
- **Why**: Validation bypass, data corruption

---

## DEFER TO ISSUES (7 items)

### 10. Should sanitization also strip \r?
- **File**: `socketClient.ts:107`
- **Severity**: Low | **Reason**: No evidence hardware parses \r
- **Issue**: "Improve protocol injection prevention: strip carriage returns?"

### 11. Socket errors don't propagate to MessageStream
- **File**: `socketClient.ts:50-52`
- **Severity**: Medium | **Reason**: Architectural change needs design discussion
- **Issue**: "Should socket errors immediately reject pending reads?"

### 12. Hardcoded 10ms delay adds latency
- **File**: `socketClient.ts:118`
- **Severity**: Low | **Reason**: Needs hardware testing to validate necessity
- **Issue**: "Is 10ms post-write delay still necessary?"

### 13. Auto-reconnect has no retry limit
- **File**: `client.ts:118-133`
- **Severity**: Medium | **Reason**: Complex architectural change
- **Issue**: "Add exponential backoff to auto-reconnect"

### 14. MIN_TEMP/MAX_TEMP constants unused
- **File**: `types.ts:104-113`
- **Severity**: Low | **Reason**: Design decision: clamp or validate?
- **Issue**: "Should temperature conversions clamp to hardware limits?"

### 15. Pod version detection uses lexicographic comparison
- **File**: `responseParser.ts:84-98`
- **Severity**: Low | **Reason**: Works for known versions, needs requirements
- **Issue**: "Replace hwRev string comparison with explicit mapping?"

### 16. Gesture JSON.parse not validated
- **File**: `responseParser.ts:103-125`
- **Severity**: Low | **Reason**: Already has try/catch, optimization
- **Issue**: "Add runtime validation for gesture shape {l, r}?"

---

## Recommended Fix Order

1. **Item #5** (messageStream event handlers) - Blocks #3, #4
2. **Item #3** (destroy reject) - Now unblocked
3. **Item #4** (timer cleanup) - Now unblocked
4. **Item #1** (setPower validation) - Critical for data integrity
5. **Item #9** (regex anchors) - Security issue
6. **Item #7** (isPending broken) - Completely non-functional
7. **Item #6** (split handling) - Data corruption
8. **Item #2** (magic numbers) - Quick win
9. **Item #8** (error wrapping) - Consistency

---

## Draft GitHub Issues

### Issue: Hardware layer improvements for future consideration

**Items needing discussion:**
- Auto-reconnect retry limits and backoff strategy (#13)
- Socket error propagation to pending operations (#11)
- Temperature conversion clamping vs validation (#14)
- Hardware protocol timing requirements documentation (#12)
- Protocol injection prevention enhancements (#10)
- Response parsing validation strictness (#15, #16)

**Priority**: Medium
**Label**: enhancement, hardware, needs-discussion
