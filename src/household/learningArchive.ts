import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { householdIdSchema } from './contract'
import { HouseholdError } from './store'
import { learningArchiveBindingSchema, learningArchiveLimits, learningArchiveRecordSchema, learningArchiveSources,
  type LearningArchiveBinding, type LearningArchiveRecord } from './learningArchiveContract'

const learningDigest = (value: string) => createHash('sha256').update(value).digest('hex')
const learningArchiveUnavailable = () => new HouseholdError('not_ready', 409,
  'Private learning could not be preserved or verified. Review the archive before completing the arrangement.')
const learningArchiveTooLarge = () => new HouseholdError('not_ready', 409,
  'Private learning exceeds the archive limit. Preserve and review the existing history before changing the arrangement.')
const learningRecordHash = (record: Omit<LearningArchiveRecord, 'payload' | 'redaction' | 'record_hash'>) =>
  learningDigest(JSON.stringify([record.id, record.operation_id, record.ordinal, record.source_table,
    record.source_key, record.source_side, record.kind, record.payload_bytes, record.payload_hash]))

const manifestSchema = z.object({
  operation_id: householdIdSchema, household_id: householdIdSchema, account_id: householdIdSchema, sleeper_id: householdIdSchema,
  dataset_id: householdIdSchema, epoch_id: householdIdSchema, captured_at: z.number().int().positive(),
  binding: z.string().max(8192), source_schemas: z.string().max(128 * 1024),
  record_count: z.number().int().nonnegative().max(learningArchiveLimits.records),
  payload_bytes: z.number().int().nonnegative().max(learningArchiveLimits.totalBytes),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`
const literal = (value: string) => `'${value.replaceAll('\'', '\'\'')}'`

/** The fixed allowlist excludes credentials. SQLite constructs JSON so large integer IDs are not rounded by JS. */
function sourceStatements(database: Database.Database) {
  return learningArchiveSources.map((source) => {
    const columns = database.prepare(`PRAGMA table_info(${identifier(source.table)})`).all() as { name: string, type: string, notnull: number, pk: number }[]
    if (!columns.length || columns.some(column => !['TEXT', 'INTEGER', 'REAL'].includes(column.type.toUpperCase()))
      || !['side', ...source.key].every(key => columns.some(column => column.name === key))) throw learningArchiveUnavailable()
    const fields = columns.flatMap(column => [literal(column.name), identifier(column.name)]).join(', ')
    const sourceBytes = columns.map(column => `coalesce(length(CAST(${identifier(column.name)} AS BLOB)), 0)`).join(' + ')
    const keys = source.key.map(identifier).join(', ')
    const selection = `SELECT rowid, side,
      json_array(${keys}) AS source_key, CASE WHEN ${sourceBytes} > ${learningArchiveLimits.recordBytes}
      THEN NULL ELSE json_object(${fields}) END AS payload FROM ${identifier(source.table)}`
    return { source, schema: { table: source.table, columns },
      first: database.prepare(`${selection} ORDER BY rowid LIMIT 1`).safeIntegers(),
      next: database.prepare(`${selection} WHERE rowid > ? ORDER BY rowid LIMIT 1`).safeIntegers() }
  })
}

function assertBinding(database: Database.Database, binding: LearningArchiveBinding) {
  const row = database.prepare(`SELECT transition.household_id, transition.account_id, transition.context,
    transition.created_at, account.sleeper_id FROM household_arrangement_transitions transition
    JOIN household_accounts account ON account.id = transition.account_id WHERE transition.id = ?`).get(binding.operationId) as {
    household_id: string
    account_id: string
    context: string
    created_at: number
    sleeper_id: string
  } | undefined
  if (!row || row.household_id !== binding.householdId || row.account_id !== binding.accountId
    || row.sleeper_id !== binding.sleeperId || binding.capturedAt < row.created_at) throw learningArchiveUnavailable()
  const context = JSON.parse(row.context) as { history?: { datasetId?: string, epochId?: string, startsAt?: number, bindingHash?: string, epochHash?: string } }
  if (context.history?.datasetId !== binding.datasetId || context.history.epochId !== binding.epochId
    || context.history.startsAt !== binding.soloStartsAt || context.history.bindingHash !== binding.sourceBindingHash
    || context.history.epochHash !== binding.soloEpochHash) throw learningArchiveUnavailable()
}

/** Capture joins the existing FULL-durability arrangement transaction; it never opens or releases a hold. */
export function captureLearningArchive(database: Database.Database, input: LearningArchiveBinding) {
  if (!database.inTransaction) throw learningArchiveUnavailable()
  const binding = learningArchiveBindingSchema.parse(input)
  assertBinding(database, binding)
  const transition = database.prepare('SELECT state FROM household_arrangement_transitions WHERE id = ?').get(binding.operationId) as { state: string }
  if (transition.state !== 'held' || database.prepare('SELECT 1 FROM household_learning_archives WHERE operation_id = ?').get(binding.operationId))
    throw learningArchiveUnavailable()
  const statements = sourceStatements(database)
  const savedBinding = JSON.stringify(binding)
  const sourceSchemas = JSON.stringify(statements.map(value => value.schema))
  if (Buffer.byteLength(sourceSchemas) > 128 * 1024) throw learningArchiveUnavailable()
  database.prepare(`INSERT INTO household_learning_archives
    (operation_id, household_id, account_id, sleeper_id, dataset_id, epoch_id, captured_at, binding, source_schemas, record_count, payload_bytes, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`).run(binding.operationId, binding.householdId, binding.accountId, binding.sleeperId,
    binding.datasetId, binding.epochId, binding.capturedAt, savedBinding, sourceSchemas, '0'.repeat(64))
  const insert = database.prepare(`INSERT INTO household_learning_records
    (id, operation_id, ordinal, source_table, source_key, source_side, kind, payload, payload_bytes, payload_hash, record_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const content = createHash('sha256').update(JSON.stringify([savedBinding, sourceSchemas]))
  let count = 0, bytes = 0
  for (const { source, first, next } of statements) {
    interface SourceRow { rowid: bigint, side: string, source_key: string, payload: string | null }
    // Close each read before writing on the same connection; keyset reads keep memory bounded to one record.
    let raw = first.get() as SourceRow | undefined
    while (raw) {
      if (raw.payload === null) throw learningArchiveTooLarge()
      const payloadBytes = Buffer.byteLength(raw.payload)
      count += 1
      bytes += payloadBytes
      if (count > learningArchiveLimits.records || bytes > learningArchiveLimits.totalBytes || payloadBytes > learningArchiveLimits.recordBytes)
        throw learningArchiveTooLarge()
      const record = learningArchiveRecordSchema.parse({ id: randomUUID(), operation_id: binding.operationId, ordinal: count,
        source_table: source.table, source_key: raw.source_key, source_side: raw.side, kind: source.kind,
        payload: raw.payload, payload_bytes: payloadBytes, payload_hash: learningDigest(raw.payload), record_hash: '0'.repeat(64), redaction: null })
      record.record_hash = learningRecordHash(record)
      insert.run(record.id, record.operation_id, record.ordinal, record.source_table, record.source_key, record.source_side,
        record.kind, record.payload, record.payload_bytes, record.payload_hash, record.record_hash)
      content.update(record.record_hash)
      raw = next.get(raw.rowid) as SourceRow | undefined
    }
  }
  const contentHash = content.update(JSON.stringify([count, bytes])).digest('hex')
  database.prepare('UPDATE household_learning_archives SET record_count = ?, payload_bytes = ?, content_hash = ? WHERE operation_id = ?')
    .run(count, bytes, contentHash, binding.operationId)
  return { operationId: binding.operationId, recordCount: count, payloadBytes: bytes, contentHash }
}

export function verifiedLearningRecord(input: unknown, binding: LearningArchiveBinding) {
  const record = learningArchiveRecordSchema.parse(input)
  if (record.operation_id !== binding.operationId || learningRecordHash(record) !== record.record_hash
    || learningArchiveSources.find(source => source.table === record.source_table)?.kind !== record.kind) throw learningArchiveUnavailable()
  if (record.payload !== null) {
    if (record.redaction !== null || Buffer.byteLength(record.payload) !== record.payload_bytes
      || learningDigest(record.payload) !== record.payload_hash) throw learningArchiveUnavailable()
  }
  else {
    const redaction = z.object({ version: z.literal(1), requestId: householdIdSchema, accountId: householdIdSchema,
      recordId: householdIdSchema, payloadHash: z.string(), deletedAt: z.number().int().positive() }).strict().parse(JSON.parse(record.redaction ?? 'null'))
    if (redaction.accountId !== binding.accountId || redaction.recordId !== record.id || redaction.payloadHash !== record.payload_hash
      || redaction.deletedAt < binding.capturedAt) throw learningArchiveUnavailable()
  }
  return record
}

/** Validate the immutable ownership binding without loading bulk history. */
export function readLearningArchive(database: Database.Database, operationId: string) {
  householdIdSchema.parse(operationId)
  const manifest = manifestSchema.parse(database.prepare('SELECT * FROM household_learning_archives WHERE operation_id = ?').get(operationId))
  const binding = learningArchiveBindingSchema.parse(JSON.parse(manifest.binding))
  if (binding.operationId !== operationId || binding.householdId !== manifest.household_id || binding.accountId !== manifest.account_id
    || binding.sleeperId !== manifest.sleeper_id || binding.datasetId !== manifest.dataset_id || binding.epochId !== manifest.epoch_id
    || binding.capturedAt !== manifest.captured_at) throw learningArchiveUnavailable()
  assertBinding(database, binding)
  return { manifest, binding }
}

/** Integrity covers original custody, source schemas and every original payload; redacted copies retain tombstones. */
export function verifyLearningArchive(database: Database.Database, operationId: string) {
  const { manifest, binding } = readLearningArchive(database, operationId)
  const content = createHash('sha256').update(JSON.stringify([manifest.binding, manifest.source_schemas]))
  let count = 0, bytes = 0
  for (const raw of database.prepare('SELECT * FROM household_learning_records WHERE operation_id = ? ORDER BY ordinal').iterate(operationId)) {
    const record = verifiedLearningRecord(raw, binding)
    count += 1
    bytes += record.payload_bytes
    if (record.ordinal !== count || count > manifest.record_count || bytes > manifest.payload_bytes) throw learningArchiveUnavailable()
    content.update(record.record_hash)
  }
  if (count !== manifest.record_count || bytes !== manifest.payload_bytes
    || content.update(JSON.stringify([count, bytes])).digest('hex') !== manifest.content_hash) throw learningArchiveUnavailable()
  return { binding, recordCount: count, payloadBytes: bytes, contentHash: manifest.content_hash }
}

/** Recovery fingerprints the archive without exposing its contents through maintenance status. */
export function arrangementLearningDigests(database: Database.Database, householdId: string) {
  const rows = database.prepare('SELECT operation_id FROM household_learning_archives WHERE household_id = ? ORDER BY operation_id')
    .all(householdId) as { operation_id: string }[]
  return rows.map(({ operation_id }) => {
    const archive = verifyLearningArchive(database, operation_id)
    return { operationId: operation_id, contentHash: archive.contentHash }
  })
}
