import type Database from 'better-sqlite3'
import { PersonalHistoryIngestion, historyIngestionTargetSchema } from './historyIngestion'
import { PersonHistorySource } from './historySource'
import { PersonHistoryStore } from './personHistory'
import { PresenceHistoryImporter } from './presenceHistoryImporter'
import { HouseholdStore } from './store'

/** Existing reviewed metadata is the only source of identity. Startup never
 * prepares a dataset, binds an owner or creates an attribution interval. */
export function readHistoryIngestionTarget(database: Database.Database) {
  const rows = database.prepare(`SELECT source.household_id AS householdId,
    source.dataset_id AS datasetId, source.review_receipt_id AS reviewReceiptId
    FROM household_history_sources source JOIN households household ON household.id = source.household_id
    WHERE EXISTS (SELECT 1 FROM household_attribution_epochs epoch
      WHERE epoch.household_id = source.household_id AND epoch.dataset_id = source.dataset_id AND epoch.revoked_at IS NULL)
    LIMIT 2`).all()
  if (rows.length > 1) throw new Error('Ambiguous reviewed history source')
  return rows.length === 0 ? null : historyIngestionTargetSchema.parse(rows[0])
}

const shared = globalThis as typeof globalThis & { __sleepypodHistoryIngestion?: PersonalHistoryIngestion }

export function startPersonalHistoryIngestion(configuration: Database.Database, biometrics: Database.Database): void {
  if (shared.__sleepypodHistoryIngestion) return
  const source = new PersonHistorySource(configuration, biometrics)
  const history = new PersonHistoryStore(configuration, new HouseholdStore(configuration), source)
  const importer = new PresenceHistoryImporter(biometrics, source, history)
  const service = new PersonalHistoryIngestion({
    enabled: () => process.env.SLEEPYPOD_HOUSEHOLD_PREPARATION === '1' && process.env.SLEEPYPOD_PERSONAL_HISTORY === '1',
    target: () => readHistoryIngestionTarget(configuration),
    scan: input => importer.scan(input),
  })
  shared.__sleepypodHistoryIngestion = service
  service.start()
}

export function stopPersonalHistoryIngestion(): void {
  shared.__sleepypodHistoryIngestion?.stop()
  delete shared.__sleepypodHistoryIngestion
}

export function personalHistoryIngestionStatus() {
  return shared.__sleepypodHistoryIngestion?.status() ?? null
}
