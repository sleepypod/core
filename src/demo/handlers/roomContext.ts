import type { DemoHandlers } from '../types'
import { defaultRoomConfig } from '@/src/home-context/contract'
export const roomContext: DemoHandlers<'roomContext'> = {
  status: () => ({ apiVersion: 1, generatedAt: Date.now(), revision: 0, config: defaultRoomConfig, connected: false, topic: null, observations: [] }),
  configure: () => { throw new Error('Connect to your Pod to map real sensors.') },
  history: () => ({ apiVersion: 1, generatedAt: Date.now(), items: [], nextBeforeId: null }),
  publisher: () => ({ revision: 0, automations: [] }),
}
