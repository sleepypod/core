import { effectiveLoggingMode } from './recordingPolicy'
import { getRecordingPolicy } from './recordingStore'

const methods = ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const
export function shouldLog(method: typeof methods[number], mode: 'quiet' | 'off' | 'debug'): boolean {
  return mode === 'debug' || (mode === 'quiet' && (method === 'warn' || method === 'error'))
}

/** Filter before console formats/serializes arguments. One wrapper per process. */
export function installAppLogging(): void {
  const shared = globalThis as typeof globalThis & { __recordingLoggingInstalled?: boolean }
  if (shared.__recordingLoggingInstalled) return
  shared.__recordingLoggingInstalled = true
  for (const method of methods) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      try {
        if (shouldLog(method, effectiveLoggingMode(getRecordingPolicy()))) original(...args)
      }
      catch {
        // Keep errors observable if policy storage is damaged, without recursively logging.
        if (method === 'warn' || method === 'error') original(...args)
      }
    }
  }
}
