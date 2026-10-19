// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ policy: vi.fn() }))
vi.mock('../recordingStore', () => ({ getRecordingPolicy: mock.policy }))
import { installAppLogging } from '../appLogging'
const methods = ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const
const originals = Object.fromEntries(methods.map(method => [method, console[method]]))
afterEach(() => {
  for (const method of methods) console[method] = originals[method]
  delete (globalThis as typeof globalThis & { __recordingLoggingInstalled?: boolean }).__recordingLoggingInstalled
  vi.useRealTimers()
})
it('filters actual console output, switches modes, expires debug and installs only once', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const output = Object.fromEntries(methods.map(method => [method, vi.fn()]))
  for (const method of methods) console[method] = output[method]
  mock.policy.mockReturnValue({ loggingMode: 'quiet', debugUntil: null })
  installAppLogging()
  const wrapped = console.info
  installAppLogging()
  expect(console.info).toBe(wrapped)
  console.info('routine')
  console.warn('warning')
  expect(output.info).not.toHaveBeenCalled()
  expect(output.warn).toHaveBeenCalledWith('warning')
  mock.policy.mockReturnValue({ loggingMode: 'off', debugUntil: 2000 })
  console.debug('detail')
  expect(output.debug).toHaveBeenCalledWith('detail')
  vi.setSystemTime(2000)
  console.error('discarded')
  expect(output.error).not.toHaveBeenCalled()
})
