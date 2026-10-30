import type { DemoHandlers } from '../types'

/** A demo cannot claim to save private entries or derive personal associations. */
function unavailable(): never {
  throw new Error('The morning journal requires a live, authenticated Pod. No entry was read or saved in this demo.')
}
export const journal: DemoHandlers<'journal'> = { get: unavailable, save: unavailable }
