import type { DemoHandlers } from '../types'

/** Demo calendar curves remain unchanged; no imported bedtime data or live writes are implied. */
export const routines: DemoHandlers<'routines'> = {
  get: ({ side }) => ({ version: 1, side, canCreate: false, routines: [] }),
  replace: () => { throw new Error('Bedtime routine migration requires a connected controller.') },
}
