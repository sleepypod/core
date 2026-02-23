# Hardware Layer Test Suite

Comprehensive test infrastructure for the Eight Sleep Pod hardware abstraction layer.

## Structure

```
__tests__/
├── README.md              # This file
├── fixtures.ts            # Test data (device responses, constants)
├── mockServer.ts          # Mock hardware daemon (Unix socket server)
├── testUtils.ts           # Test utilities and helpers
├── types.test.ts          # Type definitions and conversion tests
├── sequentialQueue.test.ts    # Command queue tests
├── responseParser.test.ts     # Response parsing tests
├── messageStream.test.ts      # Message framing tests
├── socketClient.test.ts       # Low-level socket client tests
├── client.test.ts             # High-level client API tests
└── integration.test.ts        # Full-stack integration tests
```

## Components

### Mock Hardware Server

`MockHardwareServer` simulates the Pod hardware daemon for testing.

Features:
- Unix socket server that implements the hardware protocol
- Configurable responses for each command
- Simulates delays, errors, and connection issues
- Isolated state per test via beforeEach/afterEach

Usage:
```typescript
const ctx = setupMockServer({ createHardwareClient: true })

test('my test', async () => {
  // Server automatically started, client connected
  await ctx.hardwareClient.getDeviceStatus()
})
```

### Test Fixtures

`fixtures.ts` contains realistic hardware responses:
- `DEVICE_STATUS_POD4` - Pod 4 status with gesture support
- `DEVICE_STATUS_POD3` - Pod 3 status (no gestures)
- `DEVICE_STATUS_POD5` - Pod 5 status
- `OK_RESPONSE`, `ERROR_RESPONSE` - Standard responses

### Test Utilities

`testUtils.ts` provides helpers:
- `setupMockServer()` - Automatic server lifecycle management
- `waitFor()` - Wait for async conditions
- `sleep()` - Promise-based delays

## Running Tests

Run all hardware tests:
```bash
pnpm test run src/hardware/__tests__/
```

Run specific test file:
```bash
pnpm test run src/hardware/__tests__/client.test.ts
```

Run with coverage:
```bash
pnpm test run --coverage src/hardware/__tests__/
```

## Test Organization

### Unit Tests
- `types.test.ts` - Type conversions, enums, error classes, schema validation
- `sequentialQueue.test.ts` - Command queuing, sequential execution
- `responseParser.test.ts` - Response parsing, CBOR decoding
- `messageStream.test.ts` - Message framing, delimiter handling
- `socketClient.test.ts` - Socket connection, command execution
- `client.test.ts` - High-level API, temperature control, alarms

### Integration Tests
- `integration.test.ts` - Full workflows, error recovery, concurrent operations

## Writing New Tests

### Basic Test Structure

```typescript
import { describe, expect, test } from 'vitest'
import { setupMockServer } from './testUtils'

describe('My Feature', () => {
  const ctx = setupMockServer({ createHardwareClient: true })

  test('does something', async () => {
    const result = await ctx.hardwareClient.doSomething()
    expect(result).toBeDefined()
  })
})
```

### Custom Server Configuration

```typescript
test('handles error response', async () => {
  ctx.server.setCommandResponse(HardwareCommand.ALARM_LEFT, ERROR_RESPONSE)

  await expect(
    ctx.hardwareClient.setAlarm('left', { ... })
  ).rejects.toThrow()
})
```

### Simulating Delays

```typescript
test('handles slow hardware', async () => {
  ctx.server.setCommandDelay(HardwareCommand.DEVICE_STATUS, 100)

  const start = Date.now()
  await ctx.hardwareClient.getDeviceStatus()
  const elapsed = Date.now() - start

  expect(elapsed).toBeGreaterThanOrEqual(100)
})
```

## Known Issues

1. **State Isolation**: Some tests may see state from previous tests. The `setupMockServer()` helper should reset state between tests.

2. **Temperature Rounding**: Temperature conversions have ±2°F tolerance due to rounding (especially near neutral 82.5°F).

3. **Mock Server Responses**: Custom responses set in one test may not persist. Call `ctx.server.reset()` if needed.

## Hardware Protocol

The mock server implements the real hardware protocol:
- Command format: `{code}\n{argument}\n\n`
- Response format: `{data}\n\n`
- Delimiter: Double newline (`\n\n`)
- Encoding: UTF-8 text

See `src/hardware/socketClient.ts` for full protocol documentation.

## Coverage Goals

- Unit tests: >90% coverage
- Integration tests: Cover all major workflows
- Error cases: Test all error paths and edge cases
