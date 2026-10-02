'use client'

import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, InlineError, SettingRow, StatusDot, Toggle } from '@/src/components/ds'

/**
 * Internet access row — toggle WAN access on/off with an inline confirm.
 *
 * Wires into:
 * - system.internetStatus → current blocked/allowed state
 * - system.setInternetAccess → toggle WAN access via iptables
 */
export function InternetAccessToggle({ dot = false }: { dot?: boolean }) {
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

  const confirm = () => {
    setConfirming(false)
    toggleMutation.mutate({ blocked: !blocked })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[13px]">
        {dot && <StatusDot tone={blocked ? 'ok' : 'warn'} />}
        <span className="flex-1">Internet access</span>
        <span className="font-mono text-xs text-fg-2">{blocked ? 'local only' : 'allowed'}</span>
        <Toggle
          on={!blocked}
          onChange={() => setConfirming(true)}
          disabled={isPending || isLoading || confirming}
          label={blocked ? 'Enable internet access' : 'Disable internet access'}
        />
      </div>

      {confirming && (
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-warn">
            {blocked ? 'Allow internet access?' : 'Block internet access?'}
          </p>
          <Button size="sm" onClick={confirm}>Confirm</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      )}

      {toggleMutation.isError && (
        <InlineError className="text-xs">
          {toggleMutation.error?.message ?? 'Failed to toggle internet access'}
        </InlineError>
      )}
    </div>
  )
}

/** Standalone card version of the internet access toggle. */
export function InternetToggleCard() {
  return (
    <Card>
      <SettingRow label="Internet" sub="Local only keeps the pod from reaching external servers" divider={false} />
      <InternetAccessToggle />
    </Card>
  )
}
