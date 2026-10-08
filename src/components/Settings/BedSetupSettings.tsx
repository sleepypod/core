'use client'

import { Card, CardHeader, InlineError, SelectValue, SettingRow } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import type { BedConfiguration } from '@/src/lib/singleSleeper'

export function BedSetupSettings({ device, names }: {
  device: BedConfiguration
  names: { left: string, right: string }
}) {
  const utils = trpc.useUtils()
  const mutation = trpc.settings.updateDevice.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  })
  return (
    <Card>
      <CardHeader title="Bed setup" subtitle="Choose who normally sleeps here. Away mode is temporary and preserves this setup. Temperature linking is a separate control." />
      <SettingRow label="Sleepers" className="flex-col items-stretch min-[600px]:flex-row min-[600px]:items-center">
        <SelectValue
          className="min-w-0 max-w-full [&>select]:max-w-full"
          label="Bed setup"
          value={device.bedMode ?? 'two'}
          options={[
            { value: 'two', label: 'Two sleepers' },
            { value: 'solo-left', label: `Solo · ${names.left} (left)` },
            { value: 'solo-right', label: `Solo · ${names.right} (right)` },
          ]}
          onChange={bedMode => mutation.mutate({ bedMode })}
          disabled={mutation.isPending}
        />
      </SettingRow>
      <SettingRow className="flex-col items-stretch min-[600px]:flex-row min-[600px]:items-center" label="Other temperature zone" sub="When one sleeper is home. Both zones keep their saved schedules; absent sleepers’ alarms are paused.">
        <SelectValue
          label="Other temperature zone"
          value={device.unusedZoneMode ?? 'off'}
          options={[
            { value: 'off', label: 'Stay off' },
            { value: 'follow', label: 'Follow my schedule' },
            { value: 'independent', label: 'Use its own schedule' },
          ]}
          onChange={unusedZoneMode => mutation.mutate({ unusedZoneMode })}
          disabled={mutation.isPending}
        />
      </SettingRow>
      <p className="text-xs text-fg-2">One active sleeper gets one sleep record using sensors across the bed. Manual temperature and power controls remain available for both zones.</p>
      {mutation.error && <InlineError>{mutation.error.message}</InlineError>}
    </Card>
  )
}
