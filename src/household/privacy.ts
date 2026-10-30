import Database from 'better-sqlite3'
/** Owner diagnostics must not turn a whole-database download into a partner-data export. */
export function householdBackupRestricted(path: string): boolean {
  if (process.env.SLEEPYPOD_HOUSEHOLD_PREPARATION === '1')
    return true
  let database: Database.Database | undefined
  try {
    database = new Database(path, { readonly: true, fileMustExist: true })
    const present = database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'household_accounts\'').get()
    return present !== undefined && database.prepare('SELECT id FROM household_accounts LIMIT 1').get() !== undefined
  }
  catch {
    return true
  }
  finally {
    database?.close()
  }
}
