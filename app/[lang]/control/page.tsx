'use client'

import { use } from 'react'
import { TemperatureControl } from '@/src/components/TemperatureControl/TemperatureControl'
import { trpc } from '@/src/utils/trpc'
import { Button } from '@/src/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/src/ui/card'

export default function ControlPage({
  params,
}: {
  params: Promise<{ lang: string }>
}) {
  const { lang } = use(params)

  const { data: status, refetch } = trpc.device.getStatus.useQuery(undefined, {
    refetchInterval: 5000, // Poll every 5 seconds
  })

  const setTemperature = trpc.device.setTemperature.useMutation({
    onSuccess: () => refetch(),
  })

  const setPower = trpc.device.setPower.useMutation({
    onSuccess: () => refetch(),
  })

  const startPriming = trpc.device.startPriming.useMutation({
    onSuccess: () => refetch(),
  })

  if (!status) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="text-lg">Loading device status...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-4 space-y-4">
      <h1 className="text-3xl font-bold mb-6">Pod Control</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TemperatureControl
          side="left"
          currentTemp={status.leftSide.currentTemperature}
          targetTemp={status.leftSide.targetTemperature}
          isPowered={status.leftSide.targetLevel !== 0}
          onSetTemperature={(temp) => {
            setTemperature.mutate({ side: 'left', temperature: temp })
          }}
          onSetPower={(powered) => {
            setPower.mutate({ side: 'left', powered })
          }}
        />

        <TemperatureControl
          side="right"
          currentTemp={status.rightSide.currentTemperature}
          targetTemp={status.rightSide.targetTemperature}
          isPowered={status.rightSide.targetLevel !== 0}
          onSetTemperature={(temp) => {
            setTemperature.mutate({ side: 'right', temperature: temp })
          }}
          onSetPower={(powered) => {
            setPower.mutate({ side: 'right', powered })
          }}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Device Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between">
            <span>Water Level:</span>
            <span className={status.waterLevel === 'ok' ? 'text-green-600' : 'text-red-600'}>
              {status.waterLevel === 'ok' ? 'OK' : 'Low'}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Priming:</span>
            <span>{status.isPriming ? 'Active' : 'Inactive'}</span>
          </div>
          <div className="flex justify-between">
            <span>Pod Version:</span>
            <span>{status.podVersion}</span>
          </div>
          <Button
            onClick={() => startPriming.mutate()}
            disabled={startPriming.isPending}
            className="w-full mt-4"
          >
            {startPriming.isPending ? 'Starting...' : 'Start Priming'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
