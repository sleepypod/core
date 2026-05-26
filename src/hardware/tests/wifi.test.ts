/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for the wifi info reader. Mocks fs.readFileSync and child_process.spawnSync
 * so we can drive every branch without touching the host's network stack.
 */

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock('fs', () => ({
  readFileSync: mocks.readFileSync,
  default: { readFileSync: mocks.readFileSync },
}))
vi.mock('child_process', () => ({
  spawnSync: mocks.spawnSync,
  default: { spawnSync: mocks.spawnSync },
}))
import { getWifiInfo } from '@/src/hardware/wifi'

const readFileSyncMock = mocks.readFileSync
const spawnSyncMock = mocks.spawnSync

beforeEach(() => {
  readFileSyncMock.mockReset()
  spawnSyncMock.mockReset()
})

describe('getWifiInfo — happy path', () => {
  it('parses link quality and SSID', () => {
    // /proc/net/wireless format: header, header, then `iface: status link level noise ...`
    readFileSyncMock.mockReturnValue(
      'Inter-|   sta-|   Quality        |   Discarded packets\n'
      + ' face | tus  | link level noise |  nwid crypt frag retry misc\n'
      + ' wlan0: 0000   35.  -75.  -256        0      0      0      0      0\n',
    )
    spawnSyncMock.mockReturnValue({ stdout: 'my-home-ssid\n' } as any)

    const info = getWifiInfo()
    // 35/70 * 100 = 50
    expect(info.wifiStrength).toBe(50)
    expect(info.wifiSSID).toBe('my-home-ssid')
  })

  it('clamps link quality to 100', () => {
    readFileSyncMock.mockReturnValue(
      'hdr\nhdr\n wlan0: 0000   200.  -50.  -256        0\n',
    )
    spawnSyncMock.mockReturnValue({ stdout: 'ssid\n' } as any)

    expect(getWifiInfo().wifiStrength).toBe(100)
  })
})

describe('getWifiInfo — signal-strength branches', () => {
  it('returns -1 when /proc/net/wireless has no interface line', () => {
    readFileSyncMock.mockReturnValue('Inter-|\n face |\n')
    spawnSyncMock.mockReturnValue({ stdout: 'ssid' } as any)

    expect(getWifiInfo().wifiStrength).toBe(-1)
  })

  it('returns -1 when link column is not a number', () => {
    readFileSyncMock.mockReturnValue(
      'hdr\nhdr\n wlan0: 0000   abc   -50.  -256\n',
    )
    spawnSyncMock.mockReturnValue({ stdout: 'ssid' } as any)

    expect(getWifiInfo().wifiStrength).toBe(-1)
  })

  it('returns -1 when readFileSync throws (no /proc/net/wireless)', () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    spawnSyncMock.mockReturnValue({ stdout: 'ssid' } as any)

    expect(getWifiInfo().wifiStrength).toBe(-1)
  })
})

describe('getWifiInfo — SSID branches', () => {
  it('returns unknown when iwgetid stdout is empty', () => {
    readFileSyncMock.mockReturnValue('hdr\nhdr\n wlan0: 0 35. -50. -256\n')
    spawnSyncMock.mockReturnValue({ stdout: '' } as any)

    expect(getWifiInfo().wifiSSID).toBe('unknown')
  })

  it('returns unknown when iwgetid stdout is missing', () => {
    readFileSyncMock.mockReturnValue('hdr\nhdr\n wlan0: 0 35. -50. -256\n')
    spawnSyncMock.mockReturnValue({} as any)

    expect(getWifiInfo().wifiSSID).toBe('unknown')
  })

  it('returns unknown when spawnSync throws', () => {
    readFileSyncMock.mockReturnValue('hdr\nhdr\n wlan0: 0 35. -50. -256\n')
    spawnSyncMock.mockImplementation(() => {
      throw new Error('iwgetid missing')
    })

    expect(getWifiInfo().wifiSSID).toBe('unknown')
  })
})
