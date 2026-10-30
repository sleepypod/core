'use client'

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

/** Keep device queries and streaming components unmounted until the owner has connected. */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'connected' | 'locked' | 'unconfigured' | 'personal'>('checking')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const accountGeneration = useRef(0)
  const personalSessionActive = useRef(false)
  const demo = process.env.NEXT_PUBLIC_DEMO === '1'

  useEffect(() => {
    if (demo) return
    let alive = true
    const refresh = async () => {
      const generation = accountGeneration.current
      try {
        const response = await fetch('/api/auth/session', { cache: 'no-store' })
        if (!response.ok) throw new Error('Controller unavailable')
        const result = await response.json() as { configured: boolean, authenticated: boolean, personalSessionActive?: boolean, personalConnectionRequired?: boolean, privacyAvailable?: boolean }
        if (result.privacyAvailable === false) throw new Error('Privacy state unavailable')
        if (alive && generation === accountGeneration.current) {
          personalSessionActive.current = result.personalSessionActive === true
          setState(result.personalConnectionRequired ? 'personal' : result.authenticated ? 'connected' : result.configured ? 'locked' : 'unconfigured')
        }
      }
      catch {
        if (alive && generation === accountGeneration.current) {
          setState('locked')
          setError('Could not reach the controller. Check your connection.')
        }
      }
    }
    void refresh()
    const personalConnectionChanged = () => {
      accountGeneration.current += 1
      personalSessionActive.current = true
      // Unmount private caches and subscriptions immediately when another tab
      // switches into a personal account; the next focus also rechecks cookies.
      setToken('')
      setState('locked')
      setError('A personal account was opened in this browser. Reconnect explicitly to use owner controls.')
    }
    const changedInStorage = (event: StorageEvent) => {
      if (event.key === 'sleepypod-account-change') personalConnectionChanged()
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sleepypod-account')
    if (channel) channel.onmessage = personalConnectionChanged
    window.addEventListener('storage', changedInStorage)
    const interval = setInterval(() => refresh(), 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('storage', changedInStorage)
      channel?.close()
    }
  }, [demo])

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const generation = accountGeneration.current
    try {
      const currentResponse = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!currentResponse.ok) throw new Error('Could not read the current browser account.')
      const current = await currentResponse.json() as { browserScopeRevision?: string | null, personalConnectionRequired?: boolean }
      if (current.personalConnectionRequired) {
        setState('personal')
        setToken('')
        return
      }
      if (generation !== accountGeneration.current) throw new Error('The browser account changed. Reconnect explicitly.')
      const response = await fetch('/api/auth/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(current.browserScopeRevision ? { 'X-Sleepypod-Browser-Revision': current.browserScopeRevision } : {}) }, body: JSON.stringify({ token, exitPersonalSession: personalSessionActive.current }),
      })
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { code?: string } | null
        if (failure?.code === 'personal_connection_required') {
          setState('personal')
          setToken('')
          return
        }
        throw new Error(response.status === 401 ? 'That connection key was not accepted.' : 'Could not connect to the controller.')
      }
      if (generation !== accountGeneration.current) throw new Error('The browser account changed while connecting. Try again explicitly.')
      setToken('')
      try {
        localStorage.setItem('sleepypod-account-change', `${Date.now()}:owner`)
      }
      catch { /* Cookie/focus checks still apply when storage is unavailable. */ }
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('sleepypod-account')
        channel.postMessage('owner-account-changed')
        channel.close()
      }
      setState('connected')
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Connection failed.') }
    finally { setBusy(false) }
  }

  if (demo || state === 'connected') return children
  return (
    <main className="grid min-h-dvh place-items-center bg-app px-6 text-fg">
      <form onSubmit={connect} className="flex w-full max-w-sm flex-col gap-5 rounded-card border border-line bg-surface p-7">
        <p className="font-mono text-sm text-fg-2">sleepypod</p>
        <h1 className="text-3xl font-medium">Connect to your Pod</h1>
        {state === 'personal' && (
          <>
            <p className="text-fg-2">This bed uses personal accounts to keep each sleeper’s settings and sleep data private. Open your personal workspace to connect.</p>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- This isolated static document must replace the owner React shell, not navigate within it. */}
            <a className="min-h-12 rounded-ctl bg-cool px-5 py-3 text-center font-medium text-inverse" href="/household/index.html">Open my personal workspace</a>
          </>
        )}
        {state === 'checking'
          ? <p role="status" className="text-fg-2">Checking your connection…</p>
          : state === 'personal'
            ? null
            : state === 'unconfigured'
              ? <p className="text-fg-2">This controller needs an owner connection key. Complete controller setup before connecting.</p>
              : (
                  <>
                    <p className="text-fg-2">Enter your Pod connection key. Your browser keeps a private, temporary session.</p>
                    <label className="flex flex-col gap-2">
                      Connection key
                      <input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="current-password" spellCheck={false} required minLength={32} maxLength={4096} className="min-h-12 rounded-ctl border border-line-2 bg-field px-3" />
                    </label>
                    <button disabled={busy} className="min-h-12 rounded-ctl bg-cool px-5 font-medium text-inverse disabled:opacity-60">{busy ? 'Connecting…' : 'Connect to your Pod'}</button>
                  </>
                )}
        {error && <p role="alert" className="text-danger">{error}</p>}
      </form>
    </main>
  )
}
