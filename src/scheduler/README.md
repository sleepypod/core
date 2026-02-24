# Job Scheduler

Automated scheduling system for pod control operations.

## Overview

The scheduler manages automated tasks including:
- **Temperature schedules** - Per-side, per-day temperature changes
- **Power schedules** - Automated on/off with custom temperatures
- **Alarm schedules** - Wake-up vibrations with temperature control
- **Daily priming** - Automated maintenance
- **Daily reboots** - System restarts

All schedules are timezone-aware and automatically reload when database changes occur.

## Architecture

### Components

1. **Scheduler** (`scheduler.ts`) - Low-level job scheduling using `node-schedule`
   - Manages cron-based job execution
   - Provides event emitters for job lifecycle
   - Handles timezone configuration

2. **JobManager** (`jobManager.ts`) - High-level orchestration
   - Loads schedules from database
   - Integrates with hardware abstraction layer
   - Manages schedule reloads

3. **Instance** (`instance.ts`) - Global singleton
   - Ensures only one scheduler runs
   - Initialized on app startup
   - Handles graceful shutdown

## Usage

### Accessing the Scheduler

```typescript
import { getJobManager } from '@/src/scheduler'

// Get the global instance
const jobManager = await getJobManager()
const scheduler = jobManager.getScheduler()

// Check scheduled jobs
const jobs = scheduler.getJobs()
console.log(`${jobs.length} jobs scheduled`)
```

### Automatic Integration

The scheduler automatically integrates with tRPC routers:

- **Schedule mutations** - All create/update/delete operations trigger `reloadSchedules()`
- **Settings changes** - Timezone, priming, and reboot settings trigger reload
- **Startup** - Loads all schedules on app initialization

### Health Monitoring

Check scheduler health via the health router:

```typescript
// Via tRPC
const health = await trpc.health.scheduler.query()

console.log('Scheduler enabled:', health.enabled)
console.log('Total jobs:', health.jobCounts.total)
console.log('Next 10 jobs:', health.upcomingJobs)
```

## Database Integration

The scheduler reads from these tables:
- `temperatureSchedules` - Temperature change schedules
- `powerSchedules` - Power on/off schedules
- `alarmSchedules` - Alarm schedules
- `deviceSettings` - Priming and reboot configuration

When schedules are modified via tRPC, the scheduler automatically reloads.

## Timezone Support

The scheduler respects the system timezone from `deviceSettings.timezone`:

```typescript
// Update timezone (triggers automatic reload)
await jobManager.updateTimezone('America/New_York')
```

All scheduled times are interpreted in the configured timezone.

## Event Monitoring

The scheduler emits events for monitoring:

```typescript
scheduler.on('jobScheduled', (job) => {
  console.log(`Job scheduled: ${job.id} [${job.type}]`)
})

scheduler.on('jobExecuted', (jobId, result) => {
  if (result.success) {
    console.log(`Job succeeded: ${jobId}`)
  } else {
    console.error(`Job failed: ${jobId}`, result.error)
  }
})

scheduler.on('jobError', (jobId, error) => {
  console.error(`Job error: ${jobId}`, error)
})

scheduler.on('jobCancelled', (jobId) => {
  console.log(`Job cancelled: ${jobId}`)
})
```

## Job Types

```typescript
enum JobType {
  TEMPERATURE = 'temperature',  // Temperature adjustments
  POWER_ON = 'power_on',        // Power on at scheduled time
  POWER_OFF = 'power_off',      // Power off at scheduled time
  ALARM = 'alarm',              // Wake-up alarms
  PRIME = 'prime',              // Daily priming
  REBOOT = 'reboot',            // System reboot
}
```

## Reliability

### Restart Resilience

The scheduler survives app restarts:
1. **systemd supervision** - `Restart=always` automatically restarts the app
2. **Startup initialization** - `instrumentation.ts` loads all schedules on boot
3. **Daily reboot** - System reboots daily (1 hour before priming), scheduler reloads

### Error Handling

- Job execution errors are caught and logged
- Failed jobs don't block other jobs
- Hardware client cleanup in `finally` blocks
- Scheduler reload failures don't crash mutations

### Validation

On startup, the scheduler:
- Loads all enabled schedules from database
- Logs count of scheduled jobs
- Logs next 5 upcoming jobs for visibility
- Validates cron expressions (implicit via `node-schedule`)

## Testing

Run scheduler tests:

```bash
pnpm test scheduler
```

Test files:
- `scheduler.test.ts` - Core scheduler functionality
- `jobManager.test.ts` - Job manager and database integration
- `instance.test.ts` - Singleton instance management

## Implementation Notes

### Why In-Memory?

The scheduler runs in-memory (not as a separate daemon) because:
1. **Daily reboot** - System already reboots daily by design
2. **systemd supervision** - Automatic restart on crashes
3. **Minimal overhead** - No separate process = less RAM/CPU
4. **Simple deployment** - One service to manage
5. **Fast recovery** - Reloads all schedules from DB on startup

### Cron Expression Format

Weekly schedules use standard cron format:
```
{minute} {hour} * * {dayOfWeek}
```

Examples:
- `30 7 * * 1` - Mondays at 7:30 AM
- `0 22 * * 5` - Fridays at 10:00 PM

### Hardware Integration

Each scheduled job:
1. Creates a hardware client
2. Executes the command
3. Disconnects the client (in `finally`)

This ensures cleanup even on errors.

## Future Improvements

Potential enhancements:
- [ ] Persist job execution history to database
- [ ] Add job execution metrics/statistics
- [ ] Support for more complex recurring patterns
- [ ] Job dependencies (job X must complete before job Y)
- [ ] Manual job triggering via API
