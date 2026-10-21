import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PersonalModelCard } from '../PersonalModelCard'

const mock = vi.hoisted(() => ({
  upload: vi.fn(), select: vi.fn(), active: vi.fn(), invalidate: vi.fn(),
  models: [] as { id: number, version: string, kind: string, selected: boolean, active: boolean }[],
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ sleepStages: { getModel: { invalidate: mock.invalidate }, listModels: { invalidate: mock.invalidate } }, biometrics: { getSleepStages: { invalidate: mock.invalidate } } }),
  sleepStages: {
    getModel: { useQuery: () => ({ data: { model: null, active: false } }) },
    listModels: { useQuery: () => ({ data: mock.models }) },
    uploadModel: { useMutation: () => ({ mutateAsync: mock.upload }) },
    selectModel: { useMutation: () => ({ mutate: mock.select }) },
    setModelActive: { useMutation: () => ({ mutate: mock.active }) },
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
  fireEvent.change(screen.getByLabelText('Upload model JSON'), { target: { files: [file] } })
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.models = []
  mock.upload.mockResolvedValue({ id: 1, version: 'example' })
})
afterEach(cleanup)

it('offers upload with no existing model, saves the JSON for the correct side without activating it', async () => {
  render(<PersonalModelCard side="right" />)
  choose(JSON.stringify(model))
  await waitFor(() => expect(mock.upload).toHaveBeenCalledWith({ side: 'right', model: { ...model, epochSeconds: 300 } }))
  expect(mock.select).not.toHaveBeenCalled()
  expect(mock.active).not.toHaveBeenCalled()
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
  fireEvent.change(screen.getByLabelText('Saved models'), { target: { value: '2' } })
  expect(mock.select).not.toHaveBeenCalled()
  expect(screen.getByText('two').tagName).toBe('CODE')
  fireEvent.click(screen.getByRole('button', { name: 'Use this model' }))
  expect(mock.select).toHaveBeenCalledWith({ side: 'left', id: 2, active: true })
})
