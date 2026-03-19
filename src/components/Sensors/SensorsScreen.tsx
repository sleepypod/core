'use client'

import { useCallback, useState } from 'react'
import { useSensorStream } from '@/src/hooks/useSensorStream'
import { PullToRefresh } from '@/src/components/PullToRefresh/PullToRefresh'
import { ConnectionStatusBar } from './ConnectionStatusBar'
import { PresenceCard } from './PresenceCard'
import { BedTempMatrix } from './BedTempMatrix'
import { FreezerHealthCard } from './FreezerHealthCard'
import { PiezoWaveform } from './PiezoWaveform'
import { FirmwareLogConsole } from './FirmwareLogConsole'
import { EnvironmentCard } from './EnvironmentCard'
import { TempTrendChart } from './TempTrendChart'
import { CalibrationCard } from './CalibrationCard'

/**
 * Main Sensors screen composition.
 * Connects to the WebSocket sensor stream and renders all live sensor
 * data panels: connection bar, sensor matrix (bed temp), presence with
 * zone activity, piezo waveform, temp trend, environment, system health,
 * and firmware logs.
 *
 * Pull-to-refresh reconnects the WebSocket stream.
 * Matches iOS BedSensorScreen layout and functionality.
 */
export function SensorsScreen() {
  const [streamEnabled, setStreamEnabled] = useState(true)

  // Connect to the sensor stream — subscribes to all sensor types
  const stream = useSensorStream({ enabled: streamEnabled })

  /** Pull-to-refresh: toggle stream off/on to force reconnect. */
  const handleRefresh = useCallback(async () => {
    setStreamEnabled(false)
    // Brief pause to allow WebSocket to close
    await new Promise(resolve => setTimeout(resolve, 300))
    setStreamEnabled(true)
  }, [])

  return (
    <PullToRefresh onRefresh={handleRefresh} enabled={streamEnabled}>
    <div className="space-y-3 pb-4">
      {/* Connection status bar + stream toggle */}
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <ConnectionStatusBar
            status={stream.status}
            fps={stream.fps}
            lastError={stream.lastError}
            subscribedSensors={stream.subscribedSensors}
            lastFrameTime={stream.lastFrameTime}
          />
        </div>
        <button
          onClick={() => setStreamEnabled(v => !v)}
          className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
            streamEnabled
              ? 'bg-red-900/30 text-red-400 active:bg-red-900/50'
              : 'bg-emerald-900/30 text-emerald-400 active:bg-emerald-900/50'
          }`}
        >
          {streamEnabled ? 'Stop' : 'Start'}
        </button>
      </div>

      {/* Paused state */}
      {!streamEnabled && (
        <div className="flex h-32 items-center justify-center rounded-2xl bg-zinc-900">
          <div className="text-center">
            <p className="text-sm text-zinc-400">Stream paused</p>
            <p className="text-xs text-zinc-600">Tap Start to resume live data</p>
          </div>
        </div>
      )}

      {streamEnabled && (
        <>
          {/* Sensor Matrix — Bed Temperature Grid */}
          <SensorCard>
            <BedTempMatrix />
          </SensorCard>

          {/* Bed Presence — capacitive sensing with zone activity */}
          <SensorCard>
            <PresenceCard />
          </SensorCard>

          {/* Piezo Waveform — real-time BCG signal */}
          <SensorCard>
            <PiezoWaveform />
          </SensorCard>

          {/* Temperature Trend — line chart of bed temps over time */}
          <SensorCard>
            <TempTrendChart />
          </SensorCard>

          {/* Environment — humidity & ambient per side */}
          <SensorCard>
            <EnvironmentCard />
          </SensorCard>

          {/* System — freezer thermal health */}
          <SensorCard>
            <FreezerHealthCard />
          </SensorCard>

          {/* Sensor Calibration & Quality Monitoring */}
          <SensorCard>
            <CalibrationCard />
          </SensorCard>

          {/* Firmware Log Console */}
          <SensorCard>
            <FirmwareLogConsole />
          </SensorCard>
        </>
      )}
    </div>
    </PullToRefresh>
  )
}

/** Consistent card wrapper matching iOS cardStyle(). */
function SensorCard({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-800/50 bg-zinc-900 p-2 sm:p-3">
      {children}
    </section>
  )
}
