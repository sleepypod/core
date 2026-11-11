import { expect, it } from 'vitest'
import { responseModelStatusSchema, responseModelPreviewSchema } from '../response-model-contract'
import { responsePresentationFixture } from './responsePresentationFixture'

it.each(['missing-horizon', 'repeated-horizon', 'wrong-side', 'partial-fit', 'partial-current', 'mixed-read'])(
  'rejects inconsistent model presentation: %s', (failure) => {
    const status = responsePresentationFixture(Date.now())
    if (!status.model) throw new Error('Expected fixture model')
    if (failure === 'missing-horizon') status.model.horizons.pop()
    if (failure === 'repeated-horizon') status.model.horizons[1].minutes = 15
    if (failure === 'wrong-side') status.model.side = 'right'
    if (failure === 'partial-fit' || failure === 'partial-current') status.evidence.status = 'partial'
    if (failure === 'partial-current') status.canTrain = false
    if (failure === 'mixed-read') status.evidence.datasetHash = 'd'.repeat(64)
    expect(responseModelStatusSchema.safeParse(status).success).toBe(false)
  })

it('rejects incomplete or inverted prediction ranges rather than presenting a passing preview', () => {
  const preview = { apiVersion: 1, side: 'left', generatedAt: Date.now(), activationAvailable: false, reason: 'Fixture',
    candidates: [{ targetF: 69, reason: 'Fixture', predictions: [{ minutes: 15, waterF: 70, lowerF: 69, upperF: 71 }] }] }
  expect(responseModelPreviewSchema.safeParse(preview).success).toBe(false)
  preview.candidates[0].predictions.push({ minutes: 30, waterF: 70, lowerF: 71, upperF: 69 })
  expect(responseModelPreviewSchema.safeParse(preview).success).toBe(false)
})
