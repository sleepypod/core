import { sqlite } from '@/src/db'
import { createRoomContextStore } from './store'
import { getBedroom } from '@/src/bedroom/instance'
const globals = globalThis as typeof globalThis & { __sp_roomContext?: ReturnType<typeof createRoomContextStore> }
export function getRoomContext() {
  return globals.__sp_roomContext ??= createRoomContextStore(sqlite)
}
export function getRoomContextIfRunning() {
  return globals.__sp_roomContext ?? null
}
export class RoomSignalReader {
  read() {
    try {
      const bedroom = getBedroom()
      // Once selected, the combined sources own room input. Missing data must
      // not silently fall back to an older single-source publisher.
      return bedroom.configuration().config.enabled ? bedroom.signals() : getRoomContext().signals()
    }
    catch { return {} }
  }
}
