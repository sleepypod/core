import { expect, it } from 'vitest'
import { resolveDemoCall } from '../handlers'

it('never invents a private journal or successful save in demo mode', async () => {
  await expect(resolveDemoCall('journal.get', { side: 'left' })).rejects.toThrow('live, authenticated Pod')
  await expect(resolveDemoCall('journal.save', { side: 'left', date: '2026-10-24', expectedRevision: null, fields: null })).rejects.toThrow('No entry was read or saved')
})
