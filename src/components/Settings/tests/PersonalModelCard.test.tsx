import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stageModelSchema, type StageModel } from '@/src/lib/personal-stage-model'
import { PersonalModelCard } from '../PersonalModelCard'

const mock = vi.hoisted(() => ({
  upload: vi.fn(), select: vi.fn(), active: vi.fn(), invalidate: vi.fn(),
  stored: null as StageModel | null, isActive: false,
  models: [] as { id: number, version: string, kind: string, selected: boolean, active: boolean, metrics?: Record<string, unknown> }[],
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ sleepStages: { getModel: { invalidate: mock.invalidate }, listModels: { invalidate: mock.invalidate } }, biometrics: { getSleepStages: { invalidate: mock.invalidate } } }),
  sleepStages: {
    getModel: { useQuery: () => ({ data: { model: mock.stored, active: mock.isActive } }) },
    listModels: { useQuery: () => ({ data: mock.models }) },
    uploadModel: { useMutation: (options: { onSuccess: (result: { id: number }) => void }) => ({ mutateAsync: async (input: unknown) => {
      const result = await mock.upload(input)
      options.onSuccess(result)
      return result
    } }) },
    selectModel: { useMutation: (options: { onSuccess: () => void }) => ({ mutate: (input: unknown) => {
      mock.select(input)
      options.onSuccess()
    } }) },
    setModelActive: { useMutation: (options: { onSuccess: () => void }) => ({ mutate: (input: unknown) => {
      mock.active(input)
      options.onSuccess()
    } }) },
  },
} }))
const model = {
  version: 'example', kind: 'forest', classes: ['wake', 'light', 'deep', 'rem'],
  featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction'],
  trees: [{ f: [-1], t: [0], l: [-1], r: [-1], v: [[0, 1, 0, 0]] }],
  testVectors: [{ inputs: { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 0 }, expected: 1 }],
}
function choose(contents: string) {
  const file = new File([contents], 'candidate.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(contents) })
  fireEvent.change(screen.getByLabelText('Upload model'), { target: { files: [file] } })
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.models = []
  mock.stored = null
  mock.isActive = false
  mock.upload.mockResolvedValue({ id: 1, version: 'example' })
})
afterEach(cleanup)

it('offers upload with no existing model, saves the JSON for the correct side without activating it', async () => {
  render(<PersonalModelCard side="right" />)
  choose(JSON.stringify(model))
  await waitFor(() => expect(mock.upload).toHaveBeenCalledWith({ side: 'right', model: { ...model, epochSeconds: 300 } }))
  expect(mock.select).not.toHaveBeenCalled()
  expect(mock.active).not.toHaveBeenCalled()
  expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Model saved. Choose “Use this model” to activate it.')
  expect(mock.invalidate).toHaveBeenCalledWith({ side: 'right' })
})

it('rejects malformed JSON and unrelated JSON before upload', async () => {
  render(<PersonalModelCard side="left" />)
  choose('{bad')
  await screen.findByText(/not valid JSON/)
  choose('{}')
  await screen.findByText(/not a supported sleep-stage model/)
  expect(mock.upload).not.toHaveBeenCalled()
})

it('requires an explicit action after choosing a saved model', () => {
  mock.models = [
    { id: 1, version: 'one', kind: 'forest', selected: true, active: true },
    { id: 2, version: 'two', kind: 'forest', selected: false, active: false },
  ]
  render(<PersonalModelCard side="left" />)
  fireEvent.click(screen.getByRole('radio', { name: 'two' }))
  expect(mock.select).not.toHaveBeenCalled()
  expect(screen.getAllByText('two')[0].tagName).toBe('CODE')
  fireEvent.click(screen.getByRole('button', { name: 'Use this model' }))
  expect(mock.select).toHaveBeenCalledWith({ side: 'left', id: 2, active: true })
  expect(screen.getByRole('status').textContent).toBe('Model selected and active.')
})

it('previews rules without disabling the model until applied', () => {
  mock.stored = stageModelSchema.parse(model)
  mock.isActive = true
  render(<PersonalModelCard side="right" />)
  fireEvent.click(screen.getByRole('radio', { name: /Rules only/ }))
  expect(mock.active).not.toHaveBeenCalled()
  expect(screen.queryByText('Not evaluated')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Use rules only' }))
  expect(mock.active).toHaveBeenCalledWith({ side: 'right', active: false })
  expect(mock.invalidate).toHaveBeenCalledWith({ side: 'right' })
})

it('toggles the stored model and shows its evaluation when the library is empty', () => {
  mock.stored = stageModelSchema.parse({ ...model, metrics: { lono: { kappa: 0.6, nights: 12 } } })
  render(<PersonalModelCard side="left" />)
  expect(screen.getByText(/12 held-out nights/)).toBeTruthy()
  expect(screen.getByLabelText('κ 0.60')).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: 'Stage nights with this model' }))
  expect(mock.active).toHaveBeenCalledWith({ side: 'left', active: true })
})

it('does not borrow stored scores for a candidate with no evaluation', () => {
  mock.stored = stageModelSchema.parse({ ...model, metrics: { lono: { kappa: 0.6 } } })
  mock.models = [{ id: 2, version: 'unevaluated', kind: 'forest', selected: false, active: false }]
  render(<PersonalModelCard side="left" />)
  expect(screen.getByText('Not evaluated')).toBeTruthy()
  expect(screen.queryByLabelText('κ 0.60')).toBeNull()
  expect(screen.queryByRole('switch')).toBeNull()
})

it('opens the file picker from the upload button and handles a canceled selection', () => {
  render(<PersonalModelCard side="left" />)
  const input = screen.getByLabelText('Upload model')
  const click = vi.spyOn(input, 'click')
  fireEvent.click(screen.getByRole('button', { name: 'Upload model' }))
  expect(click).toHaveBeenCalledOnce()
  fireEvent.change(input, { target: { files: [] } })
  expect(mock.upload).not.toHaveBeenCalled()
})

it('rejects oversized files before reading or uploading them', async () => {
  render(<PersonalModelCard side="left" />)
  const file = new File([''], 'large.json')
  Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 + 1 })
  fireEvent.change(screen.getByLabelText('Upload model'), { target: { files: [file] } })
  expect(await screen.findByText(/smaller than 10 MB/)).toBeTruthy()
  expect(mock.upload).not.toHaveBeenCalled()
})

it.each([new Error('Upload unavailable'), 'unknown failure'])('reports upload failure and re-enables upload', async (error) => {
  mock.upload.mockRejectedValueOnce(error)
  render(<PersonalModelCard side="left" />)
  choose(JSON.stringify(model))
  expect(await screen.findByText(error instanceof Error ? error.message : 'Could not upload this model.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Upload model' }) as HTMLButtonElement).disabled).toBe(false)
})
