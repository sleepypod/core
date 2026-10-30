'use client'

import { useState } from 'react'

export function OwnerSessionControls() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (process.env.NEXT_PUBLIC_DEMO === '1') return null

  async function disconnect() {
    setBusy(true)
    setError('')
    try {
      const currentResponse = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!currentResponse.ok) throw new Error('Could not read this browser session. Try again.')
      const current = await currentResponse.json() as { browserScopeRevision?: string | null }
      const response = await fetch('/api/auth/session', { method: 'DELETE', headers: current.browserScopeRevision ? { 'X-Sleepypod-Browser-Revision': current.browserScopeRevision } : {} })
      if (!response.ok) throw new Error('Could not end this browser session. Try again.')
      try {
        localStorage.setItem('sleepypod-account-change', `${Date.now()}:signed-out`)
      }
      catch { /* Other tabs also recheck authorization when focused. */ }
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('sleepypod-account')
        channel.postMessage('signed-out')
        channel.close()
      }
      // A full reload discards private query caches and closes live subscriptions.
      window.location.reload()
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not disconnect.')
      setBusy(false)
    }
  }

  return (
    <section className="rounded-card border border-line bg-surface p-6">
      <h2 className="text-lg font-medium">Browser connection</h2>
      <p className="mt-2 text-sm text-fg-2">End this browser session. Your Pod continues its local routines.</p>
      <button type="button" disabled={busy} onClick={disconnect} className="mt-4 min-h-11 rounded-ctl border border-line px-4 disabled:opacity-60">
        {busy ? 'Disconnecting…' : 'Disconnect this browser'}
      </button>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  )
}
