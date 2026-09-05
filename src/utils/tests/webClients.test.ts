// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initTRPC, TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { getQueryKey } from '@trpc/react-query'
import { createWebQueryClient, createWebTRPCClient } from '../webClients'
import { transformer } from '../transformer'
import { trpc } from '../trpc'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web clients', () => {
  it('streams a fast result before a slow query in the same HTTP batch completes', async () => {
    const t = initTRPC.create({ transformer })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const timestamp = new Date('2026-09-05T12:00:00Z')
    const router = t.router({
      settings: t.router({ getAll: t.procedure.query(() => ({ timestamp })) }),
      schedules: t.router({ getAll: t.procedure.query(async () => {
        await gate
        throw new TRPCError({ code: 'TIMEOUT', message: 'hardware unavailable' })
      }) }),
    })
    const fetchMock = vi.fn((url: string, init: RequestInit) => fetchRequestHandler({
      endpoint: '/api/trpc', req: new Request(url, init), router, createContext: () => ({}),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createWebTRPCClient()
    let fastResult: unknown
    let slowError: unknown
    const fast = client.settings.getAll.query({}).then((value) => {
      fastResult = value
    })
    const slow = client.schedules.getAll.query({ side: 'left' }).catch((error: unknown) => {
      slowError = error
    })
    try {
      await vi.waitFor(() => {
        expect(fastResult).toEqual({ timestamp })
      })
      expect(slowError).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(fetchMock.mock.calls[0]?.[0]).toContain('settings.getAll,schedules.getAll')
    }
    finally {
      release()
      await Promise.all([fast, slow])
    }
    expect(slowError).toMatchObject({ message: 'hardware unavailable', data: { code: 'TIMEOUT' } })
  })

  it('reuses settings and schedules until invalidated, without caching live status', async () => {
    const client = createWebQueryClient()
    try {
      for (const queryKey of [
        getQueryKey(trpc.settings.getAll, {}, 'query'),
        getQueryKey(trpc.schedules.getAll, { side: 'left' }, 'query'),
      ]) {
        const queryFn = vi.fn(async () => ({ version: 1 }))
        await client.fetchQuery({ queryKey, queryFn })
        await client.fetchQuery({ queryKey, queryFn })
        expect(queryFn).toHaveBeenCalledOnce()
        await client.invalidateQueries({ queryKey })
        await client.fetchQuery({ queryKey, queryFn })
        expect(queryFn).toHaveBeenCalledTimes(2)
      }
      const queryKey = getQueryKey(trpc.device.getStatus, {}, 'query')
      const queryFn = vi.fn(async () => ({}))
      await client.fetchQuery({ queryKey, queryFn })
      await client.fetchQuery({ queryKey, queryFn })
      expect(queryFn).toHaveBeenCalledTimes(2)
    }
    finally {
      client.clear()
    }
  })
})
