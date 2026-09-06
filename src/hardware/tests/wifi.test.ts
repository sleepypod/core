/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for the wifi info reader. Mocks fs.readFile and child_process.execFileAsync
 * so we can drive every branch without touching the host's network stack.
 *
 * Primary source is `iw dev <iface> link` (Pod 5 has iw but not iwgetid, and
 * /proc/net/wireless is empty). Fallbacks are /proc/net/wireless (signal) and
 * iwgetid -r (SSID).
 */

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  execFileAsync: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  readFile: mocks.readFile,
  default: { readFile: mocks.readFile },
}))
vi.mock('child_process', () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: mocks.execFileAsync,
  })
  return { execFile, default: { execFile } }
})
import { getWifiInfo, readWifiInfo } from '@/src/hardware/wifi'

const readFileMock = mocks.readFile
const execFileAsyncMock = mocks.execFileAsync

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
  execFileAsyncMock.mockImplementation((cmd: string, args: string[]) => impl(cmd, args) as any)
}

beforeEach(() => {
  readFileMock.mockReset()
  execFileAsyncMock.mockReset()
  delete (globalThis as Record<string, unknown>).__sp_wifi_info__
})

describe('getWifiInfo — iw primary path (Pod 5)', () => {
  it('parses signal (dBm) and SSID from `iw dev <iface> link`', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') return { stdout: iwLink('my-ssid', -67) }
      return {}
    })

    const info = (await readWifiInfo())
    // -67 dBm → 2 * (-67 + 100) = 66
    expect(info.wifiStrength).toBe(66)
    expect(info.wifiSSID).toBe('my-ssid')
  })

  it('clamps signal strength to 0..100', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') return { stdout: iwLink('s', -30) } // very strong
      return {}
    })
    expect((await readWifiInfo()).wifiStrength).toBe(100)
  })

  it('clamps very weak signal to 0', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') return { stdout: iwLink('s', -120) }
      return {}
    })
    expect((await readWifiInfo()).wifiStrength).toBe(0)
  })

  it('accepts protocol whitespace but rejects prefixed lookalike fields', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) {
        return { stdout: 'phy#0\n\tInterface   wlan-long0\n' }
      }
      if (cmd === 'iw' && args[2] === 'link') {
        return {
          stdout: [
            'noise signal: -1 dBm',
            'signal:\t-67   dBm',
            'prefix SSID: wrong',
            'SSID:   living room wifi',
          ].join('\n'),
        }
      }
      return {}
    })

    expect((await readWifiInfo())).toEqual({ wifiStrength: 66, wifiSSID: 'living room wifi' })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'iw',
      ['dev', 'wlan-long0', 'link'],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 2000,
        env: expect.objectContaining({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }),
      }),
    )
  })

  it('parses a positive signed signal value', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[2] === 'link') return { stdout: 'signal: 1 dBm\nSSID: lab' }
      return {}
    })

    expect((await readWifiInfo())).toEqual({ wifiStrength: 100, wifiSSID: 'lab' })
  })

  it('accepts compact signal and SSID fields without optional whitespace', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[2] === 'link') return { stdout: 'signal:-67dBm\nSSID:lab' }
      return {}
    })

    expect((await readWifiInfo())).toEqual({ wifiStrength: 66, wifiSSID: 'lab' })
  })

  it('does not let later prefixed lookalike fields overwrite valid fields', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[2] === 'link') {
        return {
          stdout: [
            'signal: -67 dBm',
            'SSID: primary',
            'noise signal: -1 dBm',
            'prefix SSID: wrong',
          ].join('\n'),
        }
      }
      return {}
    })

    expect((await readWifiInfo())).toEqual({ wifiStrength: 66, wifiSSID: 'primary' })
  })
})

describe('getWifiInfo — fallback to /proc/net/wireless and iwgetid', () => {
  it('uses /proc + iwgetid when `iw dev` lists no interface', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: '' }
      if (cmd === 'iwgetid') return { stdout: 'legacy-ssid\n' }
      return {}
    })
    readFileMock.mockReturnValue(
      'Inter-|   sta-|   Quality        |   Discarded packets\n'
      + ' face | tus  | link level noise |  nwid crypt frag retry misc\n'
      + ' wlan0: 0000   35.  -75.  -256        0      0      0      0      0\n',
    )
    const info = (await readWifiInfo())
    // 35/70 * 100 = 50
    expect(info.wifiStrength).toBe(50)
    expect(info.wifiSSID).toBe('legacy-ssid')
    expect(readFileMock).toHaveBeenCalledWith('/proc/net/wireless', 'utf-8')
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'iwgetid',
      ['-r'],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 2000,
        env: expect.objectContaining({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }),
      }),
    )
  })

  it('uses /proc + iwgetid when `iw dev <iface> link` says "Not connected"', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') return { stdout: 'Not connected.' }
      if (cmd === 'iwgetid') return { stdout: 'legacy-ssid' }
      return {}
    })
    readFileMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   35.  -50.  -256\n')
    expect((await readWifiInfo()).wifiSSID).toBe('legacy-ssid')
    expect((await readWifiInfo()).wifiStrength).toBe(50)
  })

  it('treats a not-connected prefix as authoritative even if stale fields follow it', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') {
        return { stdout: 'Not connected.\nSSID: stale-primary' }
      }
      if (cmd === 'iwgetid') return { stdout: 'fallback-ssid' }
      return {}
    })
    readFileMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   35.  -50.  -256\n')

    expect((await readWifiInfo())).toEqual({ wifiStrength: 50, wifiSSID: 'fallback-ssid' })
  })

  it('trims leading whitespace before recognizing a not-connected response', async () => {
    mockSpawn((cmd, args) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT }
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') {
        return { stdout: '  \nNot connected.\nSSID: stale-primary' }
      }
      if (cmd === 'iwgetid') return { stdout: 'fallback-ssid' }
      return {}
    })
    readFileMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   35.  -50.  -256\n')

    expect((await readWifiInfo())).toEqual({ wifiStrength: 50, wifiSSID: 'fallback-ssid' })
  })
})

describe('getWifiInfo — signal-strength fallback branches', () => {
  beforeEach(() => {
    mockSpawn(() => ({})) // no iw output → all fallbacks
  })

  it('returns -1 when /proc/net/wireless has no interface line', async () => {
    readFileMock.mockReturnValue('Inter-|\n face |\n')
    expect((await readWifiInfo()).wifiStrength).toBe(-1)
  })

  it('returns -1 when link column is not a number', async () => {
    readFileMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   abc   -50.  -256\n')
    expect((await readWifiInfo()).wifiStrength).toBe(-1)
  })

  it('returns -1 when readFile throws (no /proc/net/wireless)', async () => {
    readFileMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect((await readWifiInfo()).wifiStrength).toBe(-1)
  })

  it('clamps /proc link quality to 100', async () => {
    readFileMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   200.  -50.  -256\n')
    expect((await readWifiInfo()).wifiStrength).toBe(100)
  })
})

describe('getWifiInfo — SSID fallback branches', () => {
  beforeEach(() => {
    readFileMock.mockReturnValue('hdr\nhdr\n wlan0: 0 35. -50. -256\n')
  })

  it('returns unknown when iwgetid stdout is empty', async () => {
    mockSpawn(cmd => (cmd === 'iwgetid' ? { stdout: '' } : {}))
    expect((await readWifiInfo()).wifiSSID).toBe('unknown')
  })

  it('returns unknown when iwgetid stdout is missing', async () => {
    mockSpawn(cmd => (cmd === 'iwgetid' ? {} : {}))
    expect((await readWifiInfo()).wifiSSID).toBe('unknown')
  })

  it('returns unknown when execFileAsync for iwgetid throws', async () => {
    execFileAsyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'iwgetid') throw new Error('iwgetid missing')
      return {} as any
    })
    expect((await readWifiInfo()).wifiSSID).toBe('unknown')
  })
})

describe('getWifiInfo — robustness', () => {
  it('falls through to /proc + iwgetid when `iw dev` itself throws', async () => {
    execFileAsyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'iw') throw new Error('iw missing')
      if (cmd === 'iwgetid') return { stdout: 'legacy' } as any
      return {} as any
    })
    readFileMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   35.  -50.  -256\n')
    const info = (await readWifiInfo())
    expect(info.wifiStrength).toBe(50)
    expect(info.wifiSSID).toBe('legacy')
  })

  it('falls through to /proc + iwgetid when the link probe throws (iface detect ok)', async () => {
    execFileAsyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'iw' && args[0] === 'dev' && args.length === 1) return { stdout: IW_DEV_OUTPUT } as any
      if (cmd === 'iw' && args[0] === 'dev' && args[2] === 'link') throw new Error('boom')
      if (cmd === 'iwgetid') return { stdout: 'legacy' } as any
      return {} as any
    })
    readFileMock.mockReturnValue('hdr\nhdr\n wlan0: 0000   35.  -50.  -256\n')
    const info = (await readWifiInfo())
    expect(info.wifiStrength).toBe(50)
    expect(info.wifiSSID).toBe('legacy')
  })
})

describe('getWifiInfo background cache', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function finishRefresh() {
    const cache = (globalThis as Record<string, unknown>).__sp_wifi_info__ as { pending: Promise<void> | null }
    await cache.pending
  }

  it('returns immediately and shares one slow refresh across concurrent readers', async () => {
    let finish: (value: { stdout: string }) => void = () => {}
    execFileAsyncMock.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    mockSpawn(() => ({ stdout: iwLink('home', -67) }))

    for (let i = 0; i < 20; i++) {
      expect(getWifiInfo()).toEqual({ wifiStrength: -1, wifiSSID: 'unknown' })
    }
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    // Even a scheduled event can run while the diagnostic command is pending.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    finish({ stdout: IW_DEV_OUTPUT })
    await finishRefresh()
    expect(getWifiInfo()).toEqual({ wifiStrength: 66, wifiSSID: 'home' })
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes after 30s, keeps the last value during refresh, and retries failures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
    mockSpawn((cmd, args) => ({ stdout: args.length === 1 ? IW_DEV_OUTPUT : iwLink('home', -67) }))
    getWifiInfo()
    await finishRefresh()
    execFileAsyncMock.mockClear()
    vi.advanceTimersByTime(29_999)
    expect(getWifiInfo().wifiSSID).toBe('home')
    expect(execFileAsyncMock).not.toHaveBeenCalled()

    execFileAsyncMock.mockRejectedValue(new Error('command timeout'))
    readFileMock.mockRejectedValue(new Error('ENOENT'))
    vi.advanceTimersByTime(1)
    expect(getWifiInfo().wifiSSID).toBe('home')
    await finishRefresh()
    expect(getWifiInfo()).toEqual({ wifiStrength: -1, wifiSSID: 'unknown' })
    const calls = execFileAsyncMock.mock.calls.length
    getWifiInfo()
    expect(execFileAsyncMock).toHaveBeenCalledTimes(calls)

    vi.advanceTimersByTime(30_000)
    mockSpawn((cmd, args) => ({ stdout: args.length === 1 ? IW_DEV_OUTPUT : iwLink('reconnected', -50) }))
    getWifiInfo()
    await finishRefresh()
    expect(getWifiInfo()).toEqual({ wifiStrength: 100, wifiSSID: 'reconnected' })
  })
})
