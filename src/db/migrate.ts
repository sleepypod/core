import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db, sqlite } from './index'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Run pending database migrations.
 * This should be called on server startup.
 */
export async function runMigrations() {
  try {
    console.log('Running database migrations...')

    migrate(db, {
      migrationsFolder: path.resolve(__dirname, 'migrations'),
    })

    console.log('✓ Database migrations completed successfully')
  }
  catch (error) {
    console.error('✗ Database migration failed:', error)
    throw error
  }
}

/**
 * Initialize database with default data if tables are empty.
 */
export async function seedDefaultData() {
  try {
    const { deviceSettings, sideSettings, deviceState } = await import('./schema')

    // Check if device settings exist
    const existingSettings = await db.select().from(deviceSettings).limit(1)

    if (existingSettings.length === 0) {
      console.log('Seeding default device settings...')

      // Wrap all inserts in a transaction for atomicity
      // Note: better-sqlite3 transactions are synchronous — cannot use async/await
      db.transaction((tx) => {
        // Insert default device settings
        tx.insert(deviceSettings).values({
          id: 1,
          timezone: 'America/Los_Angeles',
          temperatureUnit: 'F',
          rebootDaily: false,
          primePodDaily: false,
        }).run()

        // Insert default side settings
        tx.insert(sideSettings).values([
          { side: 'left', name: 'Left', awayMode: false },
          { side: 'right', name: 'Right', awayMode: false },
        ]).run()

        // Insert default device state
        tx.insert(deviceState).values([
          {
            side: 'left',
            isPowered: false,
            isAlarmVibrating: false,
          },
          {
            side: 'right',
            isPowered: false,
            isAlarmVibrating: false,
          },
        ]).run()
      })

      console.log('✓ Default data seeded successfully')
    }
  }
  catch (error) {
    console.error('✗ Failed to seed default data:', error)
    throw error
  }
}

// Run migrations if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => seedDefaultData())
    .then(() => {
      console.log('✓ Database setup complete')
      sqlite.close()
      process.exit(0)
    })
    .catch((error) => {
      console.error('✗ Database setup failed:', error)
      sqlite.close()
      process.exit(1)
    })
}
