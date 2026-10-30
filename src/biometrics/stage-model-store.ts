import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { db } from '@/src/db'
import { sideStageModels, stageModelLibrary } from '@/src/db/schema'
import { dataHash } from '@/src/biometrics/algorithms/canonical'
import { failingTestVectors, MAX_STAGE_MODEL_BYTES, stageModelContract, stageModelSchema, type StageModel } from '@/src/lib/personal-stage-model'

// Read raw JSON so one malformed stored document cannot break rules fallback or the library.
const selectionColumns = { ...getTableColumns(sideStageModels), model: sql<string>`${sideStageModels.model}` }
const libraryColumns = { ...getTableColumns(stageModelLibrary), model: sql<string>`${stageModelLibrary.model}` }

export function modelDigest(model: StageModel) {
  return dataHash(Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined)))
}

type Side = 'left' | 'right'
type Transaction = Pick<typeof db, 'select' | 'insert'>

/** Test vectors verify converter compatibility, not sleep accuracy or clinical validity. */
export function validateModel(model: StageModel) {
  if (!stageModelContract(model)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown model feature contract' })
  if (failingTestVectors(model).length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Model fails its test vectors' })
}

/** A stored document is untrusted after disk edits, schema changes or partial restoration. */
function validStoredModel(row: { model: unknown, modelHash: string } | undefined): StageModel | null {
  if (!row) return null
  let document = row.model
  if (typeof document === 'string') {
    if (Buffer.byteLength(document) > MAX_STAGE_MODEL_BYTES) return null
    try {
      document = JSON.parse(document)
    }
    catch { return null }
  }
  const parsed = stageModelSchema.safeParse(document)
  if (!parsed.success) return null
  try {
    validateModel(parsed.data)
    return modelDigest(parsed.data) === row.modelHash ? parsed.data : null
  }
  catch { return null }
}

function saveLibraryModel(transaction: Transaction, side: Side, model: StageModel, uploadedAt: Date) {
  const modelHash = modelDigest(model)
  const existing = transaction.select({ id: stageModelLibrary.id }).from(stageModelLibrary)
    .where(and(eq(stageModelLibrary.side, side), eq(stageModelLibrary.modelHash, modelHash))).get()
  if (existing) return existing.id
  return transaction.insert(stageModelLibrary).values({ side, model, modelHash, version: model.version, uploadedAt })
    .returning({ id: stageModelLibrary.id }).get().id
}

export function getStoredStageModel(side: Side) {
  const row = db.select(selectionColumns).from(sideStageModels).where(eq(sideStageModels.side, side)).get()
  const model = validStoredModel(row)
  return { model, uploadedAt: model && row ? row.uploadedAt.getTime() : null, active: !!model && !!row?.active,
    modelHash: model && row ? row.modelHash : null }
}

export function loadActiveStageModel(side: Side): StageModel | null {
  const stored = getStoredStageModel(side)
  return stored.active ? stored.model : null
}

export function listStageModels(side: Side) {
  const selected = getStoredStageModel(side)
  return db.select(libraryColumns).from(stageModelLibrary).where(eq(stageModelLibrary.side, side))
    .orderBy(desc(stageModelLibrary.id)).all().flatMap((row) => {
      const model = validStoredModel(row)
      if (!model) return []
      const isSelected = row.modelHash === selected.modelHash
      return [{ id: row.id, version: model.version, kind: model.kind, uploadedAt: row.uploadedAt.getTime(),
        modelHash: row.modelHash, metrics: model.metrics, selected: isSelected, active: isSelected && selected.active }]
    })
}

/** Resolve a library candidate for preview without changing the selected model. */
export function getLibraryStageModel(side: Side, id: number) {
  const row = db.select(libraryColumns).from(stageModelLibrary)
    .where(and(eq(stageModelLibrary.id, id), eq(stageModelLibrary.side, side))).get()
  const model = validStoredModel(row)
  if (!model) throw new TRPCError({ code: 'NOT_FOUND', message: 'Valid model not found for this side' })
  return model
}

export function uploadStageModel(side: Side, model: StageModel) {
  validateModel(model)
  const id = db.transaction(transaction => saveLibraryModel(transaction, side, model, new Date()), { behavior: 'immediate' })
  return { id, version: model.version }
}

/** Selection is atomic and side-scoped. Activation is always an explicit input. */
export function selectStageModel(side: Side, id: number, active: boolean) {
  return db.transaction((transaction) => {
    const row = transaction.select(libraryColumns).from(stageModelLibrary)
      .where(and(eq(stageModelLibrary.id, id), eq(stageModelLibrary.side, side))).get()
    const model = validStoredModel(row)
    if (!row || !model) throw new TRPCError({ code: 'NOT_FOUND', message: 'Valid model not found for this side' })
    const values = { model, modelHash: row.modelHash, version: model.version, uploadedAt: row.uploadedAt, active }
    transaction.insert(sideStageModels).values({ side, ...values })
      .onConflictDoUpdate({ target: sideStageModels.side, set: values }).run()
    return { version: model.version, active }
  }, { behavior: 'immediate' })
}

export function activateStageModel(side: Side, active: boolean) {
  return db.transaction((transaction) => {
    const row = transaction.select(selectionColumns).from(sideStageModels).where(eq(sideStageModels.side, side)).get()
    const model = validStoredModel(row)
    if (active && !model) throw new TRPCError({ code: 'NOT_FOUND', message: `No valid personal stage model stored for ${side}` })
    // Disabling also clears a corrupt row's persisted flag.
    transaction.update(sideStageModels).set({ active }).where(eq(sideStageModels.side, side)).run()
    return { active, version: model?.version ?? null }
  }, { behavior: 'immediate' })
}

/** Legacy PUT selects an upload in preview only, even if the old selection was active. */
export function setStageModel(side: Side, model: StageModel | null) {
  if (model) validateModel(model)
  return db.transaction((transaction) => {
    if (!model) {
      transaction.delete(sideStageModels).where(eq(sideStageModels.side, side)).run()
      return { stored: false, version: null }
    }
    saveLibraryModel(transaction, side, model, new Date())
    const values = { model, modelHash: modelDigest(model), version: model.version, uploadedAt: new Date(), active: false }
    transaction.insert(sideStageModels).values({ side, ...values })
      .onConflictDoUpdate({ target: sideStageModels.side, set: values }).run()
    return { stored: true, version: model.version }
  }, { behavior: 'immediate' })
}
