'use client'

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

  const handleToggle = () => {
    toggleMutation.mutate({ blocked: !blocked }) // If currently blocked, unblock. If not blocked, block.
  }

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

      {toggleMutation.isError && (
        <p className="mt-2 text-[10px] text-red-400">
          {toggleMutation.error?.message ?? 'Failed to toggle internet access'}
        </p>
      )}
    </div>
  )
}
