import { z } from 'zod'
import { stagesWithinWindow } from '@/src/lib/stage-coverage'
import { classifySleepStages, type SleepEpoch } from '@/src/lib/sleep-stages'
import { classifyWithStageModel, type StageModel } from '@/src/lib/personal-stage-model'
import type { StageRuleset } from '@/src/lib/sleep-stage-rules'
import { dataHash } from './algorithms/canonical'

export const stagedBySchema = z.object({
  engine: z.enum(['rules', 'model']), version: z.string().nullable(), modelHash: z.string().nullable(),
  reason: z.enum(['active_model', 'rules_selected', 'no_model_epochs', 'model_evaluation_failed']),
})
export type StagedBy = z.infer<typeof stagedBySchema>

/** Reclassify a view of a night; keep source identity separate from sensor/profile provenance. */
export function stageNight(
  vitalsData: Parameters<typeof classifySleepStages>[0], movementData: Parameters<typeof classifySleepStages>[1],
  calibrationQuality: number, ruleset: StageRuleset, model: StageModel | null, window: { start: Date, end: Date },
): { epochs: SleepEpoch[], stagedBy: StagedBy } {
  let reason: StagedBy['reason'] = 'rules_selected'
  if (model) {
    try {
      const epochs = stagesWithinWindow(classifyWithStageModel(model, window.start, window.end, vitalsData, movementData, ruleset), window)
      if (epochs.length > 0) return { epochs, stagedBy: { engine: 'model', version: model.version, modelHash: dataHash(Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined))), reason: 'active_model' } }
      reason = 'no_model_epochs'
    }
    catch { reason = 'model_evaluation_failed' }
  }
  return { epochs: stagesWithinWindow(classifySleepStages(vitalsData, movementData, calibrationQuality, ruleset), window),
    stagedBy: { engine: 'rules', version: null, modelHash: null, reason } }
}
