'use client'

import { use, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Button } from '@/src/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/src/ui/card'

export default function SettingsPage({
  params,
}: {
  params: Promise<{ lang: string }>
}) {
  const { lang } = use(params)

  const { data: settings, refetch } = trpc.settings.getAll.useQuery()
  const updateDevice = trpc.settings.updateDevice.useMutation({
    onSuccess: () => refetch(),
  })
  const updateSide = trpc.settings.updateSide.useMutation({
    onSuccess: () => refetch(),
  })

  const [leftName, setLeftName] = useState('')
  const [rightName, setRightName] = useState('')

  if (!settings) {
    return <div className="p-4">Loading settings...</div>
  }

  return (
    <div className="container mx-auto p-4 space-y-4">
      <h1 className="text-3xl font-bold mb-6">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Device Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Timezone</label>
            <select
              className="w-full border rounded p-2"
              value={settings.device?.timezone || 'America/Los_Angeles'}
              onChange={(e) => {
                updateDevice.mutate({ timezone: e.target.value })
              }}
            >
              <option value="America/Los_Angeles">Pacific Time</option>
              <option value="America/Denver">Mountain Time</option>
              <option value="America/Chicago">Central Time</option>
              <option value="America/New_York">Eastern Time</option>
              <option value="Europe/London">London</option>
              <option value="Europe/Berlin">Berlin</option>
              <option value="Asia/Tokyo">Tokyo</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Temperature Unit</label>
            <select
              className="w-full border rounded p-2"
              value={settings.device?.temperatureUnit || 'F'}
              onChange={(e) => {
                updateDevice.mutate({ temperatureUnit: e.target.value as 'F' | 'C' })
              }}
            >
              <option value="F">Fahrenheit</option>
              <option value="C">Celsius</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.device?.rebootDaily || false}
              onChange={(e) => {
                updateDevice.mutate({ rebootDaily: e.target.checked })
              }}
            />
            <label>Enable Daily Reboot</label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.device?.primePodDaily || false}
              onChange={(e) => {
                updateDevice.mutate({ primePodDaily: e.target.checked })
              }}
            />
            <label>Enable Daily Priming</label>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Left Side</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Name</label>
              <input
                type="text"
                className="w-full border rounded p-2"
                value={leftName || settings.sides.left?.name || 'Left'}
                onChange={(e) => setLeftName(e.target.value)}
                onBlur={() => {
                  if (leftName) {
                    updateSide.mutate({ side: 'left', name: leftName })
                  }
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.sides.left?.awayMode || false}
                onChange={(e) => {
                  updateSide.mutate({ side: 'left', awayMode: e.target.checked })
                }}
              />
              <label>Away Mode</label>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Right Side</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Name</label>
              <input
                type="text"
                className="w-full border rounded p-2"
                value={rightName || settings.sides.right?.name || 'Right'}
                onChange={(e) => setRightName(e.target.value)}
                onBlur={() => {
                  if (rightName) {
                    updateSide.mutate({ side: 'right', name: rightName })
                  }
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.sides.right?.awayMode || false}
                onChange={(e) => {
                  updateSide.mutate({ side: 'right', awayMode: e.target.checked })
                }}
              />
              <label>Away Mode</label>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
