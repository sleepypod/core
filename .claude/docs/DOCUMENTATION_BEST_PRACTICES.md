# Documentation Best Practices

This document outlines how to write effective code documentation in the sleepypod-core project.

## Core Principle: Document WHY, Not WHAT

Good documentation explains the reasoning, context, and non-obvious aspects of code. It does NOT simply restate what the code already says.

## Bad vs Good Examples

### ❌ BAD: Restating the Obvious

```typescript
/**
 * Close the socket connection.
 */
close() {
  if (!this.closed) {
    this.socket.destroy()
    this.closed = true
  }
}
```

**Problem:** The comment just repeats the function name. It adds no value.

### ✅ GOOD: Explaining Context and Behavior

```typescript
/**
 * Gracefully closes the socket connection to the hardware.
 *
 * Safe to call multiple times - subsequent calls are no-ops.
 * Does NOT wait for pending responses; use disconnect() if you need cleanup.
 *
 * @throws Never - errors during socket destruction are suppressed
 */
close() {
  if (!this.closed) {
    this.socket.destroy()
    this.closed = true
  }
}
```

**Why it's better:**
- Explains the "graceful" behavior
- Clarifies idempotency (safe to call multiple times)
- Distinguishes from similar methods (disconnect vs close)
- Documents error behavior
- Explains what happens to pending operations

## What to Document

### 1. **Public APIs** - ALWAYS document
Document every public function, class, and exported constant.

**Focus on:**
- Purpose and use cases
- Parameters and return values
- Side effects
- Error conditions
- Example usage (for complex APIs)

```typescript
/**
 * Executes a hardware command and waits for the response.
 *
 * Commands are queued and executed sequentially to prevent race conditions
 * with the hardware controller. If connection is lost, auto-reconnects if
 * configured.
 *
 * @param command - Hardware command object (type, params, side)
 * @param timeoutMs - Max wait time for response (default: 30s)
 * @returns Decoded CBOR response from hardware
 * @throws {HardwareError} If hardware returns error code
 * @throws {TimeoutError} If response not received within timeout
 * @throws {ConnectionError} If connection lost and autoReconnect=false
 *
 * @example
 * ```typescript
 * const response = await client.execute({
 *   type: 'setTemp',
 *   params: { temp: 72, side: 'left' }
 * })
 * ```
 */
async execute(command: HardwareCommand, timeoutMs = 30000): Promise<HardwareResponse>
```

### 2. **Complex Logic** - Document the WHY

Explain non-obvious algorithms, workarounds, or business logic.

**Good:**
```typescript
// CBOR encoding uses definite-length arrays for compatibility with the
// hardware controller's C parser. Indefinite-length would save bytes but
// causes parsing errors on the controller (firmware v2.3.1 and earlier).
const encoded = encode(command, { useRecords: false })
```

**Bad:**
```typescript
// Encode the command
const encoded = encode(command, { useRecords: false })
```

### 3. **Workarounds and Hacks** - Document thoroughly

If you're working around a bug or limitation, explain it!

```typescript
// WORKAROUND: The hardware controller doesn't properly close connections
// when receiving SIGTERM, leaving the socket in a half-closed state. We
// explicitly destroy() instead of end() to force immediate cleanup.
// See: https://github.com/sleepypod/firmware/issues/42
socket.destroy()
```

### 4. **TODOs and FIXMEs** - Be specific

```typescript
// TODO(ng): Add retry logic with exponential backoff once we confirm
// the hardware controller can handle rapid reconnection attempts
// (waiting on firmware v2.4.0 release)
await connect()
```

### 5. **Magic Numbers** - Always explain

```typescript
// Bad
const BUFFER_SIZE = 8192

// Good
// Hardware controller sends responses in 4KB chunks. We use 8KB buffer
// to hold two chunks, reducing system calls while staying within the
// controller's max message size (6KB after CBOR encoding).
const BUFFER_SIZE = 8192
```

### 6. **State Machines** - Document states and transitions

```typescript
/**
 * Connection state machine:
 *
 * DISCONNECTED -> (connect()) -> CONNECTING -> (socket 'connect') -> CONNECTED
 *              <- (disconnect()) ------------
 *
 * CONNECTED -> (socket 'error') -> ERROR -> (auto-reconnect) -> CONNECTING
 *           -> (socket 'close') -> DISCONNECTED
 *
 * Any state can transition to ERROR on socket errors.
 * Only ERROR state triggers auto-reconnect if enabled.
 */
enum ConnectionState { ... }
```

## What NOT to Document

### 1. Self-Explanatory Code

```typescript
// Bad - obvious from the code
const isValid = value > 0 && value < 100

// No comment needed - the code is clear
```

### 2. Type Information Already in TypeScript

```typescript
// Bad - TypeScript already tells us this
/**
 * @param name - The user's name (string)
 * @param age - The user's age (number)
 */
function greet(name: string, age: number) { }

// Good - adds context beyond types
/**
 * @param name - Display name (shown in UI, not username)
 * @param age - Must be 18+ for certain features
 */
function greet(name: string, age: number) { }
```

### 3. Standard Patterns

```typescript
// Bad - standard getter, no comment needed
get temperature() {
  return this._temperature
}

// Good - explain deviation from standard pattern
get temperature() {
  // Returns cached value. Call refresh() first for latest hardware reading.
  return this._temperature
}
```

## Documentation Structure

### File Headers

Every file should start with a brief description of its purpose:

```typescript
/**
 * Hardware socket client for TCP communication with the Pod controller.
 *
 * Provides low-level socket operations (connect, send, receive) with
 * automatic reconnection and proper resource cleanup. This is the
 * foundation for the higher-level HardwareClient API.
 *
 * Protocol: Length-prefixed CBOR messages over TCP
 * Default: localhost:5555 (controller's dac.sock Unix socket)
 */
```

### Class Headers

Explain the class's role, responsibilities, and how it fits in the system:

```typescript
/**
 * Main interface for Pod hardware operations.
 *
 * Responsibilities:
 * - Connection lifecycle management (connect, reconnect, disconnect)
 * - Command queuing (sequential execution prevents race conditions)
 * - Response parsing and validation
 * - Error handling and recovery
 *
 * Does NOT handle:
 * - Database persistence (caller's responsibility)
 * - Scheduling (handled by scheduler layer)
 * - Authentication (controller has no auth)
 *
 * Thread Safety: Safe for concurrent execute() calls (internally queued)
 *
 * @example
 * ```typescript
 * const client = new HardwareClient({
 *   host: 'localhost',
 *   port: 5555,
 *   autoReconnect: true
 * })
 *
 * await client.connect()
 * const status = await client.getStatus('left')
 * await client.setTemperature('left', 72)
 * ```
 */
export class HardwareClient { }
```

### Function/Method Comments

Use JSDoc format with these tags when applicable:

- `@param` - Parameter description (add constraints, units, examples)
- `@returns` - Return value description
- `@throws` - What errors can be thrown
- `@example` - Usage examples for complex APIs
- `@see` - References to related code or docs
- `@deprecated` - Mark deprecated APIs

```typescript
/**
 * Sets the target temperature for a pod side.
 *
 * Temperature is applied immediately but physical heating/cooling may take
 * several minutes. Use getStatus() to poll for currentTemp changes.
 *
 * @param side - Which side of the pod ('left' or 'right')
 * @param tempF - Target temperature in Fahrenheit (55-110°F range)
 * @param durationMin - How long to maintain temp (default: indefinite)
 * @returns Hardware acknowledgment with applied temperature
 * @throws {HardwareError} If temp out of range or side not available
 * @throws {ConnectionError} If not connected to hardware
 *
 * @example
 * ```typescript
 * // Set left side to 72°F indefinitely
 * await client.setTemperature('left', 72)
 *
 * // Set right side to 65°F for 30 minutes
 * await client.setTemperature('right', 65, 30)
 * ```
 */
async setTemperature(
  side: 'left' | 'right',
  tempF: number,
  durationMin?: number
): Promise<TempResponse>
```

## Special Cases

### Hardware Interfaces

For hardware abstraction layers, document:

1. **Protocol details** - Message format, encoding, framing
2. **Timing constraints** - Timeouts, rate limits, delays
3. **Hardware quirks** - Firmware bugs, workarounds, version-specific behavior
4. **Recovery behavior** - What happens on errors, disconnects
5. **Thread safety** - Concurrency guarantees

### Error Handling

Document error recovery strategies:

```typescript
/**
 * Connection auto-recovery strategy:
 *
 * 1. On connection loss, marks all pending commands as failed
 * 2. Waits 1 second before first reconnect attempt
 * 3. Uses exponential backoff: 1s, 2s, 4s, 8s, max 30s
 * 4. Retries indefinitely until connect() succeeds
 * 5. Does NOT replay failed commands (caller must retry)
 *
 * To disable auto-reconnect, set config.autoReconnect = false
 */
```

### Async Behavior

Clarify promise behavior and side effects:

```typescript
/**
 * Disconnects from hardware gracefully.
 *
 * Async Flow:
 * 1. Stops accepting new commands (throws ConnectionError)
 * 2. Waits for in-flight command to complete (max 5s)
 * 3. Closes socket connection
 * 4. Clears all state
 *
 * Note: Does NOT throw if already disconnected (idempotent)
 *
 * @param force - If true, immediately close without waiting (default: false)
 */
async disconnect(force = false): Promise<void>
```

## Review Checklist

Before committing, verify your documentation:

- [ ] Public API has JSDoc comments
- [ ] Comments explain WHY, not WHAT
- [ ] Complex logic has inline explanations
- [ ] Magic numbers are explained
- [ ] Error conditions are documented
- [ ] Side effects are described
- [ ] Examples provided for complex APIs
- [ ] Workarounds have issue/ticket references
- [ ] No redundant comments that just restate code

## Tools and Linters

- **TypeScript:** Enforces JSDoc consistency
- **ESLint:** Can enforce JSDoc presence (currently disabled)
- **IDE:** Use VS Code JSDoc hover for quick reference

## References

- [TSDoc Standard](https://tsdoc.org/) - Microsoft's TypeScript documentation standard
- [JSDoc Reference](https://jsdoc.app/) - Tag reference and examples
- [Documentation Guide](https://www.writethedocs.org/guide/) - General documentation principles

## Related Documentation

- [Code Review Guidelines](.claude/docs/PR_REVIEW_PROCESS.md)
- [Testing Guide](../../TESTING_GUIDE.md)
- [Contributing Guidelines](../../CONTRIBUTING.md)
