import { describe, expect, it, vi } from 'vitest'

vi.mock('@/src/server/routers/app', () => ({
  appRouter: { createCaller: () => ({}) },
}))

import { POST } from '@/app/api/mcp/route'

function rpc(body: unknown): Request {
  return new Request('http://pod.local/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/mcp', () => {
  it('answers initialize with a JSON body and no session header (stateless)', async () => {
    const res = await POST(rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('mcp-session-id')).toBeNull()
    const body = await res.json()
    expect(body.result.serverInfo.name).toBe('sleepypod')
    expect(body.result.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} })
  })

  it('lists tools without a prior initialize on the same connection', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result.tools.length).toBeGreaterThan(10)
  })
})
