'use client'

import { Wifi, WifiOff, Globe, GlobeLock } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'

/**
 * Get color class based on WiFi signal strength (0-100).
 */
const signalColor = (strength: number | null): string => {
  if (strength === null) return 'text-red-400'
  if (strength < 30) return 'text-red-400'
  if (strength < 60) return 'text-yellow-400'
  return 'text-teal-400'
}

/**
 * Get human-readable signal quality label.
 */
const signalLabel = (strength: number | null): string => {
  if (strength === null) return 'No signal'
  if (strength < 30) return 'Weak'
  if (strength < 60) return 'Fair'
  if (strength < 80) return 'Good'
  return 'Excellent'
}

/**
 * WiFi signal strength bar visualization.
 * Renders 4 bars of increasing height, filled based on signal strength.
 */
const SignalBars = ({ strength }: { strength: number | null }) => {
  const bars = 4
  const filled = strength === null ? 0 : Math.ceil((strength / 100) * bars)
  const color = signalColor(strength)

  return (
    <div className="flex items-end gap-[3px]">
      {Array.from({ length: bars }, (_, i) => (
        <div
          key={i}
          className={`w-[5px] rounded-sm ${i < filled ? color.replace('text-', 'bg-') : 'bg-zinc-700'}`}
          style={{ height: `${8 + i * 4}px` }}
        />
      ))}
    </div>
  )
}

/**
 * NetworkInfoCard — displays WiFi connection info and internet access toggle.
 *
 * Data sources:
 * - system.wifiStatus — SSID, signal strength, connection state
 * - system.internetStatus — whether WAN is blocked by iptables
 * - system.setInternetAccess — toggle WAN block on/off
 *
 * Matches the network info section from the iOS StatusView.
 */
export const NetworkInfoCard = () => {
  const utils = trpc.useUtils()

  const { data: wifi, isLoading: wifiLoading } = trpc.system.wifiStatus.useQuery(
    {},
    { refetchInterval: 10_000 },
  )

  const { data: internet, isLoading: internetLoading } = trpc.system.internetStatus.useQuery(
    {},
    { refetchInterval: 10_000 },
  )

  const setInternet = trpc.system.setInternetAccess.useMutation({
    onMutate: async ({ blocked }) => {
      // Optimistic update
      await utils.system.internetStatus.cancel()
      const prev = utils.system.internetStatus.getData({})
      utils.system.internetStatus.setData({}, { blocked })
      return { prev }
    },
    onError: (_err, _vars, context) => {
      // Rollback on error
      if (context?.prev) {
        utils.system.internetStatus.setData({}, context.prev)
      }
    },
    onSettled: () => {
      utils.system.internetStatus.invalidate()
    },
  })

  const isLoading = wifiLoading || internetLoading
  const connected = wifi?.connected ?? false
  const ssid = wifi?.ssid ?? null
  const signal = wifi?.signal ?? null
  const wanBlocked = internet?.blocked ?? true

  if (isLoading) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-4">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 animate-pulse rounded bg-zinc-800" />
          <div className="h-4 w-24 animate-pulse rounded bg-zinc-800" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-2xl bg-zinc-900 p-4">
      {/* Section header */}
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Network
      </h3>

      {/* WiFi Status Row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {connected
            ? <Wifi size={20} className={signalColor(signal)} />
            : <WifiOff size={20} className="text-red-400" />}
          <div>
            <p className="text-sm font-medium text-zinc-200">
              {connected ? (ssid ?? 'Connected') : 'Disconnected'}
            </p>
            <p className={`text-xs ${signalColor(signal)}`}>
              {connected ? signalLabel(signal) : 'No WiFi connection'}
            </p>
          </div>
        </div>

        {/* Signal strength indicator */}
        {connected && (
          <div className="flex items-center gap-2">
            <SignalBars strength={signal} />
            {signal !== null && (
              <span className="text-xs font-medium text-zinc-400">
                {signal}%
              </span>
            )}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="h-px bg-zinc-800" />

      {/* Internet Access Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {wanBlocked
            ? <GlobeLock size={20} className="text-zinc-500" />
            : <Globe size={20} className="text-teal-400" />}
          <div>
            <p className="text-sm font-medium text-zinc-200">
              Internet Access
            </p>
            <p className="text-xs text-zinc-500">
              {wanBlocked ? 'LAN only — WAN blocked' : 'Full internet access'}
            </p>
          </div>
        </div>

        {/* Toggle switch */}
        <button
          type="button"
          role="switch"
          aria-checked={!wanBlocked}
          aria-label="Toggle internet access"
          disabled={setInternet.isPending}
          onClick={() => setInternet.mutate({ blocked: !wanBlocked })}
          className={`flex min-h-[44px] min-w-[48px] items-center justify-center ${setInternet.isPending ? 'opacity-50' : ''}`}
        >
          <span className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-200 ${
            !wanBlocked ? 'bg-teal-500' : 'bg-zinc-700'
          }`}>
            <span
              className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                !wanBlocked ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </span>
        </button>
      </div>
    </div>
  )
}
