'use client'

import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { RemotePanel, useRemoteMapping } from './RemotePanel'
import { RemoteCapture } from './RemoteCapture'

/** Keep mapping and selected-side state while switching to live remote capture. */
export function RemoteConsole() {
  const mapping = useRemoteMapping()
  const status = trpc.remote.status.useQuery({}, { refetchInterval: 3000 })
  const availability = !status.data || status.error ? 'unconfirmed' : !status.data.running ? 'offline' : status.data.lastDetectionAt !== null ? 'detected' : 'unconfirmed'
  const [side, setSide] = useState<'left' | 'right'>('left')
  const [screen, setScreen] = useState<'mapping' | 'capture'>('mapping')
  // Automations are optional binding targets; their engine state does not gate Remote.
  const automations = trpc.automations.list.useQuery({})

  return (
    <div className="w-full min-w-0 text-zinc-100" style={{ ['--accent' as string]: '#0c87c2' }}>
      <div className="mx-auto max-w-[1250px] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
        <nav aria-label="Remote sections" className="flex gap-2 border-b border-zinc-800 p-3">
          {(['mapping', 'capture'] as const).map(section => (
            <button
              key={section}
              type="button"
              aria-pressed={screen === section}
              onClick={() => setScreen(section)}
              className={`rounded-lg px-4 py-2 text-sm font-medium ${screen === section ? 'bg-sky-500/15 text-sky-400' : 'text-zinc-400 hover:bg-zinc-900'}`}
            >
              {section === 'mapping' ? 'Mapping' : 'Live capture'}
            </button>
          ))}
        </nav>
        {screen === 'mapping'
          ? <RemotePanel availability={availability} automations={automations.data ?? []} mapping={mapping} side={side} setSide={setSide} />
          : <div className="p-4"><RemoteCapture config={mapping.config} automations={automations.data ?? []} /></div>}
      </div>
    </div>
  )
}
