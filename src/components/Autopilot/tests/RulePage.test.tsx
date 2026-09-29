import { requiredTemplate } from './builderFixtures'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RulePage } from '../RulePage'
import { toAST } from '../builderModel'

const m = vi.hoisted(() => ({
  push: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  get: { data: undefined as unknown, isLoading: false, error: null as null | { message: string } },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: m.push }),
  usePathname: () => '/en/autopilot/7',
}))
vi.mock('@/src/utils/trpc', () => {
  const mutation = (fn: typeof m.create) => ({
    useMutation: (opts: { onSuccess: () => void }) => ({
      mutate: (v: unknown) => {
        fn(v)
        opts.onSuccess()
      },
      isPending: false,
      error: null,
    }),
  })
  return {
    trpc: {
      useUtils: () => ({ automations: { list: { invalidate: vi.fn() }, status: { invalidate: vi.fn() } } }),
      automations: {
        get: { useQuery: () => m.get },
        create: mutation(m.create),
        update: mutation(m.update),
      },
    },
  }
})
vi.mock('../RuleEditor', () => ({
  RuleEditor: ({ automation, onSave, onClose }: { automation: { id?: number, name: string }, onSave: (r: unknown) => void, onClose: () => void }) => (
    <div>
      <span data-testid="rule-name">{automation.name}</span>
      <button type="button" onClick={() => onSave(automation)}>Save</button>
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
  ),
}))

beforeEach(() => {
  m.push.mockReset()
  m.create.mockReset()
  m.update.mockReset()
  m.get = { data: undefined, isLoading: false, error: null }
})

describe('RulePage', () => {
  it('creates a new rule and returns to the Automations list', () => {
    render(<RulePage id="new" />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(m.create).toHaveBeenCalledOnce()
    expect(m.update).not.toHaveBeenCalled()
    expect(m.push).toHaveBeenCalledWith('/en/autopilot')
  })

  it('Cancel returns to the Automations list without saving', () => {
    render(<RulePage id="new" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(m.push).toHaveBeenCalledWith('/en/autopilot')
    expect(m.create).not.toHaveBeenCalled()
  })

  it('shows an error for a non-numeric id', () => {
    render(<RulePage id="abc" />)
    expect(screen.getByText('No automation "abc".')).toBeTruthy()
  })

  it('shows the server error when the rule is missing', () => {
    m.get = { data: undefined, isLoading: false, error: { message: 'Automation 7 not found' } }
    render(<RulePage id="7" />)
    expect(screen.getByText('Automation 7 not found')).toBeTruthy()
  })
})

it('loads an existing rule, updates it and returns to the list', () => {
  m.get.isLoading = true
  const { rerender } = render(<RulePage id="7" />)
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  m.get.isLoading = false
  m.get.data = { ...toAST(requiredTemplate('water-low')), id: 7 }
  rerender(<RulePage id="7" />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }))
  expect(m.create).not.toHaveBeenCalled()
  expect(m.push).toHaveBeenCalledWith('/en/autopilot')
})

it('prefills a new rule from its template and handles absent server rows', () => {
  const { rerender } = render(<RulePage id="new" template="water-low" />)
  expect(screen.getByTestId('rule-name').textContent).toBe(requiredTemplate('water-low').name)
  rerender(<RulePage id="7" />)
  expect(screen.getByText('Automation 7 not found')).toBeTruthy()
})
