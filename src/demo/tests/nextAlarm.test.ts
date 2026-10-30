import { expect, it } from 'vitest'
import { resolveDemoCall } from '../handlers'
it('does not present demo actions as persisted wake commands', async () => {
  await expect(resolveDemoCall('nextAlarm.get', { side: 'left' })).rejects.toThrow('live, authenticated Pod')
  await expect(resolveDemoCall('nextAlarm.change', { side: 'left', action: 'skip' })).rejects.toThrow('No wake time was changed')
})
