import { readFile } from 'node:fs/promises'
import { BluezTransport } from './bluez'
import { BaseController } from './controller'

const globalBase = globalThis as typeof globalThis & { __sleepypodBase?: BaseController }
export function getBaseController(): BaseController {
  if (!globalBase.__sleepypodBase) {
    globalBase.__sleepypodBase = new BaseController(new BluezTransport(), async () => {
      const text = await readFile('/persistent/AdjustableBaseConfiguration.json', 'utf8')
      return JSON.parse(text) as unknown
    })
    void globalBase.__sleepypodBase.start()
  }
  return globalBase.__sleepypodBase
}
export function shutdownBaseController(): void {
  globalBase.__sleepypodBase?.shutdown()
}
