import type DatabaseConstructor from 'better-sqlite3'
// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ownerRequest } from '@/src/auth/tests/support'

const state = vi.hoisted(() => ({
  restricted: false,
  backup: vi.fn(async () => {}),
  spawn: vi.fn(),
  remove: vi.fn(async () => {}),
}))
vi.mock('@/src/household/privacy', () => ({ householdBackupRestricted: () => state.restricted }))
vi.mock('@/src/lib/dbInspect', () => ({ DB_FILES: { sleepypod: { path: '/fixture/config.db' } }, backupMarkerPath: () => '/fixture/marker' }))
vi.mock('better-sqlite3', async () => {
  const { default: ActualDatabase } = await vi.importActual<{ default: typeof DatabaseConstructor }>('better-sqlite3')
  return { default: function (this: { backup: typeof state.backup, close: () => void }, path: string, options?: { fileMustExist?: boolean }) {
    if (options?.fileMustExist && path === process.env.DATABASE_URL) return new ActualDatabase(path, options)
    this.backup = state.backup
    this.close = () => {}
  } }
})
vi.mock('node:child_process', () => ({ spawn: state.spawn }))
vi.mock('node:fs/promises', () => ({ mkdir: async () => {}, mkdtemp: async () => '/fixture/staging', rm: state.remove, writeFile: async () => {} }))

let child: EventEmitter & { stdout: PassThrough, stderr: PassThrough, kill: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state.restricted = false
  state.backup.mockImplementation(async () => {})
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
  state.spawn.mockReturnValue(child)
})
afterEach(() => {
  child.emit('close', 1)
  child.stdout.destroy()
  child.stderr.destroy()
  vi.unstubAllEnvs()
})

it('withholds a backup if personal household protection is enabled during its snapshot', async () => {
  state.backup.mockImplementationOnce(async () => {
    state.restricted = true
  })
  const { GET } = await import('./route')
  const response = await GET(ownerRequest('http://pod/api/db-backup'))
  expect(response.status).toBe(403)
  expect(response.headers.get('Content-Disposition')).toBeNull()
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  expect(state.remove).toHaveBeenCalledWith('/fixture/staging', { recursive: true, force: true })
})

it('cancels a running backup when protection changes before the next output chunk', async () => {
  const { GET } = await import('./route')
  const response = await GET(ownerRequest('http://pod/api/db-backup'))
  expect(response.status).toBe(200)
  const pending = response.arrayBuffer()
  state.restricted = true
  child.stdout.write(Buffer.from('private database bytes'))
  await expect(pending).rejects.toThrow('access changed')
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  expect(state.remove).toHaveBeenCalledWith('/fixture/staging', { recursive: true, force: true })
})

it('does not release a newer backup when the canceled producer later exits', async () => {
  const { GET } = await import('./route')
  const first = await GET(ownerRequest('http://pod/api/db-backup'))
  await first.body?.cancel()
  const oldChild = child
  const nextChild = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
  state.spawn.mockReturnValue(nextChild)
  const next = await GET(ownerRequest('http://pod/api/db-backup'))
  expect(next.status).toBe(200)
  oldChild.emit('close', 1)
  try {
    expect((await GET(ownerRequest('http://pod/api/db-backup'))).status).toBe(429)
  }
  finally {
    await next.body?.cancel()
    nextChild.emit('close', 1)
    nextChild.stdout.destroy()
    nextChild.stderr.destroy()
  }
})
