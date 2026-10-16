'use client'

import { useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { CalibrationReferences } from './CalibrationReferences'
import { ReferenceLibrary } from './ReferenceLibrary'
import { ProfileLibrary } from './ProfileLibrary'
import { CalibrationBacktests } from './CalibrationBacktests'
import { ShadowRuns } from './ShadowRuns'
import { CalibrationPage } from './CalibrationPage'
import { SideTabs } from '@/src/components/Settings/SettingsLayout'

type Side = 'left' | 'right'
type View = 'overview' | 'references' | 'profiles' | 'backtests' | 'observations'

/**
 * The calibration page is the overview. The workbench views behind it —
 * reference imports, profile revisions, datasets and backtests, prospective
 * runs — stay one click away for the cases the page links out to.
 */
export function BiometricCalibration({ side, onSideChange }: { side: Side, onSideChange: (side: Side) => void }) {
  const { t } = useLingui()
  const [view, setView] = useState<View>('overview')
  const views: Array<{ id: View, label: string }> = [
    { id: 'overview', label: t`Overview` },
    { id: 'references', label: t`References` },
    { id: 'profiles', label: t`Profiles` },
    { id: 'backtests', label: t`Backtests` },
    { id: 'observations', label: t`Observations` },
  ]
  const nav = (
    <nav aria-label={t`Calibration views`} className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px]">
      {view !== 'overview' && (
        <button type="button" onClick={() => setView('overview')} className="-ml-1 flex cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 text-fg-2 hover:text-fg">
          <ChevronLeft size={16} />
          <Trans>Calibration</Trans>
        </button>
      )}
      <span className="font-mono text-[11px] tracking-[0.08em] text-fg-3">{t`WORKBENCH`}</span>
      {views.map(v => (
        <button
          key={v.id}
          type="button"
          aria-pressed={view === v.id}
          onClick={() => setView(v.id)}
          className={cn('cursor-pointer border-0 bg-transparent p-0', view === v.id ? 'text-fg' : 'text-fg-2 hover:text-fg', v.id === 'overview' && view === 'overview' && 'hidden')}
        >
          {v.label}
        </button>
      ))}
    </nav>
  )

  if (view === 'overview') {
    return (
      <div className="flex flex-col gap-5">
        <CalibrationPage key={side} side={side} onSideChange={onSideChange} onOpenTool={setView} />
        {nav}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {nav}
      <div className="max-w-xs">
        <SideTabs side={side} onChange={onSideChange} label={t`Biometric calibration`} />
      </div>
      {view === 'references'
        ? (
            <div key={side} className="space-y-4">
              <CalibrationReferences side={side} />
              <ReferenceLibrary side={side} />
            </div>
          )
        : view === 'backtests'
          ? <CalibrationBacktests key={side} side={side} />
          : view === 'observations'
            ? <ShadowRuns key={side} side={side} />
            : (
                <>
                  <ProfileLibrary key={side} side={side} />
                  <p className="text-sm text-fg-2"><Trans>Profile revisions here are candidates. Applying one requests it like Save and request does; the overview shows when the processor acknowledges it.</Trans></p>
                </>
              )}
    </div>
  )
}
