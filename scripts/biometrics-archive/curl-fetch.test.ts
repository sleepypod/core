// @vitest-environment node
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { curlFetch } from './curl-fetch'

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/stream') {
      response.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Length': '8' })
      response.write('abcd')
      setTimeout(() => response.end('efgh'), 20)
    }
    else if (request.url === '/busy') {
      response.writeHead(429, { 'Retry-After': '7', 'Content-Type': 'application/json' })
      response.end('{"error":"busy"}')
    }
    else if (request.url === '/cut') {
      response.writeHead(200, { 'Content-Length': '100' })
      response.write('partial')
      setTimeout(() => response.destroy(), 20)
    }
    else {
      response.writeHead(200, { 'Transfer-Encoding': 'chunked' })
      response.end('\r\n\r\nbody keeps its blank lines')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

describe('curlFetch', () => {
  it('streams status, headers and body', async () => {
    const response = await curlFetch()(`${base}/stream`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('8')
    expect(await response.text()).toBe('abcdefgh')
  })

  it('passes error statuses and Retry-After through', async () => {
    const response = await curlFetch()(`${base}/busy`)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('7')
    expect(await response.json()).toEqual({ error: 'busy' })
  })

  it('splits the head from a body that starts with a blank line', async () => {
    expect(await (await curlFetch()(`${base}/chunked`)).text()).toBe('\r\n\r\nbody keeps its blank lines')
  })

  it('fails the body when the connection drops mid-download', async () => {
    const response = await curlFetch()(`${base}/cut`)
    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  it('rejects like fetch when the host cannot be reached', async () => {
    await expect(curlFetch()('http://127.0.0.1:1/')).rejects.toMatchObject({ name: 'TypeError', cause: expect.objectContaining({ message: expect.stringContaining('curl') }) })
  })
})
