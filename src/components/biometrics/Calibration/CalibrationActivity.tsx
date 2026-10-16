'use client'

import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Card } from '@/src/components/ds'
import type { Actor } from './calibration-model'
import { ActorBadge } from './CalibrationProfileCard'

export interface ActivityRow { id: string, atMs: number, actor: Actor, what: string, detail: string | null, when?: string }

const VISIBLE = 6

/** Who did what to this side's profile, newest first. */
export function ActivityCard({ rows, timezone }: { rows: ActivityRow[], timezone: string }) {
  const { t } = useLingui()
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, VISIBLE)
  return (
    <Card className="gap-1">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[15px] font-medium">{t`Activity`}</span>
        <span className="text-xs text-fg-2">{timezone}</span>
      </div>
      {rows.length === 0 && <p className="border-t border-line py-2.5 text-[13px] text-fg-2">{t`Nothing has happened on this side yet.`}</p>}
      <ol className="m-0 flex list-none flex-col p-0">
        {shown.map(row => (
          <li key={row.id} className="flex flex-col gap-1 border-t border-line py-2.5">
            <div className="flex items-baseline gap-2 text-[13px]">
              <ActorBadge kind={row.actor.kind} />
              <span className="min-w-0 flex-1">
                {row.actor.kind === 'agent' && <span className="text-fg-2">{`${row.actor.name} `}</span>}
                {row.what}
              </span>
              <span className="whitespace-nowrap font-mono text-[11px] text-fg-3">{row.when}</span>
            </div>
            {row.detail && <div className="pl-[54px] font-mono text-xs text-fg-2">{row.detail}</div>}
          </li>
        ))}
      </ol>
      {rows.length > VISIBLE && (
        <button type="button" onClick={() => setAll(!all)} className="cursor-pointer self-start border-0 bg-transparent p-0 pt-1 text-xs text-fg-2 hover:text-fg">
          {all ? t`Show recent` : t`Show all ${rows.length}`}
        </button>
      )}
    </Card>
  )
}
