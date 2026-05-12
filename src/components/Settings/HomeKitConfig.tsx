'use client'

import { Home } from 'lucide-react'
import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Toggle } from './Toggle'

/**
 * Settings → HomeKit panel.
 * Toggle bridge on/off, show pairing QR + 8-digit setup code,
 * list paired controllers, expose unpair action.
 */
export function HomeKitConfig() {
  const utils = trpc.useUtils()
  const [error, setError] = useState<string | null>(null)
  const { data, isLoading } = trpc.homekit.getStatus.useQuery({}, {
    refetchInterval: 5_000,
  })

  const setEnabled = trpc.homekit.setEnabled.useMutation({
    onSuccess: () => {
      setError(null)
      utils.homekit.getStatus.invalidate()
    },
    onError: e => setError(e.message),
  })
  const unpair = trpc.homekit.unpair.useMutation({
    onSuccess: () => {
      setError(null)
      utils.homekit.getStatus.invalidate()
    },
    onError: e => setError(e.message),
  })

  if (isLoading || !data) {
    return <div className="h-32 animate-pulse rounded-2xl bg-zinc-900" />
  }

  return (
    <div className="rounded-2xl bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Home size={16} className="text-zinc-400" />
          <h3 className="text-sm font-medium text-white">HomeKit</h3>
        </div>
        <Toggle
          enabled={data.enabled}
          onToggle={() => setEnabled.mutate({ enabled: !data.enabled })}
          disabled={setEnabled.isPending}
          label="HomeKit bridge"
        />
      </div>

      <p className="mt-2 text-xs text-zinc-500">
        Control the pod from Apple Home. Local-only — no Apple servers.
      </p>

      {error && (
        <p className="mt-2 rounded-lg bg-red-950 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {data.enabled && data.running && (
        <div className="mt-4 space-y-3">
          {data.qrDataUrl && (
            <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={data.qrDataUrl} alt="HomeKit pairing QR code" className="h-40 w-40" />
            </div>
          )}
          {data.pincode && (
            <div className="rounded-xl bg-zinc-950 p-3 text-center">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Setup code</p>
              <p className="mt-1 font-mono text-lg tracking-[0.3em] text-white">{data.pincode}</p>
            </div>
          )}

          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
              Paired controllers
            </p>
            {data.pairedControllers.length === 0
              ? <p className="text-xs text-zinc-600">None yet — open the Home app and add accessory.</p>
              : (
                  <ul className="space-y-1 text-xs text-zinc-400">
                    {data.pairedControllers.map(id => (
                      <li key={id} className="font-mono">{id}</li>
                    ))}
                  </ul>
                )}
          </div>

          {data.pairedControllers.length > 0 && (
            <button
              onClick={() => {
                if (confirm('Reset HomeKit pairing? The bridge will rotate its identity (new pincode + QR). Remove the existing bridge from your iPhone\'s Home app first — those tiles will stay "No Response" until you do — then pair again with the new code shown here.')) {
                  unpair.mutate({})
                }
              }}
              disabled={unpair.isPending}
              className="w-full rounded-xl bg-red-950 px-3 py-2 text-xs font-medium text-red-300 active:bg-red-900 disabled:opacity-50"
            >
              {unpair.isPending ? 'Unpairing…' : 'Unpair all controllers'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
