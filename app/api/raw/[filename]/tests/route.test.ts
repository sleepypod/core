// @vitest-environment node
import { ownerRequest, TEST_OWNER_TOKEN } from '@/src/auth/tests/support'
import { Readable } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import { GET } from '../route'
const fs = vi.hoisted(() => ({ lstat: vi.fn(), realpath: vi.fn(), stat: vi.fn(), createReadStream: vi.fn() }))
vi.mock('node:fs/promises', () => ({ lstat: fs.lstat, realpath: fs.realpath, stat: fs.stat }))
vi.mock('node:fs', () => ({ createReadStream: fs.createReadStream }))
const request = (filename = 'capture.RAW') => GET(ownerRequest('http://localhost/api/raw/' + filename), { params: Promise.resolve({ filename }) })
beforeEach(() => {
  vi.resetAllMocks()
  fs.lstat.mockResolvedValue({ isSymbolicLink: () => false })
  fs.realpath.mockImplementation(async (path: string) => path)
  fs.stat.mockResolvedValue({ size: 3 })
  fs.createReadStream.mockImplementation(() => Readable.from([Buffer.from([1, 2, 3])]))
})
it('streams the original bytes with explicit download metadata', async () => {
  const response = await request()
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
  expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="capture.RAW"')
  expect(response.headers.get('Content-Length')).toBe('3')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
})
it('withholds RAW bytes after the connection key changes during filesystem inspection', async () => {
  fs.stat.mockImplementationOnce(async () => {
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN + '-rotated')
    return { size: 3 }
  })
  const response = await request()
  expect(response.status).toBe(401)
  expect(response.headers.get('Content-Disposition')).toBeNull()
  expect(await response.text()).not.toContain('capture.RAW')
})
it.each(['../private.RAW', 'nested/capture.RAW', 'capture.txt', 'capture.RAW\n'])('rejects invalid filename %s before filesystem access', async (filename) => {
  expect((await request(filename)).status).toBe(400)
  expect(fs.lstat).not.toHaveBeenCalled()
  expect(fs.createReadStream).not.toHaveBeenCalled()
})
it('refuses symbolic links and canonical paths outside the configured directory', async () => {
  fs.lstat.mockResolvedValueOnce({ isSymbolicLink: () => true })
  expect((await request()).status).toBe(400)
  expect(fs.realpath).not.toHaveBeenCalled()
  fs.realpath.mockResolvedValueOnce('/outside/capture.RAW').mockResolvedValueOnce('/owned')
  expect((await request()).status).toBe(400)
  expect(fs.createReadStream).not.toHaveBeenCalled()
})
it.each([['ENOENT', 404, 'File not found'], ['EACCES', 500, 'Failed to read file']] as const)('sanitizes %s filesystem failures', async (code, status, error) => {
  fs.lstat.mockRejectedValue(Object.assign(new Error('/private/source'), { code }))
  const response = await request()
  expect(response.status).toBe(status)
  expect(await response.json()).toEqual({ error })
  expect(fs.createReadStream).not.toHaveBeenCalled()
})
