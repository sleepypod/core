import { Characteristic, type Service } from 'hap-nodejs'

interface FaultSources { readers: Map<symbol, () => boolean>, published: number | null }
const globals = globalThis as typeof globalThis & { __sp_homekitFaults?: WeakMap<Service, FaultSources> }
const sources = globals.__sp_homekitFaults ??= new WeakMap<Service, FaultSources>()

/** Independent sensor and pump faults share one characteristic without clearing each other. */
export function registerServiceFault(service: Service, read: () => boolean) {
  let state = sources.get(service)
  if (!state) {
    state = { readers: new Map(), published: null }
    sources.set(service, state)
    if (!service.testCharacteristic(Characteristic.StatusFault)) service.addCharacteristic(Characteristic.StatusFault)
    service.getCharacteristic(Characteristic.StatusFault).onGet(() => combinedFault(service))
  }
  const identity = Symbol('fault-source')
  state.readers.set(identity, read)
  let stopped = false
  const refresh = () => {
    if (stopped) return
    const next = combinedFault(service)
    if (state.published === next) return
    state.published = next
    service.updateCharacteristic(Characteristic.StatusFault, next)
  }
  refresh()
  return { refresh, stop() {
    stopped = true
    state.readers.delete(identity)
  } }
}

function combinedFault(service: Service): number {
  for (const read of sources.get(service)?.readers.values() ?? []) {
    try {
      if (read()) return Characteristic.StatusFault.GENERAL_FAULT
    }
    catch { return Characteristic.StatusFault.GENERAL_FAULT }
  }
  return Characteristic.StatusFault.NO_FAULT
}
