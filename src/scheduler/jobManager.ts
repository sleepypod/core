import { Scheduler } from './scheduler'
import { JobType } from './types'
import { db } from '@/src/db'
import {
  temperatureSchedules,
  powerSchedules,
  alarmSchedules,
  deviceSettings,
} from '@/src/db/schema'
import { eq } from 'drizzle-orm'
import { createHardwareClient } from '@/src/hardware'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/run/dac.sock'

/**
 * Job manager - orchestrates all scheduled tasks
 */
export class JobManager {
  private scheduler: Scheduler

  constructor(timezone: string) {
    this.scheduler = new Scheduler({
      timezone,
      enabled: true,
    })

    this.setupEventListeners()
  }

  /**
   * Setup event listeners for job lifecycle
   */
  private setupEventListeners(): void {
    this.scheduler.on('jobScheduled', (job) => {
      console.log(`Job scheduled: ${job.id} [${job.type}]`)
    })

    this.scheduler.on('jobExecuted', (jobId, result) => {
      if (result.success) {
        console.log(`Job executed successfully: ${jobId}`)
      } else {
        console.error(`Job execution failed: ${jobId}`, result.error)
      }
    })

    this.scheduler.on('jobError', (jobId, error) => {
      console.error(`Job error: ${jobId}`, error)
    })
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
    const [hour, minute] = sched.time.split(':').map(Number)
    const cron = this.buildWeeklyCron(sched.dayOfWeek, hour, minute)

    this.scheduler.scheduleJob(
      `temp-${sched.id}`,
      JobType.TEMPERATURE,
      cron,
      async () => {
        const client = await createHardwareClient({ socketPath: DAC_SOCK_PATH })
        try {
          await client.setTemperature(sched.side, sched.temperature)
        } finally {
          client.disconnect()
        }
      },
      { scheduleId: sched.id, side: sched.side }
    )
  }

  /**
   * Schedule power on
   */
  private schedulePowerOn(sched: typeof powerSchedules.$inferSelect): void {
    const [hour, minute] = sched.onTime.split(':').map(Number)
    const cron = this.buildWeeklyCron(sched.dayOfWeek, hour, minute)

    this.scheduler.scheduleJob(
      `power-on-${sched.id}`,
      JobType.POWER_ON,
      cron,
      async () => {
        const client = await createHardwareClient({ socketPath: DAC_SOCK_PATH })
        try {
          await client.setPower(sched.side, true, sched.onTemperature)
        } finally {
          client.disconnect()
        }
      },
      { scheduleId: sched.id, side: sched.side }
    )
  }

  /**
   * Schedule power off
   */
  private schedulePowerOff(sched: typeof powerSchedules.$inferSelect): void {
    const [hour, minute] = sched.offTime.split(':').map(Number)
    const cron = this.buildWeeklyCron(sched.dayOfWeek, hour, minute)

    this.scheduler.scheduleJob(
      `power-off-${sched.id}`,
      JobType.POWER_OFF,
      cron,
      async () => {
        const client = await createHardwareClient({ socketPath: DAC_SOCK_PATH })
        try {
          await client.setPower(sched.side, false)
        } finally {
          client.disconnect()
        }
      },
      { scheduleId: sched.id, side: sched.side }
    )
  }

  /**
   * Schedule an alarm
   */
  private scheduleAlarm(sched: typeof alarmSchedules.$inferSelect): void {
    const [hour, minute] = sched.time.split(':').map(Number)
    const cron = this.buildWeeklyCron(sched.dayOfWeek, hour, minute)

    this.scheduler.scheduleJob(
      `alarm-${sched.id}`,
      JobType.ALARM,
      cron,
      async () => {
        const client = await createHardwareClient({ socketPath: DAC_SOCK_PATH })
        try {
          // Set alarm temperature first
          await client.setTemperature(sched.side, sched.alarmTemperature)

          // Trigger alarm
          await client.setAlarm(sched.side, {
            vibrationIntensity: sched.vibrationIntensity,
            vibrationPattern: sched.vibrationPattern,
            duration: sched.duration,
          })
        } finally {
          client.disconnect()
        }
      },
      { scheduleId: sched.id, side: sched.side }
    )
  }

  /**
   * Schedule daily priming
   */
  private scheduleDailyPriming(time: string): void {
    const [hour, minute] = time.split(':').map(Number)
    const cron = `${minute} ${hour} * * *` // Every day at specified time

    this.scheduler.scheduleJob('daily-prime', JobType.PRIME, cron, async () => {
      const client = await createHardwareClient({ socketPath: DAC_SOCK_PATH })
      try {
        await client.startPriming()
      } finally {
        client.disconnect()
      }
    })
  }

  /**
   * Schedule daily reboot
   */
  private scheduleDailyReboot(time: string): void {
    const [hour, minute] = time.split(':').map(Number)
    const cron = `${minute} ${hour} * * *` // Every day at specified time

    this.scheduler.scheduleJob('daily-reboot', JobType.REBOOT, cron, async () => {
      console.log('Executing daily system reboot...')
      // On actual pod, this would execute: exec('reboot')
      // For safety, we just log it here
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
   * Reload all schedules (useful after database changes)
   */
  async reloadSchedules(): Promise<void> {
    this.scheduler.cancelAllJobs()
    await this.loadSchedules()
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
    await this.scheduler.shutdown()
  }
}
