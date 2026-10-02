import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { StatusBadge } from '../primitives'

it.each([['active', 'ACTIVE'], ['dryrun', 'DRY-RUN'], ['paused', 'PAUSED']] as const)('labels %s automation status', (mode, label) => {
  render(<StatusBadge mode={mode} />)
  expect(screen.getByText(label)).toBeTruthy()
})
