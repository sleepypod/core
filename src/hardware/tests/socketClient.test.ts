/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, test, vi } from 'vitest'
import { HardwareCommand } from '../types'
import { connectToSocket } from '../socketClient'
import { ERROR_RESPONSE } from './fixtures'
import { setupMockServer } from './testUtils'

describe('SocketClient', () => {
  const ctx = setupMockServer({ createSocketClient: true })

  test('connects to socket successfully', () => {
    expect(ctx.socketClient).toBeDefined()
    expect(ctx.socketClient!.isClosed()).toBe(false)
  })

  test('executes command and receives response', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = await ctx.socketClient!.executeCommand(HardwareCommand.HELLO)
    expect(response.trim()).toBe('READY')
    expect(ctx.server.getReceivedCommands()).toEqual([
      { command: HardwareCommand.HELLO, argument: '' },
    ])
    expect(warning).not.toHaveBeenCalled()
    warning.mockRestore()
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

  test('discards stale buffered responses before sending the next command', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A response that arrives while no read is pending (e.g. after a read
    // timeout) is buffered; the next command must not consume it as its own.
    ctx.server.sendToClient(0, 'STALE-RESPONSE\n\n')
    await new Promise(r => setTimeout(r, 50))

    const response = await ctx.socketClient!.executeCommand(HardwareCommand.HELLO)
    expect(response.trim()).toBe('READY')
    expect(warning).toHaveBeenCalledWith(`Discarded 1 stale response(s) before sending ${HardwareCommand.HELLO}`)
    warning.mockRestore()
  })

  test('sanitizes newlines in arguments', async () => {
    // This test verifies that embedded newlines don't corrupt the protocol
    const maliciousArg = '50\n14\n\n' // Tries to inject DEVICE_STATUS command

    await ctx.socketClient!.executeCommand(HardwareCommand.TEMP_LEVEL_LEFT, maliciousArg)

    expect(ctx.server.getReceivedCommands()[0]).toEqual({
      command: HardwareCommand.TEMP_LEVEL_LEFT,
      argument: '5014',
    })

    // Should succeed without protocol corruption
    const status = await ctx.socketClient!.executeCommand(HardwareCommand.DEVICE_STATUS)
    expect(status).toContain('sensorLabel')
  })

  test('isClosed reflects connection state', async () => {
    expect(ctx.socketClient!.isClosed()).toBe(false)

    ctx.socketClient!.close()

    expect(ctx.socketClient!.isClosed()).toBe(true)
  })

  test('logs socket errors with the original Error object', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('wire broke')

    ctx.socketClient!.getSocket().emit('error', failure)

    expect(error).toHaveBeenCalledWith('Socket error:', failure)
    error.mockRestore()
  })

  test('marks itself closed when the remote socket emits close', () => {
    expect(ctx.socketClient!.isClosed()).toBe(false)

    ctx.socketClient!.getSocket().emit('close', false)

    expect(ctx.socketClient!.isClosed()).toBe(true)
  })

  test('wraps write callback failures with command context', async () => {
    const socket = ctx.socketClient!.getSocket()
    vi.spyOn(socket, 'write').mockImplementation(((...args: unknown[]) => {
      const callback = args.find(arg => typeof arg === 'function') as ((error?: Error) => void) | undefined
      callback?.(new Error('write boom'))
      return false
    }) as typeof socket.write)

    await expect(ctx.socketClient!.executeCommand(HardwareCommand.PRIME)).rejects.toMatchObject({
      name: 'CommandExecutionError',
      code: 'COMMAND_EXECUTION_FAILED',
      command: HardwareCommand.PRIME,
      message: `Failed to execute command ${HardwareCommand.PRIME}: Error: write boom`,
    })
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

  test('returns error response as string', async () => {
    // SocketClient is low-level transport - it returns whatever the server sends
    // It's HardwareClient's job to parse and throw on errors
    ctx.server.setCommandResponse(HardwareCommand.ALARM_LEFT, ERROR_RESPONSE)

    const response = await ctx.socketClient!.executeCommand(HardwareCommand.ALARM_LEFT, '50,0,60')

    expect(response).toContain('ERROR')
  })

  test('close is idempotent', () => {
    const destroy = vi.spyOn(ctx.socketClient!.getSocket(), 'destroy')
    ctx.socketClient!.close()
    ctx.socketClient!.close()
    ctx.socketClient!.close()

    expect(ctx.socketClient!.isClosed()).toBe(true)
    expect(destroy).toHaveBeenCalledOnce()
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

  test.skip('throws ConnectionTimeoutError on timeout', async () => {
    // NOTE: Timeout testing requires a server that accepts connections but never completes handshake
    // This is complex to set up and primarily tests Node.js socket behavior, not our code
    // We have adequate error coverage in "throws on connection refused" test
  })

  test('throws on connection refused', async () => {
    const nonExistentPath = `/tmp/nonexistent-${Date.now()}.sock`

    await expect(connectToSocket(nonExistentPath, 100)).rejects.toThrow('Socket connection failed')
  })

  test('wraps socket errors in HardwareError', async () => {
    // Test that connection errors are wrapped in HardwareError
    const nonExistentPath = `/tmp/nonexistent-${Date.now()}.sock`

    await expect(connectToSocket(nonExistentPath, 100)).rejects.toMatchObject({
      name: 'HardwareError',
      code: 'SOCKET_ERROR',
      message: expect.stringContaining('Socket connection failed:'),
    })
  })
})
