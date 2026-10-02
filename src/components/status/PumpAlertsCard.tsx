'use client'

import { useCallback } from 'react'
import { trpc } from '@/src/utils/trpc'
import { TriangleAlert, X } from 'lucide-react'
import { Button, Card, CardHeader, StatusDot } from '@/src/components/ds'

function formatAge(timestamp: Date): string {
  const ageMs = Date.now() - new Date(timestamp).getTime()
  const minutes = Math.round(ageMs / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * PumpAlertsCard — active (unacknowledged, undismissed) pump alerts with
 * per-row dismiss. These rows are exactly the set the stall guard would
 * resurrect as a block at the next service start, so pruning them here is
 * the escape hatch when a backlog accumulates. Renders nothing when the
 * active list is empty.
 *
 * Wires into:
 * - pumpAlerts.list → active alerts
 * - pumpAlerts.dismissAlert → per-row dismiss (also releases the live
 *   block server-side when the row is the current incident)
 */
export function PumpAlertsCard() {
  const utils = trpc.useUtils()

  // Schema-max limit so one dismiss-all pass drains even a large backlog
  // instead of paging through the 50-row default.
  const { data: alerts } = trpc.pumpAlerts.list.useQuery(
    { limit: 500 },
    { refetchInterval: 30_000 },
  )

  const dismissAlertMutation = trpc.pumpAlerts.dismissAlert.useMutation({
    // NOT_FOUND means another client (or a restart race) already dismissed
    // the row — the list refetch below resolves it either way.
    onSettled: () => utils.pumpAlerts.list.invalidate(),
  })

  const handleDismissAlert = useCallback((id: number) => {
    dismissAlertMutation.mutate({ id })
  }, [dismissAlertMutation])

  const handleDismissAll = useCallback(async () => {
    for (const alert of alerts ?? []) {
      try {
        await dismissAlertMutation.mutateAsync({ id: alert.id })
      }
      catch {
        // Already dismissed elsewhere, or refused because the side is
        // still confirming its power-off — keep draining the rest; the
        // refetch surfaces whatever remains.
      }
    }
  }, [alerts, dismissAlertMutation])

  const activeAlerts = alerts ?? []
  if (activeAlerts.length === 0) return null

  return (
    <Card tone="danger">
      <CardHeader
        title="Pump alerts"
        icon={TriangleAlert}
        iconClassName="text-danger"
        right={activeAlerts.length > 1 && (
          <Button size="sm" variant="ghost" onClick={handleDismissAll} disabled={dismissAlertMutation.isPending}>
            Dismiss all
          </Button>
        )}
      />

      {activeAlerts.map(alert => (
        <div key={alert.id} className="flex items-center gap-2.5 border-t border-line pt-3">
          <StatusDot tone="danger" />
          <span className="flex-1 font-mono text-xs">
            {alert.side === 'left' ? 'Left' : alert.side === 'right' ? 'Right' : 'Both'}
            {' — '}
            {alert.rpm != null ? `${alert.rpm} rpm` : alert.type}
            {' — '}
            {formatAge(alert.timestamp)}
          </span>
          <button
            type="button"
            onClick={() => handleDismissAlert(alert.id)}
            disabled={dismissAlertMutation.isPending}
            aria-label={`Dismiss pump alert ${alert.id}`}
            className="cursor-pointer border-0 bg-transparent p-0 text-fg-2 hover:text-fg disabled:opacity-45"
          >
            <X size={14} />
          </button>
        </div>
      ))}

      <p className="text-xs text-fg-2">
        Unresolved alerts re-block their side at the next service restart. Dismiss alerts that no longer reflect the pump&apos;s state.
      </p>
    </Card>
  )
}
