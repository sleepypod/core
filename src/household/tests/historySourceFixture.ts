import { randomUUID } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { PersonHistorySource, prepareBiometricHistoryIdentity } from '../historySource'

/** A real migrated, isolated source with an explicit review; no user database. */
export function historySourceFixture(configuration: Database.Database,
  owner: { householdId: string, accountId: string }, now: () => number, filename = ':memory:') {
  const biometrics = new Database(filename)
  migrate(drizzle(biometrics), { migrationsFolder: path.resolve('src/db/biometrics-migrations') })
  const identity = prepareBiometricHistoryIdentity(biometrics, now())
  const source = new PersonHistorySource(configuration, biometrics, now)
  const review = { householdId: owner.householdId, datasetId: identity.datasetId,
    reviewedBy: owner.accountId, reviewReceiptId: randomUUID() }
  source.bindReviewedSource(review)
  return { biometrics, source, identity, review }
}
