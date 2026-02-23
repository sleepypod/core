# documentation best practices

## core principle: document WHY not WHAT

Good comments explain reasoning, context, and non-obvious aspects - not what the code already says.

## what to document

**always:**
- Public APIs (functions, classes, exports)
- Complex logic and algorithms
- Workarounds and edge cases
- Hardware timing requirements
- Magic numbers
- Error handling behavior

**never:**
- Self-explanatory code
- Information already in TypeScript types
- Implementation details that match function name

## examples

**❌ bad - restates code:**
```typescript
// Set temperature to 75
setTemp(75)
```

**✅ good - explains behavior:**
```typescript
// Hardware heats/cools at ~1-2°F per minute.
// 75°F from 68°F takes approximately 4-7 minutes.
setTemp(75)
```

**❌ bad - repeats parameter:**
```typescript
/**
 * @param temp - Temperature
 */
```

**✅ good - explains constraints:**
```typescript
/**
 * @param temp - Temperature in Fahrenheit (55-110°F range).
 *                Values outside range are clamped by hardware.
 */
```

## special cases

**hardware interfaces:**
- Document protocol details (message format, delimiters)
- Explain timing requirements (delays, timeouts)
- Note firmware quirks and workarounds

**async operations:**
- Document what happens to pending operations on cleanup
- Explain retry/reconnect behavior
- Clarify whether operations can run in parallel

**error handling:**
- Document which errors can be thrown
- Explain error recovery behavior
- Note silent failures or suppressed errors
