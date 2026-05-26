/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for the wifi info reader. Mocks fs.readFileSync and child_process.spawnSync
 * so we can drive every branch without touching the host's network stack.
 *
 * Primary source is `iw dev <iface> link` (Pod 5 has iw but not iwgetid, and
 * /proc/net/wireless is empty). Fallbacks are /proc/net/wireless (signal) and
 * iwgetid -r (SSID).
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

const IW_DEV_OUTPUT = `phy#0
\tInterface wlan0
\t\tifindex 2
\t\taddr 70:b6:51:02:aa:d7
\t\tssid ng
\t\ttype managed
`

function iwLink(ssid: string, signalDbm: number): string {
  return `Connected to 0c:ea:14:30:52:77 (on wlan0)
\tSSID: ${ssid}
\tfreq: 5745
\tsignal: ${signalDbm} dBm
\ttx bitrate: 585.0 MBit/s
`
}

function mockSpawn(impl: (cmd: string, args: string[]) => { stdout?: string }) {
  spawnSyncMock.mockImplementation((cmd: string, args: string[]) => impl(cmd, args) as any)
}

beforeEach(() => {
  readFileSyncMock.mockReset()
  spawnSyncMock.mockReset()
})

describe('getWifiInfo — iw primary path (Pod 5)', () => {
  it('parses signal (dBm) and SSID from `iw dev <iface> link`', () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') return { stdout: iwLink('my-ssid', -67) }
      return {}
    })

    const info = getWifiInfo()
    // -67 dBm → 2 * (-67 + 100) = 66
    expect(info.wifiStrength).toBe(66)
    expect(info.wifiSSID).toBe('my-ssid')
  })

  it('clamps signal strength to 0..100', () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') return { stdout: iwLink('s', -30) } // very strong
      return {}
    })
    expect(getWifiInfo().wifiStrength).toBe(100)
  })

  it('clamps very weak signal to 0', () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') return { stdout: iwLink('s', -120) }
      return {}
    })
    expect(getWifiInfo().wifiStrength).toBe(0)
  })
})

describe('getWifiInfo — fallback to /proc/net/wireless and iwgetid', () => {
  it('uses /proc + iwgetid when `iw dev` lists no interface', () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: '' }
      if (cmd === 'iwgetid') return { stdout: 'legacy-ssid\n' }
      return {}
    })
    readFileSyncMock.mockReturnValue(
      'Inter-|   sta-|   Quality        |   Discarded packets\n'
      + ' face | tus  | link level noise |  nwid crypt frag retry misc\n'
      + ' wlan0: 0000   35.  -75.  -256        0      0      0      0      0\n',
    )
    const info = getWifiInfo()
    // 35/70 * 100 = 50
    expect(info.wifiStrength).toBe(50)
    expect(info.wifiSSID).toBe('legacy-ssid')
  })

  it('uses /proc + iwgetid when `iw dev <iface> link` says "Not connected"', () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') return { stdout: 'Not connected.' }
      if (cmd === 'iwgetid') return { stdout: 'legacy-ssid' }
      return {}
    })
    readFileSyncMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   35.  -50.  -256\n')
    expect(getWifiInfo().wifiSSID).toBe('legacy-ssid')
    expect(getWifiInfo().wifiStrength).toBe(50)
  })
})

describe('getWifiInfo — signal-strength fallback branches', () => {
  beforeEach(() => {
    mockSpawn(() => ({})) // no iw output → all fallbacks
  })

  it('returns -1 when /proc/net/wireless has no interface line', () => {
    readFileSyncMock.mockReturnValue('Inter-|\n face |\n')
    expect(getWifiInfo().wifiStrength).toBe(-1)
  })

  it('returns -1 when link column is not a number', () => {
    readFileSyncMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   abc   -50.  -256\n')
    expect(getWifiInfo().wifiStrength).toBe(-1)
  })

  it('returns -1 when readFileSync throws (no /proc/net/wireless)', () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(getWifiInfo().wifiStrength).toBe(-1)
  })

  it('clamps /proc link quality to 100', () => {
    readFileSyncMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   200.  -50.  -256\n')
    expect(getWifiInfo().wifiStrength).toBe(100)
  })
})

describe('getWifiInfo — SSID fallback branches', () => {
  beforeEach(() => {
    readFileSyncMock.mockReturnValue('hdr\nhdr\n wlan0: 0 35. -50. -256\n')
  })

  it('returns unknown when iwgetid stdout is empty', () => {
    mockSpawn((cmd) => (cmd === 'iwgetid' ? { stdout: '' } : {}))
    expect(getWifiInfo().wifiSSID).toBe('unknown')
  })

  it('returns unknown when iwgetid stdout is missing', () => {
    mockSpawn((cmd) => (cmd === 'iwgetid' ? {} : {}))
    expect(getWifiInfo().wifiSSID).toBe('unknown')
  })

  it('returns unknown when spawnSync for iwgetid throws', () => {
    spawnSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'iwgetid') throw new Error('iwgetid missing')
      return {} as any
    })
    expect(getWifiInfo().wifiSSID).toBe('unknown')
  })
})

describe('getWifiInfo — robustness', () => {
  it('falls through to /proc + iwgetid when `iw dev` itself throws', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'iw') throw new Error('iw missing')
      if (cmd === 'iwgetid') return { stdout: 'legacy' } as any
      return {} as any
    })
    readFileSyncMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   35.  -50.  -256\n')
    const info = getWifiInfo()
    expect(info.wifiStrength).toBe(50)
    expect(info.wifiSSID).toBe('legacy')
  })

  it('falls through to /proc + iwgetid when the link probe throws (iface detect ok)', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT } as any
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') throw new Error('boom')
      if (cmd === 'iwgetid') return { stdout: 'legacy' } as any
      return {} as any
    })
    readFileSyncMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   35.  -50.  -256\n')
    const info = getWifiInfo()
    expect(info.wifiStrength).toBe(50)
    expect(info.wifiSSID).toBe('legacy')
  })
})
