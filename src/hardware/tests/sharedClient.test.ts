/**
 * Tests for src/hardware/sharedClient.ts.
 *
 * Focuses on the `sendRaw` debug path used by device.execute — it must
 * auto-connect when the transport is idle and forward verbatim to
 * sendCommand. The wider client surface is exercised through dacMonitor /
 * device router tests; this file just patches the coverage gap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const connectDacMock = vi.fn<(path: string) => Promise<void>>(async () => {})
const sendCommandMock = vi.fn<(cmd: string, arg?: string) => Promise<string>>(async () => 'OK\n\n')
const isDacConnectedMock = vi.fn(() => true)

vi.mock('../dacTransport', () => ({
  connectDac: (path: string) => connectDacMock(path),
  sendCommand: (cmd: string, arg?: string) => sendCommandMock(cmd, arg),
  isDacConnected: () => isDacConnectedMock(),
}))

import type * as SharedClientModule from '../sharedClient'
type Module = typeof SharedClientModule

async function freshModule(): Promise<Module> {
  vi.resetModules()
  const g = globalThis as Record<string, unknown>
  delete g['__sp_hw_client__']
  return await import('../sharedClient')
}

beforeEach(() => {
  connectDacMock.mockClear()
  sendCommandMock.mockClear()
  isDacConnectedMock.mockReset()
  isDacConnectedMock.mockReturnValue(true)
})

afterEach(() => {
  const g = globalThis as Record<string, unknown>
  delete g['__sp_hw_client__']
})

describe('sharedClient singleton', () => {
  it('returns the same instance across calls', async () => {
    const mod = await freshModule()
    const a = mod.getSharedHardwareClient()
    const b = mod.getSharedHardwareClient()
    expect(a).toBe(b)
  })

  it('clearSharedHardwareClient drops the cached instance', async () => {
    const mod = await freshModule()
    const a = mod.getSharedHardwareClient()
    mod.clearSharedHardwareClient()
    const b = mod.getSharedHardwareClient()
    expect(a).not.toBe(b)
  })
})

describe('sharedClient.sendRaw', () => {
  it('forwards command + args verbatim to sendCommand when already connected', async () => {
    const mod = await freshModule()
    const client = mod.getSharedHardwareClient() as unknown as {
      sendRaw: (cmd: string, args?: string) => Promise<string>
    }
    sendCommandMock.mockResolvedValueOnce('raw-response')

    const result = await client.sendRaw('5', 'deadbeef')

    expect(connectDacMock).not.toHaveBeenCalled()
    expect(sendCommandMock).toHaveBeenCalledWith('5', 'deadbeef')
    expect(result).toBe('raw-response')
  })

  it('auto-connects when DAC is idle, then forwards to sendCommand', async () => {
    const mod = await freshModule()
    isDacConnectedMock.mockReturnValue(false)
    const client = mod.getSharedHardwareClient() as unknown as {
      sendRaw: (cmd: string, args?: string) => Promise<string>
    }

    await client.sendRaw('14')

    expect(connectDacMock).toHaveBeenCalledTimes(1)
    expect(sendCommandMock).toHaveBeenCalledWith('14', undefined)
  })
})
