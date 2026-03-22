import { Scheduler } from './scheduler'
import { JobType } from './types'
import { db } from '@/src/db'
import {
  temperatureSchedules,
  powerSchedules,
  alarmSchedules,
  deviceSettings,
} from '@/src/db/schema'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { fahrenheitToLevel } from '@/src/hardware/types'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'

/**
 * Job manager - orchestrates all scheduled tasks
 */
export class JobManager {
  private scheduler: Scheduler
  private reloadInProgress: Promise<void> | null = null

  constructor(timezone: string) {
    this.scheduler = new Scheduler({
      timezone,
      enabled: true,
    })

    this.setupEventListeners()
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

  private onJobScheduled = (job: { id: string, type: string }) => {
    console.log(`Job scheduled: ${job.id} [${job.type}]`)
  }

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

    // Load temperature schedules
    const tempSchedules = await db.select().from(temperatureSchedules)
    for (const sched of tempSchedules) {
      if (sched.enabled) {
        this.scheduleTemperature(sched)
      }
    }

    // Load power schedules
    const powSchedules = await db.select().from(powerSchedules)
    for (const sched of powSchedules) {
      if (sched.enabled) {
        this.schedulePowerOn(sched)
        this.schedulePowerOff(sched)
      }
    }

    // Load alarm schedules
    const almSchedules = await db.select().from(alarmSchedules)
    for (const sched of almSchedules) {
      if (sched.enabled) {
        this.scheduleAlarm(sched)
      }
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
    }

    console.log(`Loaded ${this.scheduler.getJobs().length} scheduled jobs`)
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
      async () => {
        const client = getSharedHardwareClient()
        await client.connect()
        try {
          await client.setTemperature(sched.side, sched.temperature)
          broadcastMutationStatus(sched.side, {
            targetTemperature: sched.temperature,
            targetLevel: fahrenheitToLevel(sched.temperature),
          })
        }
        finally {
          // shared client — don't disconnect
        }
      },
      { scheduleId: sched.id, side: sched.side }
    )
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
      async () => {
        const client = getSharedHardwareClient()
        await client.connect()
        try {
          await client.setPower(sched.side, true, sched.onTemperature)
          const onTemp = sched.onTemperature ?? 75
          broadcastMutationStatus(sched.side, {
            targetTemperature: onTemp,
            targetLevel: fahrenheitToLevel(onTemp),
          })
        }
        finally {
          // shared client — don't disconnect
        }
      },
      { scheduleId: sched.id, side: sched.side }
    )
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
      async () => {
        const client = getSharedHardwareClient()
        await client.connect()
        try {
          await client.setPower(sched.side, false)
          broadcastMutationStatus(sched.side, { targetLevel: 0 })
        }
        finally {
          // shared client — don't disconnect
        }
      },
      { scheduleId: sched.id, side: sched.side }
    )
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
      async () => {
        const client = getSharedHardwareClient()
        await client.connect()
        try {
          // Set alarm temperature first
          await client.setTemperature(sched.side, sched.alarmTemperature)

          // Trigger alarm
          await client.setAlarm(sched.side, {
            vibrationIntensity: sched.vibrationIntensity,
            vibrationPattern: sched.vibrationPattern,
            duration: sched.duration,
          })
          broadcastMutationStatus(sched.side, {
            targetTemperature: sched.alarmTemperature,
            targetLevel: fahrenheitToLevel(sched.alarmTemperature),
            isAlarmVibrating: true,
          })
        }
        finally {
          // shared client — don't disconnect
        }
      },
      { scheduleId: sched.id, side: sched.side }
    )
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

  /**
   * Reload all schedules (useful after database changes).
   * Uses a mutex to prevent concurrent reloads which could cause race conditions.
   */
  async reloadSchedules(): Promise<void> {
    // If a reload is already in progress, wait for it to complete
    if (this.reloadInProgress) {
      await this.reloadInProgress
      return
    }

    // Set the mutex and perform the reload
    this.reloadInProgress = (async () => {
      try {
        this.scheduler.cancelAllJobs()
        await this.loadSchedules()
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

  /**
   * Gracefully shutdown
   */
  async shutdown(): Promise<void> {
    this.removeEventListeners()
    await this.scheduler.shutdown()
  }
}
