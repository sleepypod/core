import { beforeEach, describe, expect, it, vi } from 'vitest'
const read = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', () => ({ readFile: read, default: { readFile: read } }))
import { isBaseConfigured, readBaseConfiguration } from '../configuration'
beforeEach(() => read.mockReset())
describe('base configuration discovery', () => {
  it('recognizes a configured base without depending on a live connection', async () => {
    read.mockResolvedValue(JSON.stringify({ Address: 'aa:bb:cc:dd:ee:ff', SplitBase: false }))
    expect(await isBaseConfigured()).toBe(true)
    expect(await readBaseConfiguration()).toEqual({ Address: 'AA:BB:CC:DD:EE:FF', SplitBase: false })
    expect(read).toHaveBeenCalledWith('/persistent/AdjustableBaseConfiguration.json', 'utf8')
  })
  it.each(['{}', 'not json', '{"Address":"bad","SplitBase":true}', '{"Address":"aa:bb:cc:dd:ee:ff"}'])('hides Base for invalid config %s', async (value) => {
    read.mockResolvedValue(value)
    expect(await isBaseConfigured()).toBe(false)
  })
  it('handles missing configuration and notices setup on a later check', async () => {
    read.mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValueOnce('{"Address":"AA:BB:CC:DD:EE:FF","SplitBase":true}')
    expect(await isBaseConfigured()).toBe(false)
    expect(await isBaseConfigured()).toBe(true)
  })
})
