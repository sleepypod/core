import { Scheduler } from './scheduler'
import { JobType } from './types'
import { db } from '@/src/db'
import {
  temperatureSchedules,
  powerSchedules,
  alarmSchedules,
  deviceSettings,
  sideSettings,
  runOnceSessions,
  deviceState,
} from '@/src/db/schema'
import { and, eq, gt } from 'drizzle-orm'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { encode as cborEncode } from 'cbor-x'
import { fahrenheitToLevel, HardwareCommand } from '@/src/hardware/types'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'
import { cancelAutoOffTimer } from '@/src/services/autoOffWatcher'
import { markSideMutated } from '@/src/hardware/deviceStateSync'
import { withSideLock } from '@/src/hardware/sideLock'
import { timeToDate, nowInTimezone } from './timeUtils'

const HEARTBEAT_INTERVAL_MS_DEFAULT = 60_000
const HEARTBEAT_STALE_MS_DEFAULT = 90_000
const HEARTBEAT_RELOAD_COOLDOWN_MS = 300_000

interface JobManagerOptions {
  heartbeatIntervalMs?: number
  heartbeatStaleMs?: number
}

/**
 * Job manager - orchestrates all scheduled tasks
 */
export class JobManager {
  private scheduler: Scheduler
  private reloadInProgress: Promise<void> | null = null
  private reloadPending: boolean = false

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatStaleMs: number
  private lastHeartbeatReloadAt = 0

  constructor(timezone: string, options: JobManagerOptions = {}) {
    this.scheduler = new Scheduler({
      timezone,
      enabled: true,
    })

    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS_DEFAULT
    this.heartbeatStaleMs = options.heartbeatStaleMs ?? HEARTBEAT_STALE_MS_DEFAULT

    this.setupEventListeners()
  }

  /**
   * Read the current powered state for a side from device_state.
   * Returns false if no row exists (treat as off).
   */
  private async isSidePowered(side: 'left' | 'right'): Promise<boolean> {
    const [row] = await db
      .select({ isPowered: deviceState.isPowered })
      .from(deviceState)
      .where(eq(deviceState.side, side))
      .limit(1)
    return row?.isPowered ?? false
  }

  /**
   * Synchronously mark a side as powered off in device_state. Called by
   * power_off handlers BEFORE sending the hardware command so concurrent
   * temp/alarm jobs that acquire the side lock after see isPowered=false
   * and skip. The DAC monitor's status poll will reconcile shortly after.
   */
  private async markSideOff(side: 'left' | 'right'): Promise<void> {
    markSideMutated(side)
    try {
      await db
        .update(deviceState)
        .set({
          isPowered: false,
          poweredOnAt: null,
          targetTemperature: null,
          lastUpdated: new Date(),
        })
        .where(eq(deviceState.side, side))
    }
    catch (e) {
      console.warn(`[jobManager] markSideOff failed for ${side}:`, e instanceof Error ? e.message : e)
    }
  }

  /**
   * Parse time string into hour and minute, with validation
   */
  private parseTime(time: string): [number, number] {
    const [hour, minute] = time.split(':').map(Number)
    if (Number.isNaN(hour) || Number.isNaN(minute)) {
      throw new Error(`Invalid time format: "${time}"`)
    }
    return [hour, minute]
  }

  // No-op listener. The per-job log line synchronously hits journald which
  // dominates reloadSchedules() cost at our job count (357+) — measured ~7s
  // on-device for the rebuild was almost entirely journald writes.
  // loadSchedules logs the totals at the end. Re-enable behind an env flag
  // if you need to trace individual job registration.
  private onJobScheduled = () => {}

  private onJobExecuted = (jobId: string, result: { success: boolean, error?: string }) => {
    if (result.success) {
      console.log(`Job executed successfully: ${jobId}`)
    }
    else {
      console.error(`Job execution failed: ${jobId}`, result.error)
    }
  }

  private onJobError = (jobId: string, error: Error) => {
    console.error(`Job error: ${jobId}`, error)
  }

  /**
   * Setup event listeners for job lifecycle.
   * Removes any existing listeners first to prevent duplicates on reload.
   */
  private setupEventListeners(): void {
    this.removeEventListeners()
    this.scheduler.on('jobScheduled', this.onJobScheduled)
    this.scheduler.on('jobExecuted', this.onJobExecuted)
    this.scheduler.on('jobError', this.onJobError)
  }

  /**
   * Remove event listeners to prevent memory leaks.
   */
  private removeEventListeners(): void {
    this.scheduler.off('jobScheduled', this.onJobScheduled)
    this.scheduler.off('jobExecuted', this.onJobExecuted)
    this.scheduler.off('jobError', this.onJobError)
  }

  /**
   * Load all schedules from database and schedule jobs
   */
  async loadSchedules(): Promise<void> {
    console.log('Loading schedules from database...')

    // node-schedule's scheduleJob is synchronous and CPU-bound; registering
    // hundreds of cron jobs in a tight loop blocks the event loop for seconds
    // and starves the HTTP layer of the chance to flush API responses.
    // Yielding every YIELD_EVERY iterations lets the response flush while the
    // remainder of the rebuild continues. Incremental scheduling (issue #612)
    // is the proper fix.
    const YIELD_EVERY = 25
    const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve))

    // Load temperature schedules
    const tempSchedules = await db.select().from(temperatureSchedules)
    for (let i = 0; i < tempSchedules.length; i++) {
      if (tempSchedules[i].enabled) {
        this.scheduleTemperature(tempSchedules[i])
      }
      if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop()
    }

    // Load power schedules
    const powSchedules = await db.select().from(powerSchedules)
    for (let i = 0; i < powSchedules.length; i++) {
      if (powSchedules[i].enabled) {
        this.schedulePowerOn(powSchedules[i])
        this.schedulePowerOff(powSchedules[i])
      }
      if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop()
    }

    // Load alarm schedules
    const almSchedules = await db.select().from(alarmSchedules)
    for (let i = 0; i < almSchedules.length; i++) {
      if (almSchedules[i].enabled) {
        this.scheduleAlarm(almSchedules[i])
      }
      if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop()
    }

    // Load system schedules (priming, reboot)
    const [settings] = await db.select().from(deviceSettings).limit(1)
    if (settings) {
      if (settings.primePodDaily && settings.primePodTime) {
        this.scheduleDailyPriming(settings.primePodTime)
        // Always reboot 1hr before priming to ensure clean device state
        this.schedulePrimePreReboot(settings.primePodTime)
        // Calibrate sensors 30min before priming (bed should be empty)
        this.schedulePrePrimeCalibration(settings.primePodTime)
      }

      if (settings.rebootDaily && settings.rebootTime) {
        this.scheduleDailyReboot(settings.rebootTime)
      }

      if (settings.ledNightModeEnabled && settings.ledNightStartTime && settings.ledNightEndTime) {
        await this.scheduleLedNightMode(
          settings.ledNightStartTime,
          settings.ledNightEndTime,
          settings.ledDayBrightness,
          settings.ledNightBrightness,
        )
      }
    }

    // Load away mode schedules from side settings
    const sides = await db.select().from(sideSettings)
    for (const side of sides) {
      if (side.awayStart || side.awayReturn) {
        this.scheduleAwayMode(side.side, side.awayStart, side.awayReturn)
      }
    }

    // Restore active run-once sessions (reboot survival)
    await this.loadRunOnceSessions()

    console.log(`Loaded ${this.scheduler.getJobs().length} scheduled jobs`)

    this.startHeartbeat()
  }

  // ---------------------------------------------------------------------------
  // Liveness heartbeat
  //
  // node-schedule's internal cron loop has been observed to silently stop
  // firing jobs while the host process keeps running (status 200 on tRPC,
  // no exception, just no fires). On 2026-05-02 this caused the 17:00 UTC
  // power-off jobs to be missed entirely, leaving the bed heating until the
  // user noticed. The heartbeat scans for jobs whose nextInvocation() has
  // slipped into the past and, if any are stale, forces a reloadSchedules()
  // to re-register fresh node-schedule timers. Cooldown prevents spinning
  // on a persistent failure.
  // ---------------------------------------------------------------------------
  startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      void this.checkLiveness()
    }, this.heartbeatIntervalMs)
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * Detect overdue jobs and force a schedule reload if any are found.
   * Public so health endpoints / tests can trigger an on-demand check.
   * Returns the list of stale job IDs found this tick (empty if healthy).
   */
  async checkLiveness(): Promise<string[]> {
    const now = Date.now()
    const stale: string[] = []
    for (const job of this.scheduler.getJobs()) {
      if (job.type === JobType.RUN_ONCE) continue
      const next = this.scheduler.getNextInvocation(job.id)
      if (!next) continue
      const nextMs = next.getTime()
      if (nextMs < now - this.heartbeatStaleMs) {
        stale.push(job.id)
      }
    }
    if (stale.length === 0) return stale

    const cooldownLeft = HEARTBEAT_RELOAD_COOLDOWN_MS - (now - this.lastHeartbeatReloadAt)
    if (cooldownLeft > 0) {
      console.warn(
        `[scheduler] ${stale.length} jobs overdue past nextRun by >${this.heartbeatStaleMs}ms `
        + `(examples: ${stale.slice(0, 3).join(', ')}). Reload cooldown active for ${Math.round(cooldownLeft / 1000)}s.`
      )
      return stale
    }
    console.warn(
      `[scheduler] ${stale.length} jobs overdue past nextRun by >${this.heartbeatStaleMs}ms `
      + `(examples: ${stale.slice(0, 3).join(', ')}). Forcing reloadSchedules().`
    )
    this.lastHeartbeatReloadAt = now
    try {
      await this.reloadSchedules()
    }
    catch (e) {
      console.error('[scheduler] heartbeat-triggered reload failed:', e instanceof Error ? e.message : e)
    }
    return stale
  }

  /**
   * Schedule a temperature change
   */
  private scheduleTemperature(
    sched: typeof temperatureSchedules.$inferSelect
  ): void {
    const [hour, minute] = this.parseTime(sched.time)
    const cron = this.buildWeeklyCron(sched.dayOfWeek, hour, minute)

    this.scheduler.scheduleJob(
      `temp-${sched.id}`,
      JobType.TEMPERATURE,
      cron,
      () => this.runTemperatureJob(sched),
      { scheduleId: sched.id, side: sched.side, targetTemperature: sched.temperature }
    )
  }

  /**
   * Execute a temperature job's body. Exposed so tests can drive the handler
   * directly without going through cron timing. Same gating + side-lock as
   * the registered scheduler handler.
   */
  async runTemperatureJob(sched: typeof temperatureSchedules.$inferSelect): Promise<void> {
    if (await this.hasActiveRunOnceSession(sched.side)) {
      console.log(`Skipping recurring temp job temp-${sched.id} — run-once session active for ${sched.side}`)
      return
    }
    await withSideLock(sched.side, async () => {
      if (!(await this.isSidePowered(sched.side))) {
        console.log(`Skipping temp job temp-${sched.id} — ${sched.side} is not powered`)
        return
      }
      markSideMutated(sched.side)
      const client = getSharedHardwareClient()
      await client.connect()
      await client.setTemperature(sched.side, sched.temperature)
      broadcastMutationStatus(sched.side, {
        targetTemperature: sched.temperature,
        targetLevel: fahrenheitToLevel(sched.temperature),
      })
    })
  }

  /**
   * Schedule power on
   */
  private schedulePowerOn(sched: typeof powerSchedules.$inferSelect): void {
    const [hour, minute] = this.parseTime(sched.onTime)
    const cron = this.buildWeeklyCron(sched.dayOfWeek, hour, minute)

    this.scheduler.scheduleJob(
      `power-on-${sched.id}`,
      JobType.POWER_ON,
      cron,
      () => this.runPowerOnJob(sched),
      { scheduleId: sched.id, side: sched.side, targetTemperature: sched.onTemperature }
    )
  }

  async runPowerOnJob(sched: typeof powerSchedules.$inferSelect): Promise<void> {
    if (await this.hasActiveRunOnceSession(sched.side)) {
      console.log(`Skipping recurring power-on job — run-once session active for ${sched.side}`)
      return
    }
    await withSideLock(sched.side, async () => {
      markSideMutated(sched.side)
      const client = getSharedHardwareClient()
      await client.connect()
      await client.setPower(sched.side, true, sched.onTemperature)
      cancelAutoOffTimer(sched.side)
      const onTemp = sched.onTemperature ?? 75
      broadcastMutationStatus(sched.side, {
        targetTemperature: onTemp,
        targetLevel: fahrenheitToLevel(onTemp),
      })
    })
  }

  /**
   * Schedule power off
   */
  private schedulePowerOff(sched: typeof powerSchedules.$inferSelect): void {
    const [hour, minute] = this.parseTime(sched.offTime)
    const cron = this.buildWeeklyCron(sched.dayOfWeek, hour, minute)

    this.scheduler.scheduleJob(
      `power-off-${sched.id}`,
      JobType.POWER_OFF,
      cron,
      () => this.runPowerOffJob(sched),
      { scheduleId: sched.id, side: sched.side }
    )
  }

  async runPowerOffJob(sched: typeof powerSchedules.$inferSelect): Promise<void> {
    if (await this.hasActiveRunOnceSession(sched.side)) {
      console.log(`Skipping recurring power-off job — run-once session active for ${sched.side}`)
      return
    }
    await withSideLock(sched.side, async () => {
      // Mark off in DB BEFORE hardware so any temp/alarm job that acquires
      // the side lock after this one observes isPowered=false and skips its
      // setTemperature command.
      await this.markSideOff(sched.side)
      const client = getSharedHardwareClient()
      await client.connect()
      await client.setPower(sched.side, false)
      broadcastMutationStatus(sched.side, { targetLevel: 0 })
    })
  }

  /**
   * Schedule an alarm
   */
  private scheduleAlarm(sched: typeof alarmSchedules.$inferSelect): void {
    const [hour, minute] = this.parseTime(sched.time)
    const cron = this.buildWeeklyCron(sched.dayOfWeek, hour, minute)

    this.scheduler.scheduleJob(
      `alarm-${sched.id}`,
      JobType.ALARM,
      cron,
      () => this.runAlarmJob(sched),
      { scheduleId: sched.id, side: sched.side, targetTemperature: sched.alarmTemperature }
    )
  }

  async runAlarmJob(sched: typeof alarmSchedules.$inferSelect): Promise<void> {
    await withSideLock(sched.side, async () => {
      // Vibration must fire regardless of power state — the alarm's purpose is
      // to wake the user, who often sleeps with the bed off or on a power
      // schedule that hasn't kicked in yet at wake time. Temperature, however,
      // is gated on isPowered: heating an off bed contradicts the user's
      // explicit power-off and would re-arm the same race the temperature
      // path's gate was added to prevent (see withSideLock comment).
      const powered = await this.isSidePowered(sched.side)
      markSideMutated(sched.side)
      const client = getSharedHardwareClient()
      await client.connect()
      if (powered) {
        await client.setTemperature(sched.side, sched.alarmTemperature)
      }
      else {
        console.log(`Alarm job alarm-${sched.id} — ${sched.side} not powered; skipping temperature, firing vibration only`)
      }
      await client.setAlarm(sched.side, {
        vibrationIntensity: sched.vibrationIntensity,
        vibrationPattern: sched.vibrationPattern,
        duration: sched.duration,
      })
      broadcastMutationStatus(sched.side, {
        ...(powered && {
          targetTemperature: sched.alarmTemperature,
          targetLevel: fahrenheitToLevel(sched.alarmTemperature),
        }),
        isAlarmVibrating: true,
      })
    })
  }

  /**
   * Schedule daily priming
   */
  private scheduleDailyPriming(time: string): void {
    const [hour, minute] = this.parseTime(time)
    const cron = `${minute} ${hour} * * *` // Every day at specified time

    this.scheduler.scheduleJob('daily-prime', JobType.PRIME, cron, async () => {
      const client = getSharedHardwareClient()
      await client.connect()
      try {
        await client.startPriming()
      }
      finally {
        // shared client — don't disconnect
      }
    })
  }

  /**
   * Schedule daily reboot
   */
  private scheduleDailyReboot(time: string): void {
    const [hour, minute] = this.parseTime(time)
    const cron = `${minute} ${hour} * * *`

    this.scheduler.scheduleJob('daily-reboot', JobType.REBOOT, cron, async () => {
      console.log('Executing daily system reboot...')
      await this.executeReboot()
    })
  }

  /**
   * Send a LED brightness command via the shared hardware client.
   *
   * Frank's SetSettings (cmd 8) CBOR map uses 2-char keys. The full schema as
   * emitted by firmware: {v:<schema-ver>, gl:<temp-left>, gr:<temp-right>, lb:<0..100>}.
   * Sending unknown keys (e.g. {ledBrightness}) is silently ignored — the
   * write succeeds but the LED never changes. See docs/hardware/DAC-PROTOCOL.md.
   */
  private async sendLedBrightness(brightness: number): Promise<void> {
    // Route through the client's sendRaw so the connect() check and the actual
    // write share the same dacTransport module instance. Importing sendCommand
    // directly from another module can land in a separate Turbopack chunk
    // whose `transport` singleton is undefined, which makes every LED write
    // throw "[DAC] not connected" and stalls 9–15s on a retried server start.
    // Cast mirrors device.ts's debug-execute path — sendRaw lives on the
    // shared client but isn't on the dev HardwareClient interface.
    const client = getSharedHardwareClient() as unknown as { sendRaw(command: string, args?: string): Promise<string> }
    const hexCbor = Buffer.from(cborEncode({ lb: brightness })).toString('hex')
    await client.sendRaw(HardwareCommand.SET_SETTINGS, hexCbor)
  }

  /**
   * Apply the correct LED brightness right now based on persisted device
   * settings and the scheduler's configured timezone. Called from
   * settings.updateDevice so a brightness slider change reflects on the pod
   * within ~1s, regardless of whether night mode is enabled (in which case
   * the next cron-fired update will overwrite this when the window flips).
   */
  async applyCurrentLedBrightness(): Promise<void> {
    const [settings] = await db.select().from(deviceSettings).limit(1)
    if (!settings) return

    const target = this.computeCurrentLedBrightness(
      settings.ledNightModeEnabled,
      settings.ledNightStartTime,
      settings.ledNightEndTime,
      settings.ledDayBrightness,
      settings.ledNightBrightness,
    )
    await this.sendLedBrightness(target)
  }

  private computeCurrentLedBrightness(
    nightModeEnabled: boolean,
    nightStartTime: string | null,
    nightEndTime: string | null,
    dayBrightness: number,
    nightBrightness: number,
  ): number {
    if (!nightModeEnabled || !nightStartTime || !nightEndTime) {
      return dayBrightness
    }

    const [startHour, startMinute] = this.parseTime(nightStartTime)
    const [endHour, endMinute] = this.parseTime(nightEndTime)
    const { hour: nowHour, minute: nowMinute } = nowInTimezone(this.scheduler.getTimezone())
    const nowMinutes = nowHour * 60 + nowMinute
    const startMinutes = startHour * 60 + startMinute
    const endMinutes = endHour * 60 + endMinute

    const isNight = startMinutes <= endMinutes
      ? nowMinutes >= startMinutes && nowMinutes < endMinutes
      : nowMinutes >= startMinutes || nowMinutes < endMinutes

    return isNight ? nightBrightness : dayBrightness
  }

  /**
   * Schedule LED night mode — two daily cron jobs:
   * one at nightStartTime to dim LEDs, one at nightEndTime to restore brightness.
   * Also applies the correct brightness immediately based on current time.
   */
  private async scheduleLedNightMode(
    nightStartTime: string,
    nightEndTime: string,
    dayBrightness: number,
    nightBrightness: number,
  ): Promise<void> {
    const [startHour, startMinute] = this.parseTime(nightStartTime)
    const startCron = `${startMinute} ${startHour} * * *`

    // Closures read brightness from the DB at fire time. This lets brightness
    // sliders skip reloadSchedules() (which rebuilds thousands of temperature
    // cron jobs) — a captured value would otherwise go stale until the next
    // unrelated scheduler reload.
    this.scheduler.scheduleJob('led-night-start', JobType.LED_BRIGHTNESS, startCron, async () => {
      const [s] = await db.select().from(deviceSettings).limit(1)
      const target = s?.ledNightBrightness ?? nightBrightness
      console.log(`LED night mode: setting brightness to ${target}`)
      await this.sendLedBrightness(target)
    }, { brightness: nightBrightness })

    const [endHour, endMinute] = this.parseTime(nightEndTime)
    const endCron = `${endMinute} ${endHour} * * *`

    this.scheduler.scheduleJob('led-night-end', JobType.LED_BRIGHTNESS, endCron, async () => {
      const [s] = await db.select().from(deviceSettings).limit(1)
      const target = s?.ledDayBrightness ?? dayBrightness
      console.log(`LED night mode: setting brightness to ${target}`)
      await this.sendLedBrightness(target)
    }, { brightness: dayBrightness })

    // Apply correct brightness immediately based on whether we're in the night window.
    // Delegates to computeCurrentLedBrightness so the window math has one source of
    // truth (it also serves applyCurrentLedBrightness for slider-driven writes).
    const targetBrightness = this.computeCurrentLedBrightness(
      true,
      nightStartTime,
      nightEndTime,
      dayBrightness,
      nightBrightness,
    )
    try {
      await this.sendLedBrightness(targetBrightness)
    }
    catch (e) {
      console.warn('LED night mode: failed to apply initial brightness:', e)
    }
  }

  /**
   * Schedule away mode — one-shot jobs for a side:
   * at awayStart, set awayMode=true + power off;
   * at awayReturn, set awayMode=false.
   */
  private scheduleAwayMode(
    side: 'left' | 'right',
    awayStart: string | null,
    awayReturn: string | null,
  ): void {
    const now = new Date()

    if (awayStart) {
      const startDate = new Date(awayStart)
      if (startDate > now) {
        this.scheduler.scheduleOneTimeJob(
          `away-start-${side}`,
          JobType.AWAY_MODE,
          startDate,
          async () => {
            console.log(`Away mode: activating for ${side}`)
            await db.transaction((tx) => {
              tx.update(sideSettings)
                .set({ awayMode: true, updatedAt: new Date() })
                .where(eq(sideSettings.side, side))
                .run()
            })
            // Power off the side
            try {
              const client = getSharedHardwareClient()
              await client.connect()
              await client.setPower(side, false)
              broadcastMutationStatus(side, { targetLevel: 0 })
            }
            catch (e) {
              console.warn(`[awayMode] Failed to power off ${side}:`, e)
            }
          },
          { side },
        )
      }
    }

    if (awayReturn) {
      const returnDate = new Date(awayReturn)
      if (returnDate > now) {
        this.scheduler.scheduleOneTimeJob(
          `away-return-${side}`,
          JobType.AWAY_MODE,
          returnDate,
          async () => {
            console.log(`Away mode: deactivating for ${side}`)
            await db.transaction((tx) => {
              tx.update(sideSettings)
                .set({ awayMode: false, updatedAt: new Date() })
                .where(eq(sideSettings.side, side))
                .run()
            })
            // Restore power for the side
            try {
              const client = getSharedHardwareClient()
              await client.connect()
              await client.setPower(side, true)
              cancelAutoOffTimer(side)
              broadcastMutationStatus(side, {})
            }
            catch (e) {
              console.warn(`[awayMode] Failed to power on ${side}:`, e)
            }
          },
          { side },
        )
      }
    }
  }

  /**
   * Schedule a reboot 1 hour before daily priming.
   * Ensures the device is in a clean state before the prime cycle runs.
   */
  private schedulePrimePreReboot(primeTime: string): void {
    const [hour, minute] = this.parseTime(primeTime)
    // Subtract 60 minutes, wrapping around midnight
    const totalMinutes = ((hour * 60 + minute - 60) % 1440 + 1440) % 1440
    const rebootHour = Math.floor(totalMinutes / 60)
    const rebootMinute = totalMinutes % 60
    const cron = `${rebootMinute} ${rebootHour} * * *`

    this.scheduler.scheduleJob('prime-prereboot', JobType.REBOOT, cron, async () => {
      console.log('Executing pre-prime system reboot...')
      await this.executeReboot()
    })
  }

  /**
   * Schedule sensor calibration 30 minutes before daily priming.
   * After the pre-prime reboot (1hr before) the pod is up with a clean state,
   * and the bed should be empty — ideal conditions for baseline capture.
   * Writes a trigger file that the calibrator Python module picks up.
   */
  private schedulePrePrimeCalibration(primeTime: string): void {
    const [hour, minute] = this.parseTime(primeTime)
    // Subtract 30 minutes, wrapping around midnight
    const totalMinutes = ((hour * 60 + minute - 30) % 1440 + 1440) % 1440
    const calHour = Math.floor(totalMinutes / 60)
    const calMinute = totalMinutes % 60
    const cron = `${calMinute} ${calHour} * * *`

    this.scheduler.scheduleJob('pre-prime-calibration', JobType.CALIBRATION, cron, async () => {
      console.log('Triggering pre-prime sensor calibration...')
      const { writeFile, rename } = await import('node:fs/promises')
      const { dirname, join } = await import('node:path')
      const triggerDir = dirname(
        process.env.CALIBRATION_TRIGGER_PATH
        ?? '/persistent/sleepypod-data/.calibrate-trigger'
      )
      const ts = Date.now()
      const target = join(triggerDir, `.calibrate-trigger.${ts}`)
      const tmp = `${target}.tmp`
      const payload = JSON.stringify({
        side: 'all',
        sensor_type: 'all',
        ts: Math.floor(ts / 1000),
      })
      await writeFile(tmp, payload)
      await rename(tmp, target)
      console.log('Calibration trigger written — calibrator module will process within 10s')
    })
  }

  /**
   * Execute a system reboot via systemctl.
   * Returns a Promise so callers can await and the scheduler can surface failures.
   */
  private async executeReboot(): Promise<void> {
    const { exec } = await import('child_process')
    return new Promise((resolve, reject) => {
      exec('systemctl reboot', (error) => {
        if (error) {
          console.error('Reboot command failed:', error.message)
          reject(error)
        }
        else {
          resolve()
        }
      })
    })
  }

  /**
   * Build cron expression for weekly schedule
   */
  private buildWeeklyCron(
    dayOfWeek:
      | 'sunday'
      | 'monday'
      | 'tuesday'
      | 'wednesday'
      | 'thursday'
      | 'friday'
      | 'saturday',
    hour: number,
    minute: number
  ): string {
    const dayMap = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    }

    const dayNum = dayMap[dayOfWeek]
    return `${minute} ${hour} * * ${dayNum}`
  }

  // ---------------------------------------------------------------------------
  // Per-schedule incremental upsert / cancel
  //
  // The full `reloadSchedules()` cancels every recurring job and rebuilds from
  // the DB. That is correct for heartbeat liveness and drift recovery but
  // catastrophic when only one row changed: a reload that lands inside a
  // job's fire window (e.g. HH:MM:04 for a job whose cron fires at HH:MM)
  // cancels the just-fired job and recreates it computing the next invocation
  // from the cron — which skips to next week for a weekly recurring job
  // (yggdrasil-49). It also magnifies the wall-clock cost of every CRUD into
  // a full DB re-scan + N rescheduleJob calls.
  //
  // These helpers touch only the affected job(s):
  // - upsert*Job(sched) — schedules or replaces a single row's job(s).
  //   Idempotent: calling twice with the same input leaves exactly one job
  //   in the scheduler (scheduleJob cancels the prior id before scheduling).
  //   When `enabled === false`, the upsert acts as cancel.
  // - cancel*Job(id) — removes the job(s) for that row id. No-op if absent.
  //
  // Two styles exist below:
  // - Single-id helpers (temp/alarm/power) rely on scheduleJob's
  //   cancel-existing-by-id semantics: schedule*() is called with the same
  //   id and the prior job is replaced atomically.
  // - Multi-id helpers (reboot/prime/awayMode) explicitly cancel every
  //   sub-job up front, because the new schedule may leave a strict subset
  //   armed (e.g. awayStart set but awayReturn null) and the old sub-jobs
  //   would otherwise persist.
  //
  // Residual self-edit caveat: editing a row inside its own fire window still
  // recreates that row's job and recomputes nextInvocation from "now". The
  // currently-firing handler runs to completion (node-schedule does not
  // interrupt in-flight invocations), and the next fire reflects the new row
  // state — which is the desired behavior for a user-driven edit.
  // ---------------------------------------------------------------------------

  /**
   * Upsert the cron job for a single temperature schedule.
   * Cancels the existing `temp-${id}` job if disabled; otherwise (re)schedules.
   */
  upsertTemperatureJob(sched: typeof temperatureSchedules.$inferSelect): void {
    if (!sched.enabled) {
      this.cancelTemperatureJob(sched.id)
      return
    }
    this.scheduleTemperature(sched)
  }

  cancelTemperatureJob(id: number): void {
    this.scheduler.cancelJob(`temp-${id}`)
  }

  /**
   * Upsert both on/off cron jobs for a single power schedule.
   */
  upsertPowerJob(sched: typeof powerSchedules.$inferSelect): void {
    if (!sched.enabled) {
      this.cancelPowerJob(sched.id)
      return
    }
    this.schedulePowerOn(sched)
    this.schedulePowerOff(sched)
  }

  cancelPowerJob(id: number): void {
    this.scheduler.cancelJob(`power-on-${id}`)
    this.scheduler.cancelJob(`power-off-${id}`)
  }

  /**
   * Upsert the cron job for a single alarm schedule.
   */
  upsertAlarmJob(sched: typeof alarmSchedules.$inferSelect): void {
    if (!sched.enabled) {
      this.cancelAlarmJob(sched.id)
      return
    }
    this.scheduleAlarm(sched)
  }

  cancelAlarmJob(id: number): void {
    this.scheduler.cancelJob(`alarm-${id}`)
  }

  /**
   * Upsert the LED night-mode jobs from the latest device-settings values.
   * Pass `enabled=false` (or omit start/end) to cancel; pass enabled+times
   * to (re)schedule. scheduleLedNightMode also applies the correct brightness
   * immediately based on the configured timezone window, so a settings change
   * is reflected on the hardware without waiting for the next cron fire.
   */
  async upsertLedNightMode(
    enabled: boolean,
    nightStartTime: string | null,
    nightEndTime: string | null,
    dayBrightness: number,
    nightBrightness: number,
  ): Promise<void> {
    this.cancelLedNightMode()
    if (!enabled || !nightStartTime || !nightEndTime) {
      // Night mode just turned off — restore day brightness so the hardware
      // doesn't sit at the dimmed value until something else writes to LEDs.
      if (!enabled) {
        try {
          await this.sendLedBrightness(dayBrightness)
        }
        catch (e) {
          console.warn('LED night mode: failed to restore day brightness on disable:', e)
        }
      }
      return
    }
    await this.scheduleLedNightMode(nightStartTime, nightEndTime, dayBrightness, nightBrightness)
  }

  cancelLedNightMode(): void {
    this.scheduler.cancelJob('led-night-start')
    this.scheduler.cancelJob('led-night-end')
  }

  /**
   * Upsert the daily-reboot cron job. Pass `null` (or rebootDaily=false) to cancel.
   */
  upsertRebootJob(rebootDaily: boolean, time: string | null): void {
    this.cancelRebootJob()
    if (rebootDaily && time) {
      this.scheduleDailyReboot(time)
    }
  }

  cancelRebootJob(): void {
    this.scheduler.cancelJob('daily-reboot')
  }

  /**
   * Upsert the daily-prime cron group: priming, pre-prime reboot, calibration.
   * All three are tied to the same primePodTime; cancel/reschedule together.
   */
  upsertPrimeJob(primePodDaily: boolean, time: string | null): void {
    this.cancelPrimeJob()
    if (primePodDaily && time) {
      this.scheduleDailyPriming(time)
      this.schedulePrimePreReboot(time)
      this.schedulePrePrimeCalibration(time)
    }
  }

  cancelPrimeJob(): void {
    this.scheduler.cancelJob('daily-prime')
    this.scheduler.cancelJob('prime-prereboot')
    this.scheduler.cancelJob('pre-prime-calibration')
  }

  /**
   * Upsert away-mode one-time jobs for a side. Cancels both `away-start-${side}`
   * and `away-return-${side}` first, then reschedules only the ones with a
   * non-null incoming time. The explicit pre-cancel is required because the
   * new schedule may set just one side of the pair, and `scheduleAwayMode`
   * only registers the ones that are present — without the pre-cancel, the
   * stale half would survive.
   */
  upsertAwayMode(side: 'left' | 'right', awayStart: string | null, awayReturn: string | null): void {
    this.scheduler.cancelJob(`away-start-${side}`)
    this.scheduler.cancelJob(`away-return-${side}`)
    if (awayStart || awayReturn) {
      this.scheduleAwayMode(side, awayStart, awayReturn)
    }
  }

  /**
   * Reload all schedules (useful after database changes).
   *
   * Uses a dirty-flag mutex so concurrent reload requests never drop DB
   * changes. Naive coalescing (second caller awaits first and returns) is
   * unsafe: caller A may have snapshotted the DB before caller B's write
   * committed, so B's changes would be missed. Instead, if another reload
   * is requested while one is in flight, we set a pending flag and the
   * in-flight cycle loops to perform one more pass. All overlapping callers
   * await the same final promise, so they all observe the latest DB state.
   *
   * Routes that mutate a single schedule should use the incremental
   * `upsert*Job` / `cancel*Job` helpers above instead — a full reload that
   * lands inside a job's fire window drops the just-fired occurrence.
   * Only the heartbeat liveness recovery and drift detection in
   * health.ts still call this.
   */
  async reloadSchedules(): Promise<void> {
    if (this.reloadInProgress) {
      this.reloadPending = true
      await this.reloadInProgress
      return
    }

    this.reloadInProgress = (async () => {
      try {
        do {
          this.reloadPending = false
          this.scheduler.cancelRecurringJobs()
          await this.loadSchedules()
        } while (this.reloadPending)
      }
      finally {
        this.reloadInProgress = null
      }
    })()

    await this.reloadInProgress
  }

  /**
   * Update timezone
   */
  async updateTimezone(timezone: string): Promise<void> {
    this.scheduler.updateConfig({ timezone })
    await this.reloadSchedules()
  }

  /**
   * Get scheduler instance
   */
  getScheduler(): Scheduler {
    return this.scheduler
  }

  // ---------------------------------------------------------------------------
  // Run-once sessions — one-off curve application
  // ---------------------------------------------------------------------------

  /**
   * Check if a run-once session is active for a given side.
   */
  async hasActiveRunOnceSession(side: 'left' | 'right'): Promise<boolean> {
    const [session] = await db
      .select({ id: runOnceSessions.id })
      .from(runOnceSessions)
      .where(and(
        eq(runOnceSessions.side, side),
        eq(runOnceSessions.status, 'active'),
        gt(runOnceSessions.expiresAt, new Date()),
      ))
      .limit(1)
    return !!session
  }

  /**
   * Schedule a run-once session: Date-based jobs for each set point + cleanup at wake time.
   */
  scheduleRunOnceSession(
    sessionId: number,
    side: 'left' | 'right',
    setPoints: Array<{ time: string, temperature: number }>,
    wakeTime: string,
    timezone: string,
  ): void {
    const now = new Date()

    for (let i = 0; i < setPoints.length; i++) {
      const sp = setPoints[i]
      const fireDate = timeToDate(sp.time, timezone, now)

      // Skip set points that are already in the past
      if (fireDate <= now) continue

      this.scheduler.scheduleOneTimeJob(
        `runonce-${sessionId}-${i}`,
        JobType.RUN_ONCE,
        fireDate,
        async () => {
          await withSideLock(side, async () => {
            markSideMutated(side)
            const client = getSharedHardwareClient()
            await client.connect()
            await client.setTemperature(side, sp.temperature)
            broadcastMutationStatus(side, {
              targetTemperature: sp.temperature,
              targetLevel: fahrenheitToLevel(sp.temperature),
            })
          })
        },
        { sessionId, side, index: i, targetTemperature: sp.temperature },
      )
    }

    // Cleanup job at wake time — mark completed + power off the side
    const cleanupDate = timeToDate(wakeTime, timezone, now)
    this.scheduler.scheduleOneTimeJob(
      `runonce-cleanup-${sessionId}`,
      JobType.RUN_ONCE,
      cleanupDate,
      async () => {
        // Check if session is still active — if cancelled or replaced, bail out
        // to avoid powering off a side that a replacement session is using
        const [current] = await db
          .select({ status: runOnceSessions.status })
          .from(runOnceSessions)
          .where(eq(runOnceSessions.id, sessionId))
          .limit(1)

        if (current?.status !== 'active') {
          console.log(`Run-once cleanup ${sessionId} skipped — status is ${current?.status ?? 'missing'}`)
          return
        }

        await db
          .update(runOnceSessions)
          .set({ status: 'completed' })
          .where(eq(runOnceSessions.id, sessionId))

        await withSideLock(side, async () => {
          await this.markSideOff(side)
          try {
            const client = getSharedHardwareClient()
            await client.connect()
            await client.setPower(side, false)
            broadcastMutationStatus(side, { targetLevel: 0 })
          }
          catch (e) {
            console.warn(`[runOnce] Failed to power off ${side} at wake:`, e)
          }
        })

        console.log(`Run-once session ${sessionId} completed — ${side} powered off`)
      },
      { sessionId, side, cleanup: true },
    )
  }

  /**
   * Cancel an active run-once session for a side.
   */
  cancelRunOnceSession(side: 'left' | 'right'): void {
    for (const job of this.scheduler.getJobs()) {
      if (job.type === JobType.RUN_ONCE && job.metadata?.side === side) {
        this.scheduler.cancelJob(job.id)
      }
    }
  }

  /**
   * Restore active run-once sessions from DB after reboot.
   */
  private async loadRunOnceSessions(): Promise<void> {
    const now = new Date()

    // Mark any expired-but-still-active sessions as completed + power off
    const expired = await db
      .select()
      .from(runOnceSessions)
      .where(and(
        eq(runOnceSessions.status, 'active'),
      ))

    for (const session of expired) {
      if (session.expiresAt <= now) {
        await db.update(runOnceSessions).set({ status: 'completed' }).where(eq(runOnceSessions.id, session.id))
        try {
          const client = getSharedHardwareClient()
          await client.connect()
          await client.setPower(session.side, false)
          broadcastMutationStatus(session.side, { targetLevel: 0 })
        }
        catch { /* best effort */ }
        console.log(`Expired run-once session ${session.id} — ${session.side} powered off`)
      }
    }

    // Restore sessions that are still active and not expired
    const sessions = await db
      .select()
      .from(runOnceSessions)
      .where(and(
        eq(runOnceSessions.status, 'active'),
        gt(runOnceSessions.expiresAt, now),
      ))

    for (const session of sessions) {
      let setPoints: Array<{ time: string, temperature: number }>
      try {
        setPoints = JSON.parse(session.setPoints)
      }
      catch {
        console.warn(`[runOnce] Malformed setPoints for session ${session.id}, marking completed`)
        await db.update(runOnceSessions).set({ status: 'completed' }).where(eq(runOnceSessions.id, session.id))
        continue
      }

      const [settings] = await db.select().from(deviceSettings).limit(1)
      const timezone = settings?.timezone ?? 'America/Los_Angeles'

      // Filter out set points that already fired before the reboot
      // (use session.startedAt as anchor — any set point whose scheduled time
      // falls between startedAt and now has already been executed)
      const futurePoints = setPoints.filter((sp) => {
        const fireDate = timeToDate(sp.time, timezone, session.startedAt)
        return fireDate > now
      })

      this.scheduleRunOnceSession(
        session.id,
        session.side,
        futurePoints,
        session.wakeTime,
        timezone,
      )
      console.log(`Restored run-once session ${session.id} for ${session.side} (${futurePoints.length}/${setPoints.length} points remaining)`)
    }
  }

  /**
   * Gracefully shutdown
   */
  async shutdown(): Promise<void> {
    this.stopHeartbeat()
    this.removeEventListeners()
    await this.scheduler.shutdown()
  }
}
