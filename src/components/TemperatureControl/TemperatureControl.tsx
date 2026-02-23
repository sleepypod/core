'use client'

import { useState } from 'react'
import { Button } from '@/src/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/src/ui/card'
import type { Side } from '@/src/hardware/types'

interface TemperatureControlProps {
  side: Side
  currentTemp: number
  targetTemp: number
  isPowered: boolean
  onSetTemperature: (temp: number) => void
  onSetPower: (powered: boolean) => void
}

export function TemperatureControl({
  side,
  currentTemp,
  targetTemp,
  isPowered,
  onSetTemperature,
  onSetPower,
}: TemperatureControlProps) {
  const [tempInput, setTempInput] = useState(targetTemp)

  const handleTempChange = (delta: number) => {
    const newTemp = Math.max(55, Math.min(110, tempInput + delta))
    setTempInput(newTemp)
    onSetTemperature(newTemp)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>{side === 'left' ? 'Left Side' : 'Right Side'}</span>
          <Button
            variant={isPowered ? 'default' : 'outline'}
            size="sm"
            onClick={() => onSetPower(!isPowered)}
          >
            {isPowered ? 'On' : 'Off'}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-muted-foreground">Current</div>
            <div className="text-2xl font-bold">{currentTemp}°F</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Target</div>
            <div className="text-2xl font-bold">{targetTemp}°F</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleTempChange(-5)}
            disabled={!isPowered}
          >
            -5°
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleTempChange(-1)}
            disabled={!isPowered}
          >
            -1°
          </Button>
          <input
            type="number"
            min={55}
            max={110}
            value={tempInput}
            onChange={(e) => {
              const val = Number(e.target.value)
              if (val >= 55 && val <= 110) {
                setTempInput(val)
              }
            }}
            onBlur={() => onSetTemperature(tempInput)}
            disabled={!isPowered}
            className="w-20 text-center rounded border p-2"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleTempChange(1)}
            disabled={!isPowered}
          >
            +1°
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleTempChange(5)}
            disabled={!isPowered}
          >
            +5°
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
