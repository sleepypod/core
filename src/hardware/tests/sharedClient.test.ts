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
  sendCommandMock.mockResolvedValue('OK')
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

describe('sharedClient command boundaries', () => {
  async function client() {
    const mod = await freshModule()
    return mod.getSharedHardwareClient()
  }

  it('accepts both exact temperature limits and routes both sides', async () => {
    const c = await client()

    await c.setTemperature('left', 55, 1)
    await c.setTemperature('right', 110, 2)

    expect(sendCommandMock.mock.calls).toEqual([
      ['11', '-100'],
      ['9', '1'],
      ['12', '100'],
      ['10', '2'],
    ])
  })

  it('rejects values immediately outside both temperature limits', async () => {
    const c = await client()

    await expect(c.setTemperature('left', 54)).rejects.toThrow('between 55°F and 110°F')
    await expect(c.setTemperature('right', 111)).rejects.toThrow('between 55°F and 110°F')
    expect(sendCommandMock).not.toHaveBeenCalled()
  })

  it('accepts exact alarm limits and preserves the selected side', async () => {
    const c = await client()

    await c.setAlarm('left', { vibrationIntensity: 1, vibrationPattern: 'rise', duration: 0 })
    await c.setAlarm('right', { vibrationIntensity: 100, vibrationPattern: 'double', duration: 180 })

    expect(sendCommandMock.mock.calls.map(([command]) => command)).toEqual(['5', '6'])
  })

  it('rejects every alarm value immediately outside a boundary', async () => {
    const c = await client()
    const base = { vibrationIntensity: 50, vibrationPattern: 'rise' as const, duration: 30 }

    await expect(c.setAlarm('left', { ...base, vibrationIntensity: 0 })).rejects.toThrow('between 1 and 100')
    await expect(c.setAlarm('left', { ...base, vibrationIntensity: 101 })).rejects.toThrow('between 1 and 100')
    await expect(c.setAlarm('left', { ...base, duration: -1 })).rejects.toThrow('between 0 and 180')
    await expect(c.setAlarm('left', { ...base, duration: 181 })).rejects.toThrow('between 0 and 180')
    expect(sendCommandMock).not.toHaveBeenCalled()
  })

  it('powers off the requested side instead of entering the power-on path', async () => {
    const c = await client()

    await c.setPower('left', false)
    await c.setPower('right', false)

    expect(sendCommandMock.mock.calls).toEqual([
      ['11', '0'],
      ['12', '0'],
    ])
  })
})
