'use client'

import { useCallback } from 'react'
import { Droplets, Play } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Alert, Button, InlineError, LineChart, Modal, SettingRow, Skeleton, Toggle } from '@/src/components/ds'
import { TimeField } from '@/src/components/Settings/SettingsLayout'
import { cn } from '@/lib/utils'
import { dailyWaterLevels, useWaterHistory, waterSeries } from './waterHistory'

const TREND_LABEL: Record<string, string> = {
  stable: 'Stable',
  rising: 'Rising',
  unknown: 'Insufficient data',
}

export function formatTime(d: Date | string | number): string {
  return new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Water & priming dialog (sheet on phones): current level, 7-day chart,
 * active alerts, prime confirmation, and the daily prime schedule.
 */
export function WaterModal({ open, onClose }: { open: boolean, onClose: () => void }) {
  const utils = trpc.useUtils()

  const { data: latest, isLoading } = trpc.waterLevel.getLatest.useQuery(
    {},
    { refetchInterval: 30_000, enabled: open },
  )

  const { data: trend } = trpc.waterLevel.getTrend.useQuery(
    { hours: 24 },
    { refetchInterval: 60_000, enabled: open },
  )

  const { data: history } = useWaterHistory(open)

  const { data: alerts } = trpc.waterLevel.getAlerts.useQuery(
    {},
    { refetchInterval: 30_000, enabled: open },
  )

  const deviceStatus = trpc.device.getStatus.useQuery({}, { enabled: open, refetchInterval: 10_000 })
  const settings = trpc.settings.getAll.useQuery({}, { enabled: open })

  const dismissAlertMutation = trpc.waterLevel.dismissAlert.useMutation({
    onSuccess: () => utils.waterLevel.getAlerts.invalidate(),
  })

  const startPrimeMutation = trpc.device.startPriming.useMutation({
    onSuccess: () => {
      utils.device.getStatus.invalidate()
      onClose()
    },
  })

  const updateDevice = trpc.settings.updateDevice.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  })

  const handleDismissAlert = useCallback((id: number) => {
    dismissAlertMutation.mutate({ id })
  }, [dismissAlertMutation])

  const activeAlerts = alerts ?? []
  const isPriming = deviceStatus.data?.isPriming ?? false
  const device = settings.data?.device
  const primeDaily = device?.primePodDaily ?? false
  const primeTime = device?.primePodTime ?? '14:00'

  const trendText = trend
    ? trend.trend === 'declining' ? `Declining (${trend.lowPercent}% low)` : TREND_LABEL[trend.trend]
    : null

  const days = dailyWaterLevels(history)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Water & priming"
      icon={Droplets}
      iconClassName="text-cool"
      width={480}
    >
      {isLoading
        ? <Skeleton className="h-14" />
        : latest
          ? (
              <div className="flex items-end gap-3.5">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-fg-2">Water level</span>
                  <span className={cn('font-mono text-4xl font-light leading-none', latest.level === 'ok' ? 'text-ok' : 'text-warn')}>
                    {latest.level === 'ok' ? 'OK' : 'Low'}
                  </span>
                </div>
                <span className="pb-1 text-[13px] text-fg-2">
                  {[trendText, `read ${formatTime(latest.timestamp)}`].filter(Boolean).join(' · ')}
                </span>
              </div>
            )
          : <p className="text-[13px] text-fg-2">No water level data</p>}

      {history && history.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <LineChart series={[{ data: waterSeries(history), color: 'var(--accent-cool)', fill: true }]} min={-0.2} max={1.3} height={56} />
          <div className="flex justify-between font-mono text-[10px] text-fg-3">
            {days.map(d => (
              <span key={d.day}>{new Date(d.day).toLocaleDateString([], { weekday: 'short' })}</span>
            ))}
          </div>
        </div>
      )}

      {activeAlerts.map(alert => (
        <Alert key={alert.id} onDismiss={dismissAlertMutation.isPending ? undefined : () => handleDismissAlert(alert.id)}>
          {alert.message ?? alert.type.replace(/_/g, ' ')}
        </Alert>
      ))}

      <div className="flex flex-col gap-2.5 border-t border-line pt-3.5">
        <span className="text-sm font-medium">Prime</span>
        {isPriming
          ? <span className="text-[13px] text-cool">Priming in progress…</span>
          : (
              <>
                <span className="text-[13px] text-warn">
                  Priming circulates water through the system. This takes ~5 minutes.
                </span>
                <div className="flex gap-2.5">
                  <Button
                    variant="primary"
                    icon={Play}
                    onClick={() => startPrimeMutation.mutate({})}
                    disabled={startPrimeMutation.isPending}
                  >
                    {startPrimeMutation.isPending ? 'Starting…' : 'Confirm prime'}
                  </Button>
                  <Button onClick={onClose}>Cancel</Button>
                </div>
              </>
            )}
        {startPrimeMutation.isError && (
          <InlineError>{startPrimeMutation.error?.message ?? 'Failed to start prime'}</InlineError>
        )}
      </div>

      {device && (
        <SettingRow label="Daily prime">
          <TimeField
            label="Daily prime time"
            value={primeTime}
            disabled={!primeDaily || updateDevice.isPending}
            onChange={time => updateDevice.mutate({ primePodTime: time })}
          />
          <Toggle
            on={primeDaily}
            disabled={updateDevice.isPending}
            onChange={on => updateDevice.mutate(on ? { primePodDaily: true, primePodTime: primeTime } : { primePodDaily: false })}
            label="Toggle daily prime pod"
          />
        </SettingRow>
      )}
      {updateDevice.error && <InlineError>{updateDevice.error.message}</InlineError>}
    </Modal>
  )
}
