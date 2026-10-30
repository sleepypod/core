import { readControllerRevision } from '@/src/server/controllerRevision'
import { RoomSignalReader } from '@/src/home-context/instance'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { getBaseControllerIfRunning } from '@/src/hardware/base/instance'
import { getBridgeStatus } from '@/src/streaming/mqttBridge'
import { getComfortRuntimeIfRunning } from '@/src/comfort/instance'
import { buildCapabilities, DEVICE_FRESHNESS_MS } from './contract'

/** Reads only existing runtime state; never starts DAC, Bluetooth, MQTT or a policy. */
export async function readCapabilities() {
  const revision = await readControllerRevision()
  const monitor = getDacMonitorIfRunning()
  const base = getBaseControllerIfRunning()
  return buildCapabilities({
    now: Date.now(),
    revision,
    device: {
      status: monitor?.getLastStatus() ?? null,
      observedAt: monitor?.getLastPollAt() ?? null,
      current: monitor?.getFreshStatus(DEVICE_FRESHNESS_MS) != null,
    },
    base: base?.status() ?? null,
    mqttConnected: getBridgeStatus().connected,
    comfortActive: ['left', 'right'].some(side => getComfortRuntimeIfRunning()?.status(side as 'left' | 'right').activation.current === true),
    comfortPreviewRunning: getComfortRuntimeIfRunning()?.isRunning() ?? false,
    roomContextFresh: Object.keys(new RoomSignalReader().read()).length > 0,
    householdPreparationEnabled: process.env.SLEEPYPOD_HOUSEHOLD_PREPARATION === '1',
  })
}
