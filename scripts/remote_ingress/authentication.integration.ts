import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as nodeRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import type Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { HouseholdStore } from '@/src/household/store'
import { householdHttp } from '@/src/household/http'
import { proxy } from '@/proxy'
import { GET as connectionIdentity } from '@/app/api/v1/connection/route'
import { GET as ownerStatus, POST as ownerLogin, DELETE as ownerLogout } from '@/app/api/auth/session/route'

// Only the storage location is substituted. Authorization, account/session
// handling, identity persistence and Host/Origin checks are the production code.
const storage = vi.hoisted(() => ({ database: null as Database.Database | null }))
vi.mock('@/src/db', () => ({
  get sqlite() {
    return storage.database
  },
}))
const host = 'sleep.example.com'
const secret = () => randomBytes(32).toString('base64url')
let directory: string, fixtureDirectory: string, origin: Server, nginx: ChildProcess
let proxyPort: number, database: Database.Database, identities: HouseholdStore
let ownerToken: string, ownerPerson: string, memberPerson: string
let originCalls: number

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener')
  return address.port
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

/** Test transport only: dispatch real handlers without starting Core instrumentation or hardware. */
function fixtureOrigin() {
  return createServer(async (incoming, outgoing) => {
    try {
      originCalls += 1
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString('utf8')
      const headers = new Headers()
      for (let index = 0; index < incoming.rawHeaders.length; index += 2)
        headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
      const request = new NextRequest(`https://${headers.get('host')}${incoming.url}`, {
        method: incoming.method, headers, ...(body ? { body } : {}),
      })
      const path = request.nextUrl.pathname
      let response: Response | undefined = proxy(request)
      if (!response) {
        if (path === '/api/v1/connection') response = await connectionIdentity(request)
        else if (path === '/api/auth/session') {
          response = request.method === 'POST'
            ? await ownerLogin(request)
            : request.method === 'DELETE' ? ownerLogout(request) : ownerStatus(request)
        }
        else if (path.startsWith('/api/v1/household/') || path.startsWith('/api/v1/me/')) {
          response = await householdHttp(request, { store: identities, verifySoloConfiguration: () => true })
        }
        else response = new Response(null, { status: 404 })
      }
      outgoing.statusCode = response.status
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') outgoing.setHeader(name, value)
      })
      const cookies = response.headers.getSetCookie()
      if (cookies.length) outgoing.setHeader('Set-Cookie', cookies)
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    }
    catch {
      outgoing.statusCode = 500
      outgoing.end('Test handler failed')
    }
  })
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-real-auth-ingress-'))
  origin = fixtureOrigin()
  const originPort = await listen(origin)
  const reservation = createServer()
  proxyPort = await listen(reservation)
  await close(reservation)
  const bundle = join(directory, 'ingress')
  execFileSync('python3', ['scripts/remote_ingress/render.py', '--public-host', host,
    '--pod-address', '127.0.0.1', '--pod-port', String(originPort), '--listen-port', String(proxyPort), '--output', bundle])
  const executable = process.env.NGINX_BIN || execFileSync('which', ['nginx'], { encoding: 'utf8' }).trim()
  const argumentsList = ['-p', bundle + '/', '-c', join(bundle, 'nginx.conf')]
  execFileSync(executable, [...argumentsList, '-t'], { stdio: 'pipe' })
  nginx = spawn(executable, [...argumentsList, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let startupError = ''
  nginx.stderr?.on('data', (value) => {
    startupError = (startupError + String(value)).slice(-2000)
  })
  await vi.waitFor(async () => {
    if (nginx.exitCode !== null) throw new Error(startupError || 'Nginx exited')
    const response = await fetch(`http://127.0.0.1:${proxyPort}/`, { headers: { Host: 'unreviewed.invalid' } })
    expect(response.status).toBe(421)
    await response.text()
  }, { timeout: 5000, interval: 25 })
})
afterAll(async () => {
  if (nginx && nginx.exitCode === null) {
    await new Promise<void>((resolve) => {
      nginx.once('exit', () => resolve())
      nginx.kill('SIGTERM')
    })
  }
  if (origin?.listening) await close(origin)
  if (directory) rmSync(directory, { recursive: true, force: true })
})
beforeEach(() => {
  fixtureDirectory = mkdtempSync(join(directory, 'account-'))
  const filename = join(fixtureDirectory, 'isolated.db')
  database = migratedComfortDatabase(filename)
  storage.database = database
  identities = new HouseholdStore(database)
  ownerToken = secret()
  ownerPerson = secret()
  memberPerson = secret()
  originCalls = 0
  vi.stubEnv('DATABASE_URL', filename)
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', ownerToken)
  vi.stubEnv('SLEEPYPOD_ALLOWED_HOSTS', host)
  vi.stubEnv('SLEEPYPOD_HOUSEHOLD_PREPARATION', '1')
  vi.stubEnv('NEXT_PUBLIC_DEMO', '')
  identities.setup({ requestId: randomUUID(), displayName: 'Fixture owner', deviceName: 'Fixture phone', deviceSecret: ownerPerson,
    currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const invitation = identities.createInvitation(ownerPerson, { requestId: randomUUID(), expectedSessionRevision: 1,
    expectedAssignmentRevision: 1, kind: 'new_person', invitation: secret(), expiresInMinutes: 30 })
  identities.join({ invitation: invitation.invitation, displayName: 'Fixture partner', deviceName: 'Other fixture phone', deviceSecret: memberPerson })
})
afterEach(() => {
  database?.close()
  storage.database = null
  vi.unstubAllEnvs()
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true })
})
async function request(path: string, options: { method?: string, token?: string, cookie?: string, body?: unknown, headers?: Record<string, string> } = {}) {
  // Node's fetch normalizes Host to its URL. The connector deliberately sends
  // the public Host to loopback, so exercise those actual wire headers here.
  const payload = options.body ? JSON.stringify(options.body) : undefined
  const response = await new Promise<Response>((resolve, reject) => {
    const outgoing = nodeRequest({ hostname: '127.0.0.1', port: proxyPort, path, method: options.method ?? 'GET',
      headers: { Host: host, ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...options.headers },
    }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('error', reject)
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
      incoming.on('end', () => {
        const headers = new Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2)
          headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
        resolve(new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers }))
      })
    })
    outgoing.on('error', reject)
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Local ingress test request timed out')))
    outgoing.end(payload)
  })
  const text = await response.text()
  return { response, text, json: () => JSON.parse(text) }
}
function cookieJar(response: Response, previous = '') {
  const values = new Map(previous.split('; ').filter(Boolean).map((value) => {
    const separator = value.indexOf('=')
    return [value.slice(0, separator), value.slice(separator + 1)]
  }))
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';')
    const separator = pair.indexOf('=')
    if (pair.slice(separator + 1)) values.set(pair.slice(0, separator), pair.slice(separator + 1))
    else values.delete(pair.slice(0, separator))
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join('; ')
}

describe('Core authorization through the rendered ingress', () => {
  it('requires the exact configured hostname without disabling Core host checks', async () => {
    vi.stubEnv('SLEEPYPOD_ALLOWED_HOSTS', 'another.example.com')
    const denied = await request('/api/v1/connection?challenge=' + secret(), { token: ownerToken })
    expect(denied.response.status).toBe(403)
    expect(denied.text).toContain('Host not allowed')
    vi.stubEnv('SLEEPYPOD_ALLOWED_HOSTS', `another.example.com,${host}`)
    expect((await request('/api/v1/connection?challenge=' + secret(), { token: ownerToken })).response.status).toBe(200)
  })

  it('protects fresh owner enrollment and never treats personal credentials as owner credentials', async () => {
    for (const token of [undefined, 'incorrect', ownerPerson, memberPerson]) {
      const denied = await request('/api/v1/connection?challenge=' + secret(), { token })
      expect(denied.response.status).toBe(401)
      expect(denied.text).not.toContain('installationId')
    }
    const identitiesSeen = new Set<string>()
    for (const challenge of [secret(), secret()]) {
      const result = await request('/api/v1/connection?challenge=' + challenge, { token: ownerToken })
      expect(result.response.status).toBe(200)
      expect(result.json()).toMatchObject({ controller: 'sleepypod-core', challenge })
      expect(result.response.headers.get('cache-control')).toBe('private, no-store')
      identitiesSeen.add(result.json().installationId)
    }
    expect(identitiesSeen.size).toBe(1)
  })

  it('keeps both personal accounts and their challenge responses separate', async () => {
    for (const token of [ownerPerson, memberPerson]) {
      const challenge = secret()
      const result = await request('/api/v1/household/session?challenge=' + challenge, { token })
      expect(result.response.status).toBe(200)
      expect(result.response.headers.get('x-sleepypod-connection-challenge')).toBe(challenge)
      expect(result.json().accountId).toBe(identities.session(token).accountId)
      const preferences = await request('/api/v1/me/preferences', { token })
      expect(preferences.response.status).toBe(200)
      expect(preferences.json().sleeperId).toBe(identities.session(token).selfSleeperId)
    }
    for (const token of [undefined, ownerToken, secret()])
      expect((await request('/api/v1/household/session?challenge=' + secret(), { token })).response.status).toBe(401)
  })

  it('preserves secure browser cookies and rejects a stale owner tab after personal sign-in', async () => {
    const login = await request('/api/auth/session', { method: 'POST', body: { token: ownerToken }, headers: { Origin: `https://${host}` } })
    expect(login.response.status).toBe(200)
    expect(login.response.headers.getSetCookie()).toHaveLength(2)
    for (const cookie of login.response.headers.getSetCookie()) expect(cookie.toLowerCase()).toContain('secure')
    const ownerCookies = cookieJar(login.response)
    expect((await request('/api/v1/connection?challenge=' + secret(), { cookie: ownerCookies })).response.status).toBe(200)
    const status = await request('/api/auth/session', { cookie: ownerCookies })
    const personal = await request('/api/v1/household/session', { method: 'POST', cookie: ownerCookies,
      body: { token: memberPerson }, headers: { 'Origin': `https://${host}`, 'X-Sleepypod-Browser-Revision': status.json().browserScopeRevision } })
    expect(personal.response.status).toBe(200)
    const personalCookies = cookieJar(personal.response, ownerCookies)
    expect((await request('/api/v1/me/preferences', { cookie: personalCookies })).json().sleeperId).toBe(identities.session(memberPerson).selfSleeperId)
    expect((await request('/api/v1/connection?challenge=' + secret(), { cookie: ownerCookies })).response.status).toBe(401)
    const saved = identities.preferences(memberPerson)
    const session = identities.session(memberPerson)
    const staleEditor = await request('/api/v1/me/preferences', { method: 'PUT', cookie: personalCookies,
      headers: { 'Origin': `https://${host}`, 'X-Sleepypod-Sleeper-Id': identities.session(ownerPerson).selfSleeperId },
      body: { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision,
        expectedRevision: saved.revision, preferences: { ...saved.preferences, preferredTemperatureF: 75 } } })
    expect(staleEditor.response.status).toBe(409)
    expect(identities.preferences(memberPerson)).toEqual(saved)
    const freshEditor = await request('/api/v1/me/preferences', { method: 'PUT', cookie: personalCookies,
      headers: { 'Origin': `https://${host}`, 'X-Sleepypod-Sleeper-Id': session.selfSleeperId },
      body: { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision,
        expectedRevision: saved.revision, preferences: { ...saved.preferences, preferredTemperatureF: 75 } } })
    expect(freshEditor.response.status).toBe(200)
    expect(identities.preferences(memberPerson).preferences.preferredTemperatureF).toBe(75)
    const currentBrowser = await request('/api/auth/session', { cookie: personalCookies })
    const logout = await request('/api/v1/household/session', { method: 'DELETE', cookie: personalCookies,
      headers: { 'Origin': `https://${host}`, 'X-Sleepypod-Browser-Revision': currentBrowser.json().browserScopeRevision } })
    expect(logout.response.status).toBe(204)
    expect((await request('/api/v1/me/preferences', { cookie: personalCookies })).response.status).toBe(401)
  })

  it('does not provide owner access when controller authentication is unconfigured', async () => {
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', '')
    const response = await request('/api/v1/connection?challenge=' + secret(), { token: ownerToken })
    expect(response.response.status).toBe(503)
    expect(response.text).not.toContain('installationId')
  })

  it('withdraws personal access immediately after credential revocation', async () => {
    expect((await request('/api/v1/me/preferences', { token: memberPerson })).response.status).toBe(200)
    database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ?').run(Date.now(), identities.deviceIdentity(memberPerson))
    expect((await request('/api/v1/me/preferences', { token: memberPerson })).response.status).toBe(401)
    expect((await request('/api/v1/me/preferences', { token: ownerPerson })).response.status).toBe(200)
  })

  it('preserves the personal privacy boundary even for a valid installation owner key', async () => {
    database.prepare('INSERT INTO household_privacy_boundary VALUES (1, ?, ?)').run(Date.now(), 'isolated integration fixture')
    expect((await request('/api/v1/connection?challenge=' + secret(), { token: ownerToken })).response.status).toBe(403)
    expect((await request('/api/v1/me/preferences', { token: memberPerson })).response.status).toBe(200)
  })

  it('rejects a foreign browser origin before any Core handler is invoked', async () => {
    const before = originCalls
    const denied = await request('/api/auth/session', { method: 'POST', body: { token: ownerToken }, headers: { Origin: 'https://foreign.example' } })
    expect(denied.response.status).toBe(403)
    expect(originCalls).toBe(before)
  })
})
