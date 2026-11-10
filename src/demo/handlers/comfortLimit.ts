import type { DemoHandlers } from '../types'

function unavailable(): never {
  throw new Error('Comfort limits require a live, authenticated Pod. This demo cannot change automatic temperatures.')
}
export const comfortLimit: DemoHandlers<'comfortLimit'> = { get: unavailable, configure: unavailable }
