/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, test } from 'vitest'
import { HardwareCommand } from '../../src/hardware/types'
import { DEVICE_STATUS_POD4, DEVICE_STATUS_POD5, OK_RESPONSE } from '../../src/hardware/tests/fixtures'
import { setupMockServer } from '../../src/hardware/tests/testUtils'

/**
 * Integration tests for the full hardware stack.
 * Tests the complete flow from HardwareClient -> SocketClient -> Mock Hardware.
 */
describe('Hardware Integration', () => {
  const ctx = setupMockServer({ createHardwareClient: true })

  test('complete temperature control workflow', async () => {
    // Get initial status
    const initialStatus = await ctx.hardwareClient!.getDeviceStatus()
    expect(initialStatus).toBeDefined()

    // Set temperature on left side
    await ctx.hardwareClient!.setTemperature('left', 68, 1800)

    // Set temperature on right side
    await ctx.hardwareClient!.setTemperature('right', 75, 3600)

    // Get status again to verify (note: mock server doesn't persist state)
    const updatedStatus = await ctx.hardwareClient!.getDeviceStatus()
    expect(updatedStatus).toBeDefined()
  })

  test('alarm workflow - set and clear', async () => {
    // Set alarm on left side
    await ctx.hardwareClient!.setAlarm('left', {
      vibrationIntensity: 75,
      vibrationPattern: 'rise',
      duration: 120,
    })

    // Set alarm on right side
    await ctx.hardwareClient!.setAlarm('right', {
      vibrationIntensity: 50,
      vibrationPattern: 'double',
      duration: 60,
    })

    // Clear both alarms
    await ctx.hardwareClient!.clearAlarm('left')
    await ctx.hardwareClient!.clearAlarm('right')
  })

  test('priming workflow', async () => {
    // Get status before priming
    const beforeStatus = await ctx.hardwareClient!.getDeviceStatus()
    expect(beforeStatus.isPriming).toBe(false)

    // Start priming
    await ctx.hardwareClient!.startPriming()

    // Configure server to report priming in progress
    ctx.server.setCommandResponse(HardwareCommand.DEVICE_STATUS, DEVICE_STATUS_POD5)

    // Check status
    const duringStatus = await ctx.hardwareClient!.getDeviceStatus()
    expect(duringStatus.isPriming).toBe(true)
  })

  test('power control workflow', async () => {
    // Power on left side
    await ctx.hardwareClient!.setPower('left', true, 72)

    // Power on right side with different temperature
    await ctx.hardwareClient!.setPower('right', true, 68)

    // Power off left side
    await ctx.hardwareClient!.setPower('left', false)

    // Get status
    const status = await ctx.hardwareClient!.getDeviceStatus()
    expect(status).toBeDefined()
  })

  test('multiple concurrent operations', async () => {
    // Send multiple commands concurrently
    const operations = await Promise.all([
      ctx.hardwareClient!.setTemperature('left', 70),
      ctx.hardwareClient!.setTemperature('right', 75),
      ctx.hardwareClient!.setAlarm('left', {
        vibrationIntensity: 50,
        vibrationPattern: 'double',
        duration: 60,
      }),
      ctx.hardwareClient!.getDeviceStatus(),
    ])

    // All should succeed
    expect(operations).toHaveLength(4)
    expect(operations[3]).toBeDefined() // Status response
  })

  test('sequential command execution', async () => {
    const results: string[] = []

    // Execute commands in sequence
    await ctx.hardwareClient!.setTemperature('left', 65)
    results.push('temp1')

    await ctx.hardwareClient!.setTemperature('right', 75)
    results.push('temp2')

    await ctx.hardwareClient!.getDeviceStatus()
    results.push('status')

    await ctx.hardwareClient!.clearAlarm('left')
    results.push('clear')

    // Verify order
    expect(results).toEqual(['temp1', 'temp2', 'status', 'clear'])
  })

  test('error recovery', async () => {
    // Configure server to return error
    ctx.server.setCommandResponse(HardwareCommand.ALARM_LEFT, 'ERROR: Test error\n\n')

    // This should fail
    await expect(
      ctx.hardwareClient!.setAlarm('left', {
        vibrationIntensity: 50,
        vibrationPattern: 'double',
        duration: 60,
      })
    ).rejects.toThrow()

    // Reset to normal responses
    ctx.server.setCommandResponse(HardwareCommand.ALARM_LEFT, OK_RESPONSE)

    // Subsequent commands should still work
    await expect(ctx.hardwareClient!.getDeviceStatus()).resolves.toBeDefined()
  })

  test('connection resilience with autoReconnect', async () => {
    const client = await import('../../src/hardware/client').then(m =>
      m.createHardwareClient({
        socketPath: ctx.socketPath,
        connectionTimeout: 1000,
        autoReconnect: true,
      })
    )

    // Get status
    const status1 = await client.getDeviceStatus()
    expect(status1).toBeDefined()

    // Force disconnect
    client.disconnect()
    expect(client.isConnected()).toBe(false)

    // Next command should reconnect automatically
    const status2 = await client.getDeviceStatus()
    expect(status2).toBeDefined()
    expect(client.isConnected()).toBe(true)

    client.disconnect()
  })

  test('handles rapid command sequences', async () => {
    // Send 20 commands rapidly
    const promises = Array.from({ length: 20 }, (_, i) =>
      ctx.hardwareClient!.setTemperature('left', 70 + i)
    )

    await Promise.all(promises)

    // All should succeed without protocol corruption
    const status = await ctx.hardwareClient!.getDeviceStatus()
    expect(status).toBeDefined()
  })

  test('different pod versions', async () => {
    // Test Pod 4
    ctx.server.setCommandResponse(HardwareCommand.DEVICE_STATUS, DEVICE_STATUS_POD4)
    const pod4Status = await ctx.hardwareClient!.getDeviceStatus()
    expect(pod4Status.podVersion).toBe('I00')
    expect(pod4Status.gestures).toBeDefined()

    // Test Pod 5
    ctx.server.setCommandResponse(HardwareCommand.DEVICE_STATUS, DEVICE_STATUS_POD5)
    const pod5Status = await ctx.hardwareClient!.getDeviceStatus()
    expect(pod5Status.podVersion).toBe('J00')
    expect(pod5Status.gestures).toBeDefined()
  })

  test('temperature conversion round-trip', async () => {
    const { fahrenheitToLevel, levelToFahrenheit } = await import('../../src/hardware/types')

    // Test various temperatures
    const temps = [55, 65, 75, 82, 90, 100, 110]

    for (const temp of temps) {
      const level = fahrenheitToLevel(temp)
      const backToTemp = levelToFahrenheit(level)

      // Should round-trip within 1 degree (due to rounding)
      expect(Math.abs(backToTemp - temp)).toBeLessThanOrEqual(1)
    }
  })

  test('socket stays open across multiple operations', async () => {
    const rawClient = ctx.hardwareClient!.getRawClient()
    expect(rawClient).toBeDefined()

    // Perform multiple operations
    await ctx.hardwareClient!.getDeviceStatus()
    await ctx.hardwareClient!.setTemperature('left', 70)
    await ctx.hardwareClient!.getDeviceStatus()

    // Socket should still be the same instance and open
    const sameRawClient = ctx.hardwareClient!.getRawClient()
    expect(sameRawClient).toBe(rawClient)
    expect(rawClient!.isClosed()).toBe(false)
  })

  test('handles slow hardware responses', async () => {
    // Configure server to delay responses
    ctx.server.setCommandDelay(HardwareCommand.DEVICE_STATUS, 100)

    const startTime = Date.now()
    const status = await ctx.hardwareClient!.getDeviceStatus()
    const elapsed = Date.now() - startTime

    expect(status).toBeDefined()
    // Allow 5ms tolerance for timer precision and scheduling
    expect(elapsed).toBeGreaterThanOrEqual(95)

    // Reset delay
    ctx.server.setCommandDelay(HardwareCommand.DEVICE_STATUS, 0)
  })
})
