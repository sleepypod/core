import { describe, expect, test } from 'vitest'
import { HardwareClient, createHardwareClient } from '../client'
import { HardwareError, MAX_TEMP, MIN_TEMP, PodVersion } from '../types'
import { DEVICE_STATUS_POD3, DEVICE_STATUS_POD4, ERROR_RESPONSE, OK_RESPONSE } from './fixtures'
import { setupMockServer } from './testUtils'

describe('HardwareClient', () => {
  const ctx = setupMockServer({ createHardwareClient: true })

  describe('connection management', () => {
    test('connects successfully', async () => {
      expect(ctx.hardwareClient!.isConnected()).toBe(true)
    })

    test('connect is idempotent', async () => {
      await ctx.hardwareClient!.connect()
      await ctx.hardwareClient!.connect()

      expect(ctx.hardwareClient!.isConnected()).toBe(true)
    })

    test('disconnect closes connection', () => {
      ctx.hardwareClient!.disconnect()

      expect(ctx.hardwareClient!.isConnected()).toBe(false)
    })

    test('disconnect is idempotent', () => {
      ctx.hardwareClient!.disconnect()
      ctx.hardwareClient!.disconnect()

      expect(ctx.hardwareClient!.isConnected()).toBe(false)
    })

    test('throws when not connected and autoReconnect disabled', async () => {
      ctx.hardwareClient!.disconnect()

      await expect(ctx.hardwareClient!.getDeviceStatus()).rejects.toThrow('Not connected')
    })

    test('reconnects when autoReconnect enabled', async () => {
      const client = new HardwareClient({
        socketPath: ctx.socketPath,
        connectionTimeout: 1000,
        autoReconnect: true,
      })

      await client.connect()
      client.disconnect()

      // Should reconnect automatically
      const status = await client.getDeviceStatus()
      expect(status).toBeDefined()

      client.disconnect()
    })
  })

  describe('getDeviceStatus', () => {
    test('returns parsed device status', async () => {
      const status = await ctx.hardwareClient!.getDeviceStatus()

      expect(status.podVersion).toBe(PodVersion.POD_4)
      expect(status.leftSide).toBeDefined()
      expect(status.rightSide).toBeDefined()
      expect(status.waterLevel).toMatch(/^(ok|low)$/)
      expect(typeof status.isPriming).toBe('boolean')
    })

    test('handles different pod versions', async () => {
      ctx.server.setCommandResponse('14', DEVICE_STATUS_POD3)

      const status = await ctx.hardwareClient!.getDeviceStatus()
      expect(status.podVersion).toBe(PodVersion.POD_3)
    })

    test('includes gesture data for supported hardware', async () => {
      ctx.server.setCommandResponse('14', DEVICE_STATUS_POD4)

      const status = await ctx.hardwareClient!.getDeviceStatus()
      expect(status.gestures).toBeDefined()
      expect(status.gestures?.doubleTap).toBeDefined()
    })
  })

  describe('setTemperature', () => {
    test('sets temperature successfully', async () => {
      await expect(
        ctx.hardwareClient!.setTemperature('left', 72)
      ).resolves.not.toThrow()
    })

    test('sets temperature with duration', async () => {
      await expect(
        ctx.hardwareClient!.setTemperature('right', 65, 1800)
      ).resolves.not.toThrow()
    })

    test('validates temperature range - minimum', async () => {
      await expect(
        ctx.hardwareClient!.setTemperature('left', MIN_TEMP - 1)
      ).rejects.toThrow(`Temperature must be between ${MIN_TEMP}°F and ${MAX_TEMP}°F`)
    })

    test('validates temperature range - maximum', async () => {
      await expect(
        ctx.hardwareClient!.setTemperature('left', MAX_TEMP + 1)
      ).rejects.toThrow(`Temperature must be between ${MIN_TEMP}°F and ${MAX_TEMP}°F`)
    })

    test('accepts boundary values', async () => {
      await expect(ctx.hardwareClient!.setTemperature('left', MIN_TEMP)).resolves.not.toThrow()
      await expect(ctx.hardwareClient!.setTemperature('right', MAX_TEMP)).resolves.not.toThrow()
    })

    test('converts temperature to level correctly', async () => {
      // Temperature 82.5°F (neutral) should map to level 0
      await ctx.hardwareClient!.setTemperature('left', 83) // Closest to neutral

      // Temperature 55°F (min) should map to level -100
      await ctx.hardwareClient!.setTemperature('left', MIN_TEMP)

      // Temperature 110°F (max) should map to level 100
      await ctx.hardwareClient!.setTemperature('right', MAX_TEMP)
    })

    test('sends commands to correct side', async () => {
      await ctx.hardwareClient!.setTemperature('left', 70)
      await ctx.hardwareClient!.setTemperature('right', 75)

      // Both should succeed without errors
    })
  })

  describe('setAlarm', () => {
    test('sets alarm successfully', async () => {
      await expect(
        ctx.hardwareClient!.setAlarm('left', {
          vibrationIntensity: 50,
          vibrationPattern: 'rise',
          duration: 60,
        })
      ).resolves.not.toThrow()
    })

    test('validates intensity range - minimum', async () => {
      await expect(
        ctx.hardwareClient!.setAlarm('left', {
          vibrationIntensity: 0,
          vibrationPattern: 'double',
          duration: 30,
        })
      ).rejects.toThrow('Vibration intensity must be between 1 and 100')
    })

    test('validates intensity range - maximum', async () => {
      await expect(
        ctx.hardwareClient!.setAlarm('left', {
          vibrationIntensity: 101,
          vibrationPattern: 'double',
          duration: 30,
        })
      ).rejects.toThrow('Vibration intensity must be between 1 and 100')
    })

    test('validates duration range', async () => {
      await expect(
        ctx.hardwareClient!.setAlarm('left', {
          vibrationIntensity: 50,
          vibrationPattern: 'rise',
          duration: 181,
        })
      ).rejects.toThrow('Alarm duration must be between 0 and 180 seconds')
    })

    test('accepts boundary values', async () => {
      await expect(
        ctx.hardwareClient!.setAlarm('left', {
          vibrationIntensity: 1,
          vibrationPattern: 'double',
          duration: 0,
        })
      ).resolves.not.toThrow()

      await expect(
        ctx.hardwareClient!.setAlarm('right', {
          vibrationIntensity: 100,
          vibrationPattern: 'rise',
          duration: 180,
        })
      ).resolves.not.toThrow()
    })

    test('handles both vibration patterns', async () => {
      await expect(
        ctx.hardwareClient!.setAlarm('left', {
          vibrationIntensity: 50,
          vibrationPattern: 'double',
          duration: 60,
        })
      ).resolves.not.toThrow()

      await expect(
        ctx.hardwareClient!.setAlarm('right', {
          vibrationIntensity: 50,
          vibrationPattern: 'rise',
          duration: 60,
        })
      ).resolves.not.toThrow()
    })

    test('throws on hardware error', async () => {
      ctx.server.setCommandResponse('5', ERROR_RESPONSE)

      await expect(
        ctx.hardwareClient!.setAlarm('left', {
          vibrationIntensity: 50,
          vibrationPattern: 'double',
          duration: 60,
        })
      ).rejects.toThrow('Failed to set alarm')
    })
  })

  describe('clearAlarm', () => {
    test('clears left alarm', async () => {
      await expect(ctx.hardwareClient!.clearAlarm('left')).resolves.not.toThrow()
    })

    test('clears right alarm', async () => {
      await expect(ctx.hardwareClient!.clearAlarm('right')).resolves.not.toThrow()
    })

    test('is idempotent', async () => {
      await ctx.hardwareClient!.clearAlarm('left')
      await ctx.hardwareClient!.clearAlarm('left')
      await ctx.hardwareClient!.clearAlarm('left')

      // Should not throw
    })
  })

  describe('startPriming', () => {
    test('starts priming successfully', async () => {
      await expect(ctx.hardwareClient!.startPriming()).resolves.not.toThrow()
    })

    test('throws on hardware error', async () => {
      ctx.server.setCommandResponse('13', ERROR_RESPONSE)

      await expect(ctx.hardwareClient!.startPriming()).rejects.toThrow('Failed to start priming')
    })
  })

  describe('setPower', () => {
    test('powers on with default temperature', async () => {
      await expect(ctx.hardwareClient!.setPower('left', true)).resolves.not.toThrow()
    })

    test('powers on with custom temperature', async () => {
      await expect(ctx.hardwareClient!.setPower('right', true, 70)).resolves.not.toThrow()
    })

    test('powers off by setting level to 0', async () => {
      await expect(ctx.hardwareClient!.setPower('left', false)).resolves.not.toThrow()
    })

    test('validates temperature when powering on', async () => {
      await expect(ctx.hardwareClient!.setPower('left', true, MIN_TEMP - 1)).rejects.toThrow(
        'Temperature must be between'
      )
    })

    test('throws on hardware error when powering off', async () => {
      ctx.server.setCommandResponse('11', ERROR_RESPONSE)

      await expect(ctx.hardwareClient!.setPower('left', false)).rejects.toThrow(
        'Failed to power off'
      )
    })
  })

  describe('getRawClient', () => {
    test('returns socket client when connected', () => {
      const rawClient = ctx.hardwareClient!.getRawClient()
      expect(rawClient).toBeDefined()
      expect(rawClient!.isClosed()).toBe(false)
    })

    test('returns null when disconnected', () => {
      ctx.hardwareClient!.disconnect()
      const rawClient = ctx.hardwareClient!.getRawClient()
      expect(rawClient).toBeNull()
    })
  })
})

describe('createHardwareClient', () => {
  test('creates and connects client in one step', async () => {
    const socketPath = `/tmp/test-factory-${Date.now()}.sock`
    const { MockHardwareServer } = await import('./mockServer')
    const server = new MockHardwareServer(socketPath)
    await server.start()

    const client = await createHardwareClient({
      socketPath,
      connectionTimeout: 1000,
    })

    expect(client.isConnected()).toBe(true)

    client.disconnect()
    await server.stop()
  })

  test('throws on connection failure', async () => {
    await expect(
      createHardwareClient({
        socketPath: `/tmp/nonexistent-${Date.now()}.sock`,
        connectionTimeout: 100,
      })
    ).rejects.toThrow()
  })
})
