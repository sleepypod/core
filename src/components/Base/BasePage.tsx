'use client'

import { useState } from 'react'
import { Link2, Square, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/src/components/ds'
import { BASE_SIDES, scopeSides } from '@/src/hardware/base/types'
import type { BaseScope } from '@/src/hardware/base/types'
import { trpc } from '@/src/utils/trpc'
import { BaseSchedules } from './BaseSchedules'
import { BedView, useBedModel, useSimpleBedView } from './BedView'
import { Presets, Speed, Steppers, buttonStyle, labelStyle, panelStyle, samePosition, usePreference } from './controls'
import type { Angles, Targets } from './controls'

export function BasePage() {
  const query = trpc.base.getStatus.useQuery({}, { refetchInterval: 1000 })
  const settings = trpc.settings.getAll.useQuery({})
  const names = { left: settings.data?.sides.left.name || 'Left', right: settings.data?.sides.right.name || 'Right' }
  const [targets, setTargets] = useState<Targets>({ left: { head: 0, feet: 0 }, right: { head: 0, feet: 0 } })
  const [speed, setSpeed] = useState(50)
  const [layout, setLayout] = usePreference('layout', 'cards', ['cards', 'scope'])
  const [linked, setLinked] = usePreference('linked', 'false', ['true', 'false'])
  const [savedScope, setScope] = usePreference<BaseScope>('scope', 'both', ['both', 'left', 'right'])
  const [instant, setInstant] = usePreference('instantPresets', 'false', ['true', 'false'])
  const [bedModel, setBedModel] = useBedModel()
  const [simpleView, setSimpleView] = useSimpleBedView()
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const refresh = () => {
    void query.refetch()
  }
  const onError = (error: { message: string }) => {
    setFailure(error.message)
    setNotice('')
    refresh()
  }
  const position = trpc.base.setPosition.useMutation({ onSuccess: () => {
    setNotice('Move sent. Measured angles update as the bed moves.')
    refresh()
  }, onError })
  const stop = trpc.base.stop.useMutation({ onSuccess: () => {
    setNotice('Stop sent to both sides.')
    refresh()
  }, onError })
  const reconnect = trpc.base.reconnect.useMutation({ onSuccess: refresh, onError })
  const status = query.data
  const independent = status?.independentControl === true
  const cards = independent && layout === 'cards'
  const scope: BaseScope = independent ? savedScope : 'both'
  const stale = status?.stale !== false || query.isError
  const unavailable = status?.state !== 'connected' || stale
  const busy = position.isPending || stop.isPending || status?.busy || reconnect.isPending
  const measured = unavailable ? null : status?.position ?? null
  const moving = status?.movingBySide.left || status?.movingBySide.right
  const resetNotice = () => {
    setFailure('')
    setNotice('')
  }
  const effectiveScope = (requested: BaseScope): BaseScope => !independent || (cards && linked === 'true') ? 'both' : requested
  const edit = (requested: BaseScope, value: Angles) => {
    const sides = scopeSides(effectiveScope(requested))
    setTargets(current => ({ left: sides.includes('left') ? value : current.left, right: sides.includes('right') ? value : current.right }))
  }
  const move = (requested: BaseScope, value: Angles) => {
    if (unavailable || busy) return
    resetNotice()
    edit(requested, value)
    position.mutate({ ...value, feedRate: speed, sides: scopeSides(effectiveScope(requested)) })
  }
  const selectPreset = (requested: BaseScope, value: Angles) => {
    edit(requested, value)
    if (instant === 'true') move(requested, value)
  }
  const moveButton = (requested: BaseScope) => {
    const selected = effectiveScope(requested)
    const sides = scopeSides(selected)
    const target = targets[selected === 'right' ? 'right' : 'left']
    // Both sends the displayed (left) target to every selected side.
    const atTarget = !!measured && sides.every(side => samePosition(measured[side], target))
    const inMotion = sides.some(side => status?.movingBySide[side])
    const label = inMotion ? 'Moving' : atTarget ? 'At target' : `Move ${selected === 'both' ? 'both ' : cards ? '' : `${names[selected]} `}to ${target.head}° / ${target.feet}°`
    return <button type="button" className={`min-h-10 min-w-0 max-w-full flex-1 overflow-hidden rounded-lg bg-fg px-3 py-2 text-sm font-medium text-ellipsis whitespace-nowrap text-app disabled:bg-active disabled:text-fg-2 disabled:opacity-45 ${cards ? 'w-full' : 'basis-full @min-[900px]:basis-auto'}`} disabled={!!(unavailable || busy || atTarget || inMotion)} onClick={() => move(requested, target)}>{label}</button>
  }
  const bedProps = { left: measured?.left ?? null, right: measured?.right ?? null, leftTarget: targets.left, rightTarget: targets.right, moving: status?.movingBySide ?? {}, names }
  const cardStatus = (side: 'left' | 'right') => !measured ? 'NOT CONFIGURED' : status?.movingBySide[side] ? 'MOVING' : samePosition(measured[side], targets[side]) ? 'AT TARGET' : 'NOT APPLIED'
  return (
    <div className="@container flex flex-col gap-5">
      <PageHeader
        title="Base"
        middle={(
          <>
            <span title="Experimental: verified with simulated hardware only. Per-side movement is locked until the base firmware is confirmed." className={`${labelStyle} rounded border border-[#3a3222] px-1.5 py-0.5 text-[#e0b45a]`}>Experimental</span>
            <span className={`${labelStyle} ${moving ? 'text-[#50c878]' : 'text-fg-2'}`}>{moving ? 'MOVING' : 'IDLE'}</span>
          </>
        )}
        right={(
          <>
            <button
              type="button"
              onClick={() => {
                resetNotice()
                stop.mutate({})
              }}
              className={`flex min-h-[38px] items-center gap-2 rounded-lg border border-[#e06a6a] px-4 text-sm font-medium whitespace-nowrap ${moving ? 'bg-[#e06a6a] text-app' : 'text-[#e06a6a]'}`}
            >
              <Square size={14} />
              Stop both
            </button>
          </>
        )}
      />
      {unavailable && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-[#3a3222] bg-[#2a2414] p-4 text-[#e0b45a]">
          <div className="min-w-0 flex-1">
            <p className={labelStyle}>{status?.state === 'unconfigured' ? 'NOT CONFIGURED' : query.isLoading ? 'CONNECTING' : 'POSITION UNAVAILABLE'}</p>
            <p className="mt-1 text-sm">{query.error?.message || status?.error || (status?.state === 'unconfigured' ? 'Complete the base setup in the stock app, then reconnect.' : 'Waiting for live position updates.')}</p>
          </div>
          <button
            type="button"
            className={`${buttonStyle} flex items-center gap-2`}
            disabled={!!busy}
            onClick={() => {
              resetNotice()
              reconnect.mutate({})
            }}
          >
            <RefreshCw size={14} />
            Reconnect
          </button>
        </div>
      )}
      {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}
      {notice && <p role="status" className="text-sm text-fg-2">{notice}</p>}
      <fieldset disabled={unavailable} className={`m-0 flex min-w-0 flex-col gap-4 border-0 p-0 ${unavailable ? 'pointer-events-none opacity-45' : ''}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {independent
            ? (
                <div role="group" aria-label="Base layout" className="flex rounded-lg border border-line-2 p-[3px]">
                  {(['cards', 'scope'] as const).map(value => (
                    <button
                      type="button"
                      key={value}
                      aria-pressed={layout === value}
                      onClick={() => {
                        if (value === 'cards' && linked === 'true') setTargets(current => ({ ...current, right: { ...current.left } }))
                        setLayout(value)
                      }}
                      className={`rounded-md px-3 py-1.5 text-sm ${layout === value ? 'bg-active' : 'text-fg-2'}`}
                    >
                      {value === 'cards' ? 'Side cards' : 'Single card'}
                    </button>
                  ))}
                </div>
              )
            : <p className="text-xs text-fg-2">This base moves both sides together.</p>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={instant === 'true'} onChange={e => setInstant(e.target.checked ? 'true' : 'false')} />
              Move immediately when selecting a preset
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={bedModel === 'mattress'} onChange={e => setBedModel(e.target.checked ? 'mattress' : 'base')} />
              Show mattress
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={simpleView === 'true'} onChange={e => setSimpleView(e.target.checked ? 'true' : 'false')} />
              Simple bed view
            </label>
          </div>
        </div>
        {cards
          ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Speed value={speed} onChange={setSpeed} />
                  <button
                    type="button"
                    role="switch"
                    aria-checked={linked === 'true'}
                    onClick={() => {
                      if (linked !== 'true') setTargets(current => ({ ...current, right: { ...current.left } }))
                      setLinked(linked === 'true' ? 'false' : 'true')
                    }}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Link2 size={14} className="text-fg-2" />
                    Move both sides together
                    <span className={`relative h-5 w-9 rounded-full ${linked === 'true' ? 'bg-[#ececec]' : 'bg-[#26262a]'}`}><span className={`absolute top-[3px] size-3.5 rounded-full transition-[left] duration-150 ease-[cubic-bezier(.2,0,0,1)] ${linked === 'true' ? 'left-[19px] bg-[#0b0b0c]' : 'left-[3px] bg-[#8b8b92]'}`} /></span>
                  </button>
                </div>
                <div className="grid gap-4 @min-[900px]:grid-cols-2">
                  {BASE_SIDES.map(side => (
                    <section key={side} aria-label={`${names[side]} base controls`} className={panelStyle}>
                      <div className="flex items-baseline gap-2">
                        <h2 className="min-w-0 truncate text-[15px] font-medium">{names[side]}</h2>
                        <span className={`${labelStyle} text-fg-3`}>{side}</span>
                        <span className={`ml-auto ${labelStyle} ${cardStatus(side) === 'MOVING' ? 'text-[#50c878]' : cardStatus(side) === 'AT TARGET' ? 'text-fg-2' : 'text-[#e0b45a]'}`}>{cardStatus(side)}</span>
                      </div>
                      <BedView {...bedProps} single={side} />
                      <Steppers name={names[side]} target={targets[side]} onChange={value => edit(side, value)} />
                      <Presets targets={targets} measured={measured} scope={side} names={names} grid onSelect={value => selectPreset(side, value)} />
                      {moveButton(side)}
                    </section>
                  ))}
                </div>
                <BaseSchedules names={names} independent={independent} speed={speed} />
              </>
            )
          : (
              <div className="grid items-start gap-4 @min-[900px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                <section aria-label="Position" className={panelStyle}>
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-[15px] font-medium">Position</h2>
                    {independent && <div role="group" aria-label="Selected sides" className="flex w-full rounded-lg border border-line-2 p-[3px] @min-[900px]:ml-auto @min-[900px]:w-auto">{(['both', 'left', 'right'] as const).map(side => <button type="button" key={side} aria-pressed={scope === side} onClick={() => setScope(side)} className={`min-w-0 flex-1 truncate rounded-md px-3 py-1.5 text-sm @min-[900px]:min-w-16 @min-[900px]:flex-auto ${scope === side ? 'bg-active' : 'text-fg-2'}`}>{side === 'both' ? 'Both' : names[side]}</button>)}</div>}
                  </div>
                  <BedView {...bedProps} split={independent} focus={scope} />
                  <Steppers name={scope === 'both' ? 'both' : names[scope]} target={targets[scope === 'right' ? 'right' : 'left']} onChange={value => edit(scope, value)} />
                  {scope === 'both' && !samePosition(targets.left, targets.right) && (
                    <p className="text-center text-xs text-[#e0b45a]">
                      Sides differ. Showing
                      {' '}
                      {names.left}
                      ; a change applies to both.
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <Speed value={speed} onChange={setSpeed} />
                    {moveButton(scope)}
                  </div>
                </section>
                <div className="flex min-w-0 flex-col gap-4">
                  <section className={panelStyle}>
                    <h2 className="text-[15px] font-medium">Presets</h2>
                    <Presets targets={targets} measured={measured} scope={scope} names={names} onSelect={value => selectPreset(scope, value)} />
                  </section>
                  <BaseSchedules names={names} independent={independent} speed={speed} compact />
                </div>
              </div>
            )}
      </fieldset>
    </div>
  )
}
