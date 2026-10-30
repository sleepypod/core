import { sqlite } from '@/src/db'
import { createBedroomStore } from './store'

const globals = globalThis as typeof globalThis & { __sp_bedroom?: ReturnType<typeof createBedroomStore> }
export function getBedroom() {
  return globals.__sp_bedroom ??= createBedroomStore(sqlite)
}

export function getBedroomIfRunning() {
  return globals.__sp_bedroom ?? null
}
