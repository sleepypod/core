import { readBaseConfiguration } from './configuration'
import { BluezTransport } from './bluez'
import { BaseController } from './controller'

const globalBase = globalThis as typeof globalThis & { __sleepypodBase?: BaseController }
/** Observe an existing controller without creating a Bluetooth connection. */
export function getBaseControllerIfRunning(): BaseController | null {
  return globalBase.__sleepypodBase ?? null
}
export function getBaseController(): BaseController {
  if (!globalBase.__sleepypodBase) {
    globalBase.__sleepypodBase = new BaseController(new BluezTransport(), readBaseConfiguration)
    void globalBase.__sleepypodBase.start()
  }
  return globalBase.__sleepypodBase
}
export function shutdownBaseController(): void {
  globalBase.__sleepypodBase?.shutdown()
}
