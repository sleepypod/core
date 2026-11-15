import { render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { expect, it, vi } from 'vitest'
import { defaultConfig } from '@/src/biometrics/algorithms/registry-core'
import { draftFrom, type Actor } from '../calibration-model'
import { ProfileCard } from '../CalibrationProfileCard'
vi.mock('next/navigation', () => ({ usePathname: () => '/biometrics/calibration' }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const note = 'Owner requested addressing Watch findings 2026-10-20; restore tuning after logging-only engine change'
const view = (actor: Actor) => (
  <I18nProvider i18n={i18n}>
    <ProfileCard
      saved={defaultConfig}
      previous={defaultConfig}
      previousIsDefaults={false}
      draft={draftFrom(defaultConfig)}
      onDraft={() => {}}
      actor={actor}
      savedAgo="Oct 20 · 14:51"
      scores={[]}
    />
  </I18nProvider>
)
it('keeps a long agent note out of the unwrapping header slot so it cannot squeeze the title', () => {
  render(view({ kind: 'agent', name: note }))
  const meta = screen.getByText('AGENT').parentElement
  expect(meta?.textContent).toBe('AGENTOct 20 · 14:51')
  const line = screen.getByText(note)
  expect(line.closest('.whitespace-nowrap')).toBeNull()
  expect(meta?.contains(line)).toBe(false)
})
it('shows no note line for saves without an agent note', () => {
  render(view({ kind: 'you', name: 'you' }))
  expect(screen.getByText('YOU').parentElement?.textContent).toBe('YOUOct 20 · 14:51')
  expect(screen.queryByText(note)).toBeNull()
})
