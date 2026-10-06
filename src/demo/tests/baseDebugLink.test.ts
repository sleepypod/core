import { createTRPCClient, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { describe, expect, it, vi } from 'vitest'
import type { AppRouter } from '@/src/server/routers/app'
import { baseDebugLink } from '../baseDebugLink'

function setup() {
  const network = vi.fn()
  const terminal: TRPCLink<AppRouter> = () => ({ op }) => observable((observer) => {
    network(op.path)
    observer.next({ result: { type: 'data', data: { real: true } } })
    observer.complete()
  })
  return { network, client: createTRPCClient<AppRouter>({ links: [baseDebugLink(), terminal] }) }
}
describe('base debug transport isolation', () => {
  it('simulates every base read/write and allows ordinary non-base requests through', async () => {
    const { client, network } = setup()
    expect(await client.base.getAvailability.query({})).toEqual({ configured: true })
    expect(await client.base.getStatus.query({})).toMatchObject({ independentControl: false, state: 'connected' })
    await expect(client.base.setPosition.mutate({ head: 40, feet: 0, sides: ['left'], feedRate: 75 })).rejects.toThrow('whole-bed movement only')
    await client.base.setPosition.mutate({ head: 40, feet: 0, feedRate: 75 })
    await client.base.setPreset.mutate({ preset: 'sleep' })
    await client.base.stop.mutate({})
    await client.base.reconnect.mutate({})
    await expect(client.base.saveSchedule.mutate({ head: 1, feet: 5, side: 'right', dayOfWeek: 'weekdays', time: '22:00', presetName: 'Sleep', enabled: true })).rejects.toThrow('whole-bed movement only')
    const row = await client.base.saveSchedule.mutate({ head: 1, feet: 5, dayOfWeek: 'weekdays', time: '22:00', presetName: 'Sleep', enabled: true })
    expect(await client.base.getSchedules.query({})).toEqual([row])
    await client.base.deleteSchedule.mutate({ id: row.id })
    expect(await client.base.getSchedules.query({})).toEqual([])
    expect(network).not.toHaveBeenCalled()
    expect(await client.settings.getAll.query({})).toEqual({ real: true })
    expect(network).toHaveBeenCalledExactlyOnceWith('settings.getAll')
  })
  it('keeps separate simulator sessions from sharing schedules or motion', async () => {
    const first = setup().client
    const second = setup().client
    await first.base.setPosition.mutate({ head: 40, feet: 0 })
    await first.base.saveSchedule.mutate({ head: 0, feet: 0, dayOfWeek: 'daily', time: '22:00', enabled: true })
    expect(await second.base.getSchedules.query({})).toEqual([])
    expect(await second.base.getStatus.query({})).toMatchObject({ moving: false })
  })
  it('fails closed for an unknown base procedure rather than passing it to hardware', async () => {
    const next = vi.fn()
    const error = vi.fn()
    const link = baseDebugLink()({} as never)
    link({ op: { path: 'base.futureCommand', input: {}, type: 'mutation' }, next } as never).subscribe({ error })
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Not available in base debug') }))
    expect(next).not.toHaveBeenCalled()
  })
})
