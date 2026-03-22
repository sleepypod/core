'use client'

import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Globe, Lock, Loader2 } from 'lucide-react'
import clsx from 'clsx'

/**
 * InternetToggleCard — toggle WAN internet access on/off.
 * Shows current status and allows toggling between local-only and internet modes.
 *
 * Wires into:
 * - system.internetStatus → current blocked/allowed state
 * - system.setInternetAccess → toggle WAN access via iptables
 */
export function InternetToggleCard() {
  const utils = trpc.useUtils()

  const { data: internet, isLoading } = trpc.system.internetStatus.useQuery(
    {},
    { refetchInterval: 10_000 },
  )

  const toggleMutation = trpc.system.setInternetAccess.useMutation({
    onSuccess: () => {
      utils.system.internetStatus.invalidate()
    },
  })

  const blocked = internet?.blocked ?? true
  const isPending = toggleMutation.isPending
  const [confirming, setConfirming] = useState(false)

  const handleToggle = () => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    toggleMutation.mutate({ blocked: !blocked })
  }

  const handleCancel = () => setConfirming(false)

  return (
    <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {blocked ? (
            <Lock size={16} className="text-emerald-400" />
          ) : (
            <Globe size={16} className="text-amber-400" />
          )}
          <div>
            <span className="text-sm font-medium text-white">
              {blocked ? 'Local Only' : 'Internet Enabled'}
            </span>
            <p className="text-[10px] text-zinc-500">
              {blocked
                ? 'Pod cannot reach external servers'
                : 'Pod has WAN internet access'}
            </p>
          </div>
        </div>

        <button
          onClick={handleToggle}
          disabled={isPending || isLoading}
          role="switch"
          aria-checked={!blocked}
          aria-label={blocked ? 'Enable internet access' : 'Disable internet access'}
          className={clsx(
            'relative h-7 w-12 rounded-full transition-colors duration-200',
            blocked ? 'bg-emerald-600' : 'bg-amber-600',
            'disabled:opacity-50',
          )}
        >
          {isPending ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={14} className="animate-spin text-white" />
            </div>
          ) : (
            <div
              className={clsx(
                'h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200',
                'absolute top-1',
                blocked ? 'left-1' : 'left-6',
              )}
            />
          )}
        </button>
      </div>

      {confirming && (
        <div className="mt-2 flex items-center gap-2">
          <p className="flex-1 text-[10px] text-amber-400">
            {blocked ? 'Allow internet access?' : 'Block internet access?'}
          </p>
          <button
            onClick={handleToggle}
            className="rounded-md bg-amber-600/20 px-2.5 py-1 text-[10px] font-medium text-amber-400 active:bg-amber-600/30"
          >
            Confirm
          </button>
          <button
            onClick={handleCancel}
            className="rounded-md px-2.5 py-1 text-[10px] font-medium text-zinc-400 active:bg-zinc-800"
          >
            Cancel
          </button>
        </div>
      )}

      {toggleMutation.isError && (
        <p className="mt-2 text-[10px] text-red-400">
          {toggleMutation.error?.message ?? 'Failed to toggle internet access'}
        </p>
      )}
    </div>
  )
}
