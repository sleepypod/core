'use client'

import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, SettingRow, Skeleton, StatusDot, Toggle } from '@/src/components/ds'

/** "12345678" → "123-45-678", the format printed on HomeKit labels. */
function formatPincode(pin: string): string {
  const digits = pin.replace(/\D/g, '')
  if (digits.length !== 8) return pin
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
}

/**
 * HomeKit bridge card: toggle, pairing QR + setup code, paired-controller
 * count, and pairing reset.
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
    return <Skeleton className="h-[180px]" />
  }

  const paired = data.pairedControllers.length

  return (
    <Card>
      <CardHeader
        title="HomeKit"
        subtitle="Adds the pod to Apple Home. Local-only — no Apple servers."
        right={data.enabled
          ? (data.running ? <StatusDot tone="ok" label="Running" /> : <StatusDot tone="warn" label="Starting" />)
          : undefined}
      />
      <SettingRow label="HomeKit bridge">
        <Toggle
          on={data.enabled}
          onChange={() => setEnabled.mutate({ enabled: !data.enabled })}
          disabled={setEnabled.isPending}
          label="HomeKit bridge"
        />
      </SettingRow>

      {error && <InlineError>{error}</InlineError>}

      {data.enabled && data.running && (
        <>
          {(data.pincode || data.qrDataUrl) && (
            <div className="flex items-center gap-4 rounded-[10px] border border-line-2 px-4 py-3.5">
              {data.pincode && (
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-xs text-fg-2">Setup code</span>
                  <span className="font-mono text-[26px] tracking-[0.06em]">{formatPincode(data.pincode)}</span>
                </div>
              )}
              {data.qrDataUrl && (
                <div className="shrink-0 rounded-ctl bg-white p-1.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={data.qrDataUrl} alt="HomeKit pairing QR code" className="size-24" />
                </div>
              )}
            </div>
          )}

          <SettingRow
            label="Paired homes"
            sub={paired === 0 ? 'None yet — open the Home app and add accessory.' : undefined}
          >
            <span className="font-mono text-[13px] text-fg-2">{paired}</span>
          </SettingRow>

          {paired > 0 && (
            <div className="flex justify-end">
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm('Reset HomeKit pairing? This rotates the bridge identity (new pincode + QR). You\'ll need to remove the old bridge from the Home app manually — those tiles stay "No Response" until you do — then pair again with the new code shown here.')) {
                    unpair.mutate({})
                  }
                }}
                disabled={unpair.isPending}
              >
                {unpair.isPending ? 'Resetting…' : 'Reset HomeKit pairing'}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
