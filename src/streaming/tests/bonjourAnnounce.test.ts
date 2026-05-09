/**
 * Tests for the Bonjour/mDNS Avahi service-file orchestration.
 *
 * The module shells out via node:fs and node:child_process; we mock both so
 * tests stay hermetic. Coverage targets the dev-mode skip, the read-only-fs
 * fallback, the write-then-reload happy path, the unlink-on-stop path, and
 * the outer error guards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted state shared with the node:fs / node:child_process mocks. Each test
// drives behaviour by toggling these flags rather than reaching into the mocks
// directly.
interface FsState {
  existing: Set<string>
  writeThrows: boolean
  mkdirThrows: boolean
  unlinkThrows: boolean
}

const fsMock = vi.hoisted(() => {
  const state: FsState = {
    existing: new Set<string>(),
    writeThrows: false,
    mkdirThrows: false,
    unlinkThrows: false,
  }
  return {
    state,
    existsSync: vi.fn((p: string) => state.existing.has(p)),
    writeFileSync: vi.fn((p: string, _body: string) => {
      if (state.writeThrows) throw new Error('EROFS: read-only')
      state.existing.add(p)
      return _body
    }),
    mkdirSync: vi.fn(() => {
      if (state.mkdirThrows) throw new Error('EROFS: read-only')
    }),
    unlinkSync: vi.fn((p: string) => {
      if (state.unlinkThrows) throw new Error('EROFS: read-only')
      state.existing.delete(p)
    }),
  }
})

const childMock = vi.hoisted(() => {
  const state: { execThrows: boolean } = { execThrows: false }
  return {
    state,
    execSync: vi.fn(() => {
      if (state.execThrows) throw new Error('no avahi-daemon running')
      return Buffer.from('')
    }),
  }
})

vi.mock('node:fs', () => {
  const api = {
    existsSync: fsMock.existsSync,
    writeFileSync: fsMock.writeFileSync,
    mkdirSync: fsMock.mkdirSync,
    unlinkSync: fsMock.unlinkSync,
  }
  return { ...api, default: api }
})

vi.mock('node:child_process', () => {
  const api = { execSync: childMock.execSync }
  return { ...api, default: api }
})

const SERVICE_FILE = '/etc/avahi/services/sleepypod.service'

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fsMock.state.existing = new Set<string>()
  fsMock.state.writeThrows = false
  fsMock.state.mkdirThrows = false
  fsMock.state.unlinkThrows = false
  childMock.state.execThrows = false
  fsMock.existsSync.mockClear()
  fsMock.writeFileSync.mockClear()
  fsMock.mkdirSync.mockClear()
  fsMock.unlinkSync.mockClear()
  childMock.execSync.mockClear()
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  warnSpy.mockRestore()
})

async function loadModule() {
  return await import('../bonjourAnnounce')
}

describe('startBonjourAnnouncement', () => {
  it('skips with a dev-mode log when /etc/avahi is absent', async () => {
    const { startBonjourAnnouncement } = await loadModule()

    startBonjourAnnouncement()

    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
    expect(childMock.execSync).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('No Avahi found (dev mode)'),
    )
  })

  it('writes the service file and reloads avahi when /etc/avahi exists but file does not', async () => {
    fsMock.state.existing.add('/etc/avahi')
    const { startBonjourAnnouncement } = await loadModule()

    startBonjourAnnouncement()

    expect(fsMock.mkdirSync).toHaveBeenCalledWith('/etc/avahi/services', { recursive: true })
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1)
    const [path, body] = fsMock.writeFileSync.mock.calls[0] as [string, string]
    expect(path).toBe(SERVICE_FILE)
    expect(body).toContain('<type>_sleepypod._tcp</type>')
    expect(body).toContain('<port>3000</port>')
    expect(body).toContain('wsPort=3001')
    expect(body).toContain('version=1.0.0')
    expect(childMock.execSync).toHaveBeenCalledWith(
      expect.stringContaining('kill -HUP'),
      expect.objectContaining({ stdio: 'ignore' }),
    )
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Advertising _sleepypod._tcp on port 3000'),
    )
  })

  it('reloads avahi without rewriting when the service file is already present', async () => {
    fsMock.state.existing.add('/etc/avahi')
    fsMock.state.existing.add(SERVICE_FILE)
    const { startBonjourAnnouncement } = await loadModule()

    startBonjourAnnouncement()

    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
    expect(fsMock.mkdirSync).not.toHaveBeenCalled()
    expect(childMock.execSync).toHaveBeenCalledTimes(1)
  })

  it('logs the read-only fallback when writing the service file is forbidden', async () => {
    fsMock.state.existing.add('/etc/avahi')
    fsMock.state.writeThrows = true
    const { startBonjourAnnouncement } = await loadModule()

    startBonjourAnnouncement()

    expect(fsMock.writeFileSync).toHaveBeenCalled()
    expect(childMock.execSync).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('mDNS unavailable'),
    )
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Re-run the installer'),
    )
  })

  it('also takes the read-only fallback when mkdirSync fails', async () => {
    fsMock.state.existing.add('/etc/avahi')
    fsMock.state.mkdirThrows = true
    const { startBonjourAnnouncement } = await loadModule()

    startBonjourAnnouncement()

    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
    expect(childMock.execSync).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('mDNS unavailable'),
    )
  })

  it('swallows execSync failure when avahi-daemon is not running', async () => {
    fsMock.state.existing.add('/etc/avahi')
    fsMock.state.existing.add(SERVICE_FILE)
    childMock.state.execThrows = true
    const { startBonjourAnnouncement } = await loadModule()

    expect(() => startBonjourAnnouncement()).not.toThrow()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Advertising _sleepypod._tcp on port 3000'),
    )
  })

  it('warns via the outer guard when existsSync throws unexpectedly', async () => {
    fsMock.existsSync.mockImplementationOnce(() => {
      throw new Error('fs blew up')
    })
    const { startBonjourAnnouncement } = await loadModule()

    expect(() => startBonjourAnnouncement()).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to configure Avahi service'),
      expect.anything(),
    )
  })
})

describe('stopBonjourAnnouncement', () => {
  it('does nothing observable when the service file does not exist', async () => {
    const { stopBonjourAnnouncement } = await loadModule()

    stopBonjourAnnouncement()

    expect(fsMock.unlinkSync).not.toHaveBeenCalled()
    expect(childMock.execSync).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('mDNS announcement stopped'),
    )
  })

  it('removes the service file and reloads avahi when present', async () => {
    fsMock.state.existing.add(SERVICE_FILE)
    const { stopBonjourAnnouncement } = await loadModule()

    stopBonjourAnnouncement()

    expect(fsMock.unlinkSync).toHaveBeenCalledWith(SERVICE_FILE)
    expect(childMock.execSync).toHaveBeenCalledWith(
      expect.stringContaining('kill -HUP'),
      expect.objectContaining({ stdio: 'ignore' }),
    )
  })

  it('swallows unlink/execSync failure on a read-only rootfs', async () => {
    fsMock.state.existing.add(SERVICE_FILE)
    fsMock.state.unlinkThrows = true
    const { stopBonjourAnnouncement } = await loadModule()

    expect(() => stopBonjourAnnouncement()).not.toThrow()
    // execSync must NOT run if unlink threw
    expect(childMock.execSync).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('mDNS announcement stopped'),
    )
  })

  it('warns via the outer guard when existsSync throws unexpectedly', async () => {
    fsMock.existsSync.mockImplementationOnce(() => {
      throw new Error('fs blew up')
    })
    const { stopBonjourAnnouncement } = await loadModule()

    expect(() => stopBonjourAnnouncement()).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error during shutdown'),
      expect.anything(),
    )
  })
})

describe('lifecycle / idempotency', () => {
  it('start → stop → start drives writeFile only once across the cycle', async () => {
    fsMock.state.existing.add('/etc/avahi')
    const { startBonjourAnnouncement, stopBonjourAnnouncement } = await loadModule()

    startBonjourAnnouncement() // writes file
    stopBonjourAnnouncement() // unlinks file
    startBonjourAnnouncement() // writes file again (file is gone)

    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(2)
    expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1)
  })

  it('repeated starts after the file is in place reload avahi each time without rewriting', async () => {
    fsMock.state.existing.add('/etc/avahi')
    fsMock.state.existing.add(SERVICE_FILE)
    const { startBonjourAnnouncement } = await loadModule()

    startBonjourAnnouncement()
    startBonjourAnnouncement()
    startBonjourAnnouncement()

    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
    expect(childMock.execSync).toHaveBeenCalledTimes(3)
  })
})
