# Integration Tests

System-level integration tests that span multiple subsystems.

## Directory Structure

```
tests/
├── integration/
│   ├── README.md                      # This file
│   └── hardware.integration.test.ts   # Hardware layer end-to-end tests
└── e2e/                               # (Future) Full user flow tests
```

## Hardware Integration Tests

Tests the complete hardware stack end-to-end:
- HardwareClient → SocketClient → MessageStream → MockHardwareServer
- Full workflows: temperature control, alarm management, priming
- Error recovery and reconnection scenarios
- Concurrent and sequential operations
- Pod version compatibility

These tests use the mock hardware server from `src/hardware/__tests__/mockServer.ts`.

## Running Tests

Run all integration tests:
```bash
pnpm test tests/integration/
```

Run specific integration test:
```bash
pnpm test tests/integration/hardware.integration.test.ts
```

Run with coverage:
```bash
pnpm test --coverage tests/integration/
```

## Future Integration Tests

As the application grows, add integration tests for:

### Cross-Subsystem Tests
- `hardware-db.integration.test.ts` - Hardware + Database interactions
- `api-hardware.integration.test.ts` - tRPC API + Hardware layer
- `scheduler-hardware.integration.test.ts` - Job scheduler + Hardware control

### Example Structure
```typescript
describe('Temperature Service Integration', () => {
  const hwCtx = setupMockServer({ createHardwareClient: true })
  const dbCtx = setupTestDatabase()

  test('saves reading to database', async () => {
    const temp = await hwCtx.hardwareClient.getDeviceStatus()
    await temperatureService.saveReading(dbCtx.db, temp)

    const saved = await dbCtx.db.select().from(deviceState)
    expect(saved).toMatchObject({ currentTemperature: temp.leftSide.current })
  })
})
```

## E2E Tests (Future)

Full user flow tests using Playwright or Cypress:
```
tests/
└── e2e/
    ├── temperature-control.e2e.test.ts
    ├── alarm-scheduling.e2e.test.ts
    └── setup.ts
```

These would test:
- Frontend UI interactions
- API calls
- Database persistence
- Hardware control
- Real browser automation
