import { createRequire } from 'node:module'
import { join } from 'node:path'

export interface DiscoveryService {
  advertise: () => Promise<void>
  destroy: () => Promise<void>
}
export interface DiscoveryResponder {
  createService: (options: {
    name: string
    type: string
    hostname: string
    port: number
    txt: Record<string, string>
  }) => DiscoveryService
  shutdown: () => Promise<void>
}
interface CiaoModule {
  getResponder: () => DiscoveryResponder
}

/** Reuse HomeKit's exact locked ciao instance, including its responder reference count. */
export function loadDiscoveryResponder(): CiaoModule {
  const applicationRequire = createRequire(join(process.cwd(), 'package.json'))
  const homeKitRequire = createRequire(applicationRequire.resolve('hap-nodejs'))
  return homeKitRequire('@homebridge/ciao') as CiaoModule
}
