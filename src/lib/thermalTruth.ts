import { desc, eq } from 'drizzle-orm'
import { db, biometricsDb } from '@/src/db'
import { deviceSettings, deviceState } from '@/src/db/schema'
import { bedTemp, freezerTemp, flowReadings } from '@/src/db/biometrics-schema'
import { shouldBlock as pumpStallShouldBlock } from '@/src/hardware/pumpStallGuard'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { PodVersion } from '@/src/hardware/types'
import { centiDegreesToF } from '@/src/lib/tempUtils'

/** Telemetry proves support; otherwise distinguish known models from startup uncertainty. */
export function reportsPumpSpeed(hasFlow: boolean): boolean | null {
  if (hasFlow) return true
  const version = getDacMonitorIfRunning()?.getLastStatus()?.podVersion
  if (version === PodVersion.POD_5) return true
  if (version === PodVersion.POD_3 || version === PodVersion.POD_4) return false
  return null
}

export type ThermalVerdict = 'off' | 'delivering' | 'holding' | 'stalled' | 'unknown'

/**
 * Thermal truth — reconciles what the app commanded (device_state) against
 * what the hardware is delivering (latest pump RPM + flow). Shared by
 * health.thermal and the System → Health data path.
 */
export function readThermalTruth() {
  // A powered side reporting flow below this is not circulating; firmware
  // locks the TEC at zero flow, so we treat sub-threshold as stalled. This
  // is deliberately a conservative "is it moving at all" floor, independent
  // of the configurable device_settings.pump_stall_rpm_threshold (default
  // 500) that arms the auto-off guard — health only flags a true dead pump.
  const MIN_FLOW_RPM = 100
  // A flow reading older than this on a powered side means the monitor has
  // stopped seeing frames — also a stall (see the overnight gap in the RCA).
  const STALE_SEC = 180
  // Heating/cooling is only "delivering" when target diverges from current
  // by more than sensor noise; a powered, circulating, on-target side is
  // holding — the pump and TEC are still working to keep it there.
  const AT_TARGET_F = 2

  const [settings] = db
    .select({ enabled: deviceSettings.pumpStallProtectionEnabled })
    .from(deviceSettings)
    .limit(1)
    .all()

  const [flow] = biometricsDb
    .select()
    .from(flowReadings)
    .orderBy(desc(flowReadings.timestamp))
    .limit(1)
    .all()

  const [water] = biometricsDb
    .select()
    .from(freezerTemp)
    .orderBy(desc(freezerTemp.timestamp))
    .limit(1)
    .all()

  const [bed] = biometricsDb
    .select()
    .from(bedTemp)
    .orderBy(desc(bedTemp.timestamp))
    .limit(1)
    .all()

  const pumpSpeedSupport = reportsPumpSpeed(flow != null)
  const now = Date.now()
  const flowAgeSec = flow?.timestamp ? Math.round((now - flow.timestamp.getTime()) / 1000) : null

  const sides = (['left', 'right'] as const).map((side) => {
    const [ds] = db.select().from(deviceState).where(eq(deviceState.side, side)).limit(1).all()

    const pumpRpm = side === 'left' ? (flow?.leftPumpRpm ?? null) : (flow?.rightPumpRpm ?? null)
    const flowrate = side === 'left' ? (flow?.leftFlowrateCd ?? null) : (flow?.rightFlowrateCd ?? null)
    const waterCd = side === 'left' ? (water?.leftWaterTemp ?? null) : (water?.rightWaterTemp ?? null)
    const bedCd = side === 'left' ? (bed?.leftCenterTemp ?? null) : (bed?.rightCenterTemp ?? null)

    const isPowered = ds?.isPowered ?? false
    // The hardware has no true "off": powering down sets the heat level to 0
    // (neutral), and level 0 reads back through levelToFahrenheit() as
    // ~82.5°F → 83°F. That synthetic 83 gets persisted to device_state and
    // would otherwise surface here as a phantom target/bed temperature on a
    // side that is actually off. Report null when unpowered so the debug
    // view renders "off"/"—" instead of a misleading 83.
    const target = isPowered ? (ds?.targetTemperature ?? null) : null
    const current = isPowered ? (ds?.currentTemperature ?? null) : null
    const stale = flowAgeSec != null && flowAgeSec > STALE_SEC
    const flowing = pumpRpm != null && pumpRpm >= MIN_FLOW_RPM && !stale

    let verdict: ThermalVerdict
    let note: string | null = null
    if (!isPowered) {
      verdict = 'off'
    }
    else if (!flow) {
      verdict = 'unknown'
      note = pumpSpeedSupport === false
        ? 'this pod does not report pump speed — water temperature tracking the target is the sign it is circulating'
        : 'waiting for the first pump-speed reading — circulation is not yet verified'
    }
    else if (!flowing) {
      verdict = 'stalled'
      note = stale
        ? `powered but no fresh pump reading for ${flowAgeSec}s — pump likely not circulating; TEC locks at zero flow`
        : 'powered but pump below flow threshold — TEC is locked, bed will drift to ambient'
    }
    else if (target != null && current != null && Math.abs(target - current) > AT_TARGET_F) {
      verdict = 'delivering'
    }
    else {
      verdict = 'holding'
    }

    return {
      side,
      isPowered,
      targetTempF: target,
      currentTempF: current,
      isAlarmVibrating: ds?.isAlarmVibrating ?? false,
      poweredOnAt: ds?.poweredOnAt ? ds.poweredOnAt.toISOString() : null,
      pumpRpm,
      flowrate,
      readingAgeSec: flowAgeSec,
      waterTempF: waterCd != null ? Math.round(centiDegreesToF(waterCd) * 10) / 10 : null,
      bedSurfaceTempF: bedCd != null ? Math.round(centiDegreesToF(bedCd) * 10) / 10 : null,
      guardBlocked: pumpStallShouldBlock(side),
      verdict,
      note,
    }
  })

  return {
    pumpStallProtectionEnabled: settings?.enabled ?? false,
    // Pod 3/4 firmware sends no pump speed, so the stall guard has nothing to
    // act on there and its being off isn't worth flagging.
    reportsPumpSpeed: pumpSpeedSupport,
    heatsinkTempF: water?.heatsinkTemp != null ? Math.round(centiDegreesToF(water.heatsinkTemp) * 10) / 10 : null,
    ambientTempF: water?.ambientTemp != null ? Math.round(centiDegreesToF(water.ambientTemp) * 10) / 10 : null,
    sides,
  }
}
