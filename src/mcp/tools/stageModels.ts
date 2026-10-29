/**
 * Personal sleep-stage model tools: list a side's model library, preview a
 * model against the Watch reference, add one to the library, select it and
 * switch it on or off. Each wraps one sleepStages procedure, so the router's
 * contract and test-vector checks apply unchanged.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getCaller, jsonResult, runTool } from '@/src/mcp/caller'
import { side } from '@/src/mcp/schemas'
import { stageModelSchema } from '@/src/lib/personal-stage-model'

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

/**
 * A model must be written out in full inside the tool call, token by token.
 * Logistic models are a few kilobytes; forests from sleepypod/training are
 * about 1-2 MB, far beyond what a host can emit, so they go through REST.
 */
export const MAX_INLINE_MODEL_BYTES = 256 * 1024

const REST_UPLOAD_HINT = 'Upload larger models over REST instead: POST /api/sleep-stages/models with {"side", "model"} '
  + '(for example `jq -n --slurpfile m candidate.json \'{side:"left", model:$m[0]}\' | curl -X POST -H "Content-Type: application/json" '
  + '-d @- http://<pod>:3000/api/sleep-stages/models`), then use get_stage_models and select_stage_model here.'

const model = stageModelSchema.describe(
  'A portable stage model document (sleepypod/training model/candidate.json or the core personal-model export): '
  + `version, kind, classes, featureContract, trees or logistic weights, and testVectors. At most ${MAX_INLINE_MODEL_BYTES / 1024} KB as JSON.`,
)

function checkSize(value: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(value))
  if (bytes > MAX_INLINE_MODEL_BYTES) {
    throw new Error(`Model is ${Math.round(bytes / 1024)} KB; tool calls accept at most ${MAX_INLINE_MODEL_BYTES / 1024} KB. ${REST_UPLOAD_HINT}`)
  }
}

type Agreement = { epochs: number, accuracy: number, kappa: number | null } | null

const brief = (a: Agreement) => (a ? { epochs: a.epochs, accuracy: a.accuracy, kappa: a.kappa } : null)

export function registerStageModelTools(server: McpServer) {
  server.registerTool('get_stage_models', {
    title: 'List personal sleep-stage models',
    description:
      'List the side\'s personal stage model library, newest first: id, version, kind, upload time, training metrics, '
      + 'whether it is selected, and whether the selected model is active (staging that side\'s nights instead of the rules). '
      + 'Use the id with select_stage_model. Note the currently selected id before changing anything so the user can switch back.',
    inputSchema: { side },
    annotations: READ_ONLY,
  }, async ({ side: s }) => runTool(async () => {
    const models = await getCaller().sleepStages.listModels({ side: s })
    return jsonResult({
      side: s,
      models: models.map(m => ({ ...m, uploadedAt: new Date(m.uploadedAt).toISOString() })),
      active: models.find(m => m.active)?.id ?? null,
    })
  }))

  server.registerTool('preview_stage_model', {
    title: 'Preview a personal sleep-stage model',
    description:
      'Stage recent nights with a model and compare its agreement with the Apple Watch reference against the current rules. '
      + 'Read-only: nothing is stored or changed. Pass model to preview a candidate inline, or omit it to preview the side\'s '
      + 'selected model. Always preview before select_stage_model. Nights the model was trained on score in-sample and read '
      + 'higher than held-out results; say so when reporting. Nights without imported Watch stages have no agreement '
      + '(import them with import_apple_watch_data).',
    inputSchema: {
      side,
      nights: z.number().int().min(1).max(30).optional().describe('Most recent nights to stage, 1-30. Default 7.'),
      sleepRecordId: z.number().int().optional().describe('Preview a single sleep record instead of the most recent nights.'),
      model: model.optional(),
    },
    annotations: READ_ONLY,
  }, async ({ side: s, nights, sleepRecordId, model: candidate }) => runTool(async () => {
    if (candidate) checkSize(candidate)
    const result = await getCaller().sleepStages.previewModel({
      side: s, model: candidate, sleepRecordId, nights: sleepRecordId === undefined ? (nights ?? 7) : undefined,
    })
    return jsonResult({
      version: result.version,
      note: 'Agreement is with Apple Watch stages, which are not polysomnography. Nights the model trained on are in-sample.',
      pooled: result.pooled,
      rulesPooled: result.rulesPooled,
      nights: result.nights.map(n => ({
        sleepRecordId: n.sleepRecordId,
        enteredBedAt: new Date(n.enteredBedAt).toISOString(),
        leftBedAt: new Date(n.leftBedAt).toISOString(),
        model: brief(n.agreement),
        rules: brief(n.rulesAgreement),
      })),
    })
  }))

  server.registerTool('add_stage_model', {
    title: 'Add a personal sleep-stage model to the library',
    description:
      'Store a model in the side\'s library. It is not selected and does not stage any night until select_stage_model. '
      + 'The pod refuses models whose feature contract it does not know or that do not reproduce their own test vectors. '
      + 'Adding the same model twice returns the existing id. Run preview_stage_model on it first. '
      + `Tool calls carry at most ${MAX_INLINE_MODEL_BYTES / 1024} KB; forests from sleepypod/training are larger. ${REST_UPLOAD_HINT}`,
    inputSchema: { side, model },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ side: s, model: candidate }) => runTool(async () => {
    checkSize(candidate)
    const stored = await getCaller().sleepStages.uploadModel({ side: s, model: candidate })
    return jsonResult({ side: s, ...stored, selected: false, next: 'Preview it, then select_stage_model with this id once the user approves.' })
  }))

  server.registerTool('select_stage_model', {
    title: 'Select a personal sleep-stage model',
    description:
      'Make a library model the side\'s model. With active: true it stages that side\'s nights from now on, changing what the '
      + 'pod and app show for every stored night; with active: false it is selected but the rules keep staging. Change one side '
      + 'at a time and only after the user explicitly approves the preview. To switch back, select the previously selected id '
      + 'again (from get_stage_models), or call set_stage_model_active with active: false to return to the rules.',
    inputSchema: {
      side,
      id: z.number().int().positive().describe('Library id from get_stage_models.'),
      active: z.boolean().describe('true to stage the side\'s nights with this model; false to select it without using it.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ side: s, id, active }) => runTool(async () => {
    const before = (await getCaller().sleepStages.listModels({ side: s })).find(m => m.selected)
    const selected = await getCaller().sleepStages.selectModel({ side: s, id, active })
    return jsonResult({
      side: s, id, ...selected,
      previous: before ? { id: before.id, version: before.version, active: before.active } : null,
    })
  }))

  server.registerTool('set_stage_model_active', {
    title: 'Turn the personal sleep-stage model on or off',
    description:
      'Switch whether the side\'s selected model stages its nights (true) or the rules do (false). Turning it off is the quick '
      + 'way back to the rules and keeps the model selected. Turning it on changes what the pod shows; do it only after the '
      + 'user explicitly approves. Fails if no valid model is selected for the side.',
    inputSchema: { side, active: z.boolean().describe('true to stage nights with the selected model; false to use the rules.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ side: s, active }) => runTool(async () => {
    const result = await getCaller().sleepStages.setModelActive({ side: s, active })
    return jsonResult({ side: s, ...result })
  }))
}
