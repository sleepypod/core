'use client'

import { use, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Button } from '@/src/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/src/ui/card'

type Side = 'left' | 'right'

export default function SchedulesPage({
  params,
}: {
  params: Promise<{ lang: string }>
}) {
  const { lang } = use(params)
  const [selectedSide, setSelectedSide] = useState<Side>('left')

  const { data: schedules, refetch } = trpc.schedules.getAll.useQuery({
    side: selectedSide,
  })

  const createTemp = trpc.schedules.createTemperatureSchedule.useMutation({
    onSuccess: () => refetch(),
  })

  const createAlarm = trpc.schedules.createAlarmSchedule.useMutation({
    onSuccess: () => refetch(),
  })

  const deleteTemp = trpc.schedules.deleteTemperatureSchedule.useMutation({
    onSuccess: () => refetch(),
  })

  const deleteAlarm = trpc.schedules.deleteAlarmSchedule.useMutation({
    onSuccess: () => refetch(),
  })

  return (
    <div className="container mx-auto p-4 space-y-4">
      <h1 className="text-3xl font-bold mb-6">Schedules</h1>

      <div className="flex gap-2 mb-4">
        <Button
          variant={selectedSide === 'left' ? 'default' : 'outline'}
          onClick={() => setSelectedSide('left')}
        >
          Left Side
        </Button>
        <Button
          variant={selectedSide === 'right' ? 'default' : 'outline'}
          onClick={() => setSelectedSide('right')}
        >
          Right Side
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Temperature Schedules</CardTitle>
        </CardHeader>
        <CardContent>
          {!schedules?.temperature.length ? (
            <p className="text-sm text-muted-foreground">No temperature schedules</p>
          ) : (
            <div className="space-y-2">
              {schedules.temperature.map((sched) => (
                <div
                  key={sched.id}
                  className="flex items-center justify-between p-2 border rounded"
                >
                  <div>
                    <span className="font-medium">{sched.dayOfWeek}</span>
                    <span className="mx-2">at</span>
                    <span>{sched.time}</span>
                    <span className="mx-2">→</span>
                    <span className="font-bold">{sched.temperature}°F</span>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => deleteTemp.mutate({ id: sched.id })}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alarm Schedules</CardTitle>
        </CardHeader>
        <CardContent>
          {!schedules?.alarm.length ? (
            <p className="text-sm text-muted-foreground">No alarm schedules</p>
          ) : (
            <div className="space-y-2">
              {schedules.alarm.map((sched) => (
                <div
                  key={sched.id}
                  className="flex items-center justify-between p-2 border rounded"
                >
                  <div>
                    <span className="font-medium">{sched.dayOfWeek}</span>
                    <span className="mx-2">at</span>
                    <span>{sched.time}</span>
                    <span className="mx-2">|</span>
                    <span>Intensity: {sched.vibrationIntensity}</span>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => deleteAlarm.mutate({ id: sched.id })}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
