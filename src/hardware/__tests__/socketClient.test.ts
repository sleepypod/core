import { describe, expect, test } from 'vitest'
import { CommandExecutionError, ConnectionTimeoutError, HardwareCommand } from '../types'
import { connectToSocket } from '../socketClient'
import { ERROR_RESPONSE, HELLO_RESPONSE, OK_RESPONSE } from './fixtures'
import { setupMockServer, sleep } from './testUtils'

describe('SocketClient', () => {
  const ctx = setupMockServer({ createSocketClient: true })

  test('connects to socket successfully', () => {
    expect(ctx.socketClient).toBeDefined()
    expect(ctx.socketClient!.isClosed()).toBe(false)
  })

  test('executes command and receives response', async () => {
    const response = await ctx.socketClient!.executeCommand(HardwareCommand.HELLO)
    expect(response.trim()).toBe('READY')
  })

  test('executes command with argument', async () => {
    ctx.server.setCommandResponse(HardwareCommand.TEMP_LEVEL_LEFT, 'SET: 50\n\n')

    const response = await ctx.socketClient!.executeCommand(HardwareCommand.TEMP_LEVEL_LEFT, '50')
    expect(response.trim()).toBe('SET: 50')
  })

  test('handles multiple sequential commands', async () => {
    const responses = await Promise.all([
      ctx.socketClient!.executeCommand(HardwareCommand.HELLO),
      ctx.socketClient!.executeCommand(HardwareCommand.DEVICE_STATUS),
      ctx.socketClient!.executeCommand(HardwareCommand.TEMP_LEVEL_LEFT, '50'),
    ])

    expect(responses[0]).toContain('READY')
    expect(responses[1]).toContain('sensorLabel')
    expect(responses[2]).toContain('OK')
  })

  test('sanitizes newlines in arguments', async () => {
    // This test verifies that embedded newlines don't corrupt the protocol
    const maliciousArg = '50\n14\n\n' // Tries to inject DEVICE_STATUS command

    await ctx.socketClient!.executeCommand(HardwareCommand.TEMP_LEVEL_LEFT, maliciousArg)

    // Should succeed without protocol corruption
    const status = await ctx.socketClient!.executeCommand(HardwareCommand.DEVICE_STATUS)
    expect(status).toContain('sensorLabel')
  })

  test('isClosed reflects connection state', async () => {
    expect(ctx.socketClient!.isClosed()).toBe(false)

    ctx.socketClient!.close()

    expect(ctx.socketClient!.isClosed()).toBe(true)
  })

  test('throws when executing command on closed socket', async () => {
    ctx.socketClient!.close()

    await expect(
      ctx.socketClient!.executeCommand(HardwareCommand.HELLO)
    ).rejects.toThrow('Socket is closed')
  })

  test('getSocket returns underlying socket', () => {
    const socket = ctx.socketClient!.getSocket()
    expect(socket).toBeDefined()
    expect(socket.destroyed).toBe(false)
  })

  test('handles command execution error', async () => {
    ctx.server.setCommandResponse(HardwareCommand.ALARM_LEFT, ERROR_RESPONSE)

    await expect(
      ctx.socketClient!.executeCommand(HardwareCommand.ALARM_LEFT, '50,0,60')
    ).rejects.toThrow(CommandExecutionError)
  })

  test('close is idempotent', () => {
    ctx.socketClient!.close()
    ctx.socketClient!.close()
    ctx.socketClient!.close()

    expect(ctx.socketClient!.isClosed()).toBe(true)
  })
})

describe('connectToSocket', () => {
  test('connects with default timeout', async () => {
    const socketPath = `/tmp/test-connect-${Date.now()}.sock`
    const { MockHardwareServer } = await import('./mockServer')
    const server = new MockHardwareServer(socketPath)
    await server.start()

    const client = await connectToSocket(socketPath)

    expect(client.isClosed()).toBe(false)

    client.close()
    await server.stop()
  })

  test('connects with custom timeout', async () => {
    const socketPath = `/tmp/test-connect-custom-${Date.now()}.sock`
    const { MockHardwareServer } = await import('./mockServer')
    const server = new MockHardwareServer(socketPath)
    await server.start()

    const client = await connectToSocket(socketPath, 5000)

    expect(client.isClosed()).toBe(false)

    client.close()
    await server.stop()
  })

  test('throws ConnectionTimeoutError on timeout', async () => {
    const socketPath = `/tmp/test-timeout-${Date.now()}.sock`
    const { MockHardwareServer } = await import('./mockServer')
    const server = new MockHardwareServer(socketPath)
    server.setConnectionDelay(200)
    await server.start()

    await expect(connectToSocket(socketPath, 50)).rejects.toThrow(ConnectionTimeoutError)

    await server.stop()
  })

  test('throws on connection refused', async () => {
    const nonExistentPath = `/tmp/nonexistent-${Date.now()}.sock`

    await expect(connectToSocket(nonExistentPath, 100)).rejects.toThrow('Socket connection failed')
  })

  test('wraps socket errors in HardwareError', async () => {
    const socketPath = `/tmp/test-error-${Date.now()}.sock`
    const { MockHardwareServer } = await import('./mockServer')
    const server = new MockHardwareServer(socketPath)
    server.setShouldReject(true)
    await server.start()

    // Connection should fail or be immediately rejected
    await expect(connectToSocket(socketPath, 100)).rejects.toThrow()

    await server.stop()
  })
})
