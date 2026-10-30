import { dirname, resolve } from 'node:path'
import { test as base, expect } from '@playwright/test'
import { issueSession, SESSION_COOKIE, SESSION_SECONDS } from '../../src/auth/access'
import { bindBrowserScope, BROWSER_SCOPE_COOKIE } from '../../src/auth/browserScope'

// Each test owns its browser scope. Logging out in one test must not invalidate
// the initial session of a different test that happens to run afterward.
export const test = base.extend({
  storageState: async ({ baseURL }, provideState) => {
    const root = process.env.SLEEPYPOD_BROWSER_FIXTURE
    const database = process.env.DATABASE_URL?.replace(/^file:/, '')
    if (!root || !database || dirname(resolve(database)) !== resolve(root)) throw new Error('Isolated browser database required')
    const session = issueSession(Date.now(), true)
    const scope = bindBrowserScope(new Request(baseURL ?? 'http://127.0.0.1:3218'), 'owner', session).split(';')[0].slice(BROWSER_SCOPE_COOKIE.length + 1)
    const cookie = { domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Strict' as const, expires: Math.floor(Date.now() / 1000) + SESSION_SECONDS }
    await provideState({ cookies: [{ ...cookie, name: SESSION_COOKIE, value: session }, { ...cookie, name: BROWSER_SCOPE_COOKIE, value: scope }], origins: [] })
  },
})
export { expect }
export type { Page } from '@playwright/test'
