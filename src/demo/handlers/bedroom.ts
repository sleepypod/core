import type { DemoHandlers } from '../types'
import { defaultBedroomConfig } from '@/src/bedroom/contract'
import { combineBedroomSensors, bedroomComfortGuidance } from '@/src/bedroom/fusion'

export const bedroom: DemoHandlers<'bedroom'> = {
  status: () => ({ apiVersion: 1, generatedAt: Date.now(), revision: 0, config: defaultBedroomConfig,
    observations: [], aggregates: combineBedroomSensors([], Date.now()), guidance: bedroomComfortGuidance([], Date.now()) }),
  configure: () => { throw new Error('Connect to your Pod to configure bedroom devices.') },
  report: () => { throw new Error('The demo does not accept household measurements.') },
  history: () => ({ apiVersion: 1, generatedAt: Date.now(), items: [], nextBeforeId: null }),
}
