/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, test, vi } from 'vitest'
import { HardwareClient, createHardwareClient } from '../client'
import { HardwareCommand, MAX_TEMP, MIN_TEMP, PodVersion } from '../types'
import { DEVICE_STATUS_POD3, DEVICE_STATUS_POD4, ERROR_RESPONSE } from './fixtures'
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
      expect(ctx.server.getClientCount()).toBe(1)
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

    test('auto-reconnects by default when the option is omitted', async () => {
      const client = new HardwareClient({
        socketPath: ctx.socketPath,
        connectionTimeout: 1000,
      })
      await client.connect()
      client.disconnect()

      await expect(client.getDeviceStatus()).resolves.toEqual(expect.objectContaining({ podVersion: PodVersion.POD_4 }))
      expect(client.isConnected()).toBe(true)
      client.disconnect()
    })

    test('reports the exact socket failure context and leaves no raw client', async () => {
      const socketPath = `/tmp/nonexistent-client-${Date.now()}.sock`
      const client = new HardwareClient({ socketPath, connectionTimeout: 20 })

      await expect(client.connect()).rejects.toThrow('Failed to connect to hardware:')
      expect(client.getRawClient()).toBeNull()
    })

    test('defends against a reconnect implementation that resolves without a client', async () => {
      const client = new HardwareClient({ socketPath: ctx.socketPath })
      const connect = vi.spyOn(client, 'connect').mockResolvedValue(undefined)

      await expect(client.getDeviceStatus()).rejects.toThrow('Client connection failed')
      expect(connect).toHaveBeenCalledOnce()
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
      ctx.server.setCommandResponse(HardwareCommand.DEVICE_STATUS, DEVICE_STATUS_POD3)

      const status = await ctx.hardwareClient!.getDeviceStatus()
      expect(status.podVersion).toBe(PodVersion.POD_3)
    })

    test('includes gesture data for supported hardware', async () => {
      ctx.server.setCommandResponse(HardwareCommand.DEVICE_STATUS, DEVICE_STATUS_POD4)

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

      expect(ctx.server.getReceivedCommands()).toEqual([
        { command: HardwareCommand.TEMP_LEVEL_LEFT, argument: '2' },
        { command: HardwareCommand.LEFT_TEMP_DURATION, argument: '28800' },
        { command: HardwareCommand.TEMP_LEVEL_LEFT, argument: '-100' },
        { command: HardwareCommand.LEFT_TEMP_DURATION, argument: '28800' },
        { command: HardwareCommand.TEMP_LEVEL_RIGHT, argument: '100' },
        { command: HardwareCommand.RIGHT_TEMP_DURATION, argument: '28800' },
      ])
    })

    test('sends commands to correct side', async () => {
      await ctx.hardwareClient!.setTemperature('left', 70)
      await ctx.hardwareClient!.setTemperature('right', 75, 123)

      expect(ctx.server.getReceivedCommands()).toEqual([
        { command: HardwareCommand.TEMP_LEVEL_LEFT, argument: '-45' },
        { command: HardwareCommand.LEFT_TEMP_DURATION, argument: '28800' },
        { command: HardwareCommand.TEMP_LEVEL_RIGHT, argument: '-27' },
        { command: HardwareCommand.RIGHT_TEMP_DURATION, argument: '123' },
      ])
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

      await expect(
        ctx.hardwareClient!.setAlarm('right', {
          vibrationIntensity: 50,
          vibrationPattern: 'rise',
          duration: -1,
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

      expect(ctx.server.getReceivedCommands().map(({ command }) => command)).toEqual([
        HardwareCommand.ALARM_LEFT,
        HardwareCommand.ALARM_RIGHT,
      ])
    })

    test('throws on hardware error', async () => {
      ctx.server.setCommandResponse(HardwareCommand.ALARM_LEFT, ERROR_RESPONSE)

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
      expect(ctx.server.getReceivedCommands()).toEqual([
        { command: HardwareCommand.ALARM_CLEAR, argument: '0' },
      ])
    })

    test('clears right alarm', async () => {
      await expect(ctx.hardwareClient!.clearAlarm('right')).resolves.not.toThrow()
      expect(ctx.server.getReceivedCommands()).toEqual([
        { command: HardwareCommand.ALARM_CLEAR, argument: '1' },
      ])
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
      ctx.server.setCommandResponse(HardwareCommand.PRIME, ERROR_RESPONSE)

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
      await expect(ctx.hardwareClient!.setPower('right', false)).resolves.not.toThrow()
      expect(ctx.server.getReceivedCommands()).toEqual([
        { command: HardwareCommand.TEMP_LEVEL_RIGHT, argument: '0' },
      ])
    })

    test('validates temperature when powering on', async () => {
      await expect(ctx.hardwareClient!.setPower('left', true, MIN_TEMP - 1)).rejects.toThrow(
        'Temperature must be between'
      )
    })

    test('throws on hardware error when powering off', async () => {
      ctx.server.setCommandResponse(HardwareCommand.TEMP_LEVEL_LEFT, ERROR_RESPONSE)

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
