'use client'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { ACTIONS, BASE_INPUTS, BUTTONS, INPUTS, defaultBinding, describe, inputHint, inputLabel, parts, type Binding, type Edit, type InputId, type RemoteConfig, type Side, type Source } from '@/src/remote/model'
import { Badge, Button, Card, Segmented } from './primitives'
import { Icon } from './icons'
import styles from './RemotePanel.module.css'
interface Automation {
  id: number
  name: string
}
export function useRemoteMapping() {
  const query = trpc.remote.mapping.useQuery({}, { refetchOnWindowFocus: true })

  const utils = trpc.useUtils()

  const mutation = trpc.remote.update.useMutation({ onSuccess: (data) => {
    utils.remote.mapping.setData({}, data)
  } })

  const [draft, setDraft] = useState<{
    side: Side
    edit: Edit
    revision: number
  } | null>(null)

  const [error, setError] = useState<string | null>(null)

  const persist = useEffectEvent((change: NonNullable<typeof draft>) => {
    mutation.mutate(change, {
      onSuccess: () => {
        setDraft(null)

        setError(null)
      },
      onError: (e) => {
        setDraft(null)

        setError(e.message)

        void query.refetch()
      },
    })
  })
  useEffect(() => {
    if (!draft) return
    let sent = false
    const flush = () => {
      if (sent) return
      sent = true
      persist(draft)
    }
    const timer = setTimeout(flush, 250)
    // Navigation must not silently discard an edit inside the debounce window.
    return () => {
      clearTimeout(timer)

      flush()
    }
  }, [draft])

  return {
    config: query.data,
    loading: query.isLoading,
    error: error ?? query.error?.message,
    busy: draft !== null || mutation.isPending,
    save(side: Side, edit: Edit) {
      if (!draft && !mutation.isPending && query.data) {
        setError(null)

        setDraft({ side, edit, revision: query.data.revision })
      }
    },
    reload: () => {
      setError(null)

      void query.refetch()
    },
  }
}
export type MappingState = ReturnType<typeof useRemoteMapping>
export function RemoteFigure({ selected, hovered, config, side, select }: {
  selected: Source | null
  hovered: Source[]
  config: RemoteConfig
  side: Side
  select: (source: Source | null) => void
}) {
  return (
    <div className={styles.figure}>
      <div className={styles.remote} aria-label={`${side} cover remote`}>
        {BUTTONS.map(button => (
          <button key={button.id} type="button" aria-label={`Select ${button.label.toLowerCase()} button`} aria-pressed={selected === button.id} className={`${styles.segment} ${selected === button.id || hovered.includes(button.id) ? styles.lit : ''}`} onClick={() => select(selected === button.id ? null : button.id)}>
            <span aria-hidden="true">{button.glyph}</span>
            {Object.keys(config[side]).some(id => parts(id).includes(button.id)) && <span className={styles.dot} aria-label="Has custom action" />}
          </button>
        ))}
      </div>
      <p className="mt-4 text-center text-[11px] text-zinc-500">built into the cover</p>
    </div>
  )
}
function Param({ binding, automations, change, disabled, label }: {
  binding: Binding
  automations: Automation[]
  change: (binding: Binding) => void
  disabled: boolean
  label: string
}) {
  let options: {
    value: number
    label: string
  }[] = []

  let value = 0

  if ('deltaF' in binding) {
    value = binding.deltaF

    options = [1, 2, 3].map(n => ({ value: n, label: `${binding.action === 'temp.up' ? '+' : '−'}${n}°F` }))
  }

  if ('temperatureF' in binding) {
    value = binding.temperatureF

    options = [62, 68, 72, 76].map(n => ({ value: n, label: `${n}°F` }))
  }

  if ('durationSec' in binding) {
    value = binding.durationSec

    options = [300, 540, 900].map(n => ({ value: n, label: `${n / 60} min` }))
  }

  if ('automationId' in binding) {
    value = binding.automationId

    options = automations.map(a => ({ value: a.id, label: a.name }))

    if (!options.some(o => o.value === value))
      options.unshift({ value, label: 'Deleted automation' })
  }

  if (!options.length)
    return null

  return (
    <select
      aria-label={`${label} parameter`}
      className={styles.param}
      disabled={disabled}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value)

        if ('deltaF' in binding)
          change({ ...binding, deltaF: n as 1 | 2 | 3 })
        else if ('temperatureF' in binding)
          change({ ...binding, temperatureF: n as 62 | 68 | 72 | 76 })
        else if ('durationSec' in binding)
          change({ ...binding, durationSec: n as 300 | 540 | 900 })
        else if ('automationId' in binding)
          change({ ...binding, automationId: n })
      }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
export function RemotePanel({ automations, mapping, side, setSide }: {
  automations: Automation[]
  mapping: MappingState
  side: Side
  setSide: (side: Side) => void
}) {
  const [selected, setSelected] = useState<Source | null>(null)

  const [hovered, setHovered] = useState<Source[]>([])

  const [menu, setMenu] = useState(false)

  const menuRef = useRef<HTMLDivElement>(null)

  const [confirm, setConfirm] = useState<'copy' | 'resetSide' | null>(null)

  useEffect(() => {
    if (!menu)
      return

    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenu(false)

        setHovered([])
      }
    }

    document.addEventListener('mousedown', close)

    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  if (!mapping.config)
    return (
      <div className="p-5" role={mapping.error ? 'alert' : 'status'}>
        {mapping.error ?? 'Loading remote mappings…'}
        {mapping.error && <Button onClick={mapping.reload}>Retry</Button>}
      </div>
    )

  const config = mapping.config

  const bindings = config[side]

  const rows = [...BASE_INPUTS, ...new Set([...config.extras[side], ...Object.keys(bindings).filter(id => !BASE_INPUTS.includes(id as InputId))])] as InputId[]

  const available = INPUTS.filter(id => !rows.includes(id))

  const count = Object.keys(bindings).length

  const change = (input: InputId, binding: Binding) => mapping.save(side, { kind: 'set', input, binding })

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 px-5 py-4">
        <div className="min-w-[200px] flex-1">
          <h1 className="text-[19px] font-semibold tracking-tight text-zinc-100">Remote</h1>
          <p className="mt-0.5 text-[12px] text-zinc-500">Reprogram what each button does. Each side’s remote is mapped separately.</p>
        </div>
        <div className="flex items-center gap-3">
          {count > 0 && (
            <Badge tone="accent">
              {count}
              {' '}
              remapped
            </Badge>
          )}
          <Segmented
            value={side}
            options={[{ value: 'left', label: 'Left remote' }, { value: 'right', label: 'Right remote' }]}
            onChange={(v) => {
              setSide(v as Side)

              setSelected(null)

              setConfirm(null)

              setMenu(false)

              setHovered([])
            }}
            size="sm"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className={styles.layout}>
          <div className="self-start md:sticky md:top-0">
            <Card className="flex items-center gap-6 p-5 md:block">
              <RemoteFigure selected={selected} hovered={hovered} config={config} side={side} select={setSelected} />
              <div className="flex flex-1 flex-col gap-2 md:mt-5 md:border-t md:border-zinc-800/60 md:pt-4">
                <Button variant="ghost" size="sm" disabled={mapping.busy} onClick={() => setConfirm('copy')} className="justify-start">
                  <Icon.Copy size={13} />
                  Copy to
                  {' '}
                  {side === 'left' ? 'right' : 'left'}
                </Button>
                <Button variant="ghost" size="sm" disabled={mapping.busy || (count === 0 && config.extras[side].length === 0)} onClick={() => setConfirm('resetSide')} className="justify-start">
                  <Icon.Reset size={13} />
                  Reset this remote
                </Button>
              </div>
            </Card>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            {confirm && (
              <Card className="p-4">
                <p className="mb-3 text-[13px]">{confirm === 'copy' ? 'Replace the other remote’s custom actions and added inputs?' : 'Remove this remote’s custom actions and added inputs? Native firmware behavior remains.'}</p>
                <div className="flex gap-2">
                  <Button
                    disabled={mapping.busy}
                    onClick={() => {
                      mapping.save(side, { kind: confirm })

                      setConfirm(null)
                    }}
                  >
                    {confirm === 'copy' ? 'Replace mappings' : 'Reset remote'}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
                </div>
              </Card>
            )}
            {mapping.error && (
              <div role="alert" className="rounded-lg border border-red-500/30 p-3 text-[12px] text-red-300">
                Not saved:
                {' '}
                {mapping.error}
                {' '}
                <button type="button" onClick={mapping.reload} className="underline">Reload</button>
              </div>
            )}
            <div aria-live="polite" className="text-right text-[11px] text-zinc-500">{mapping.busy ? 'Saving to device…' : mapping.error ? 'Changes were not saved' : 'Saved on device'}</div>
            <Card>
              {rows.map(id => (
                <div key={id} className={styles.row} style={selected && parts(id).includes(selected) ? { background: 'color-mix(in srgb, var(--accent) 7%, transparent)' } : undefined} onMouseEnter={() => setHovered(parts(id))} onMouseLeave={() => setHovered([])} onFocus={() => setHovered(parts(id))} onBlur={() => setHovered([])}>
                  <div className={styles.label}>
                    <div title={inputLabel(id)} className="truncate text-[13px] text-zinc-200">{inputLabel(id)}</div>
                    <div title={inputHint(id)} className="mono truncate text-[10px] text-zinc-400">{inputHint(id)}</div>
                  </div>
                  <div className={styles.controls}>
                    <select
                      aria-label={`${inputLabel(id)} action`}
                      disabled={mapping.busy}
                      value={bindings[id]?.action ?? 'factory'}
                      className={`${styles.action} ${bindings[id] ? 'text-zinc-100' : 'text-zinc-300'}`}
                      onChange={(e) => {
                        if (e.target.value === 'factory')
                          mapping.save(side, { kind: 'reset', input: id })
                        else
                          change(id, defaultBinding(e.target.value, automations[0]?.id))
                      }}
                    >
                      <option value="factory">Firmware default</option>
                      {ACTIONS.map(a => (
                        <option key={a.id} value={a.id} disabled={'unavailable' in a || (a.id === 'automation.run' && !automations.length)}>
                          {a.label}
                          {'unavailable' in a ? ' (unavailable)' : ''}
                        </option>
                      ))}
                    </select>
                    {bindings[id] && <Param label={inputLabel(id)} binding={bindings[id] as Binding} automations={automations} disabled={mapping.busy} change={b => change(id, b)} />}
                  </div>
                  <div className="ml-auto flex shrink-0 gap-1">
                    {bindings[id] ? <button type="button" className={styles.iconButton} aria-label={`Reset ${inputLabel(id)}`} title="Reset to firmware default" disabled={mapping.busy} onClick={() => mapping.save(side, { kind: 'reset', input: id })}><Icon.Reset size={13} /></button> : <span className="w-[21px]" />}
                    {!BASE_INPUTS.includes(id) ? <button type="button" className={styles.iconButton} aria-label={`Remove ${inputLabel(id)}`} title="Remove input" disabled={mapping.busy} onClick={() => mapping.save(side, { kind: 'remove', input: id })}>×</button> : <span className="w-[21px]" />}
                  </div>
                </div>
              ))}
              <div
                ref={menuRef}
                className="relative border-t border-zinc-800/60"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setMenu(false)

                    setHovered([])
                  }
                }}
              >
                {available.length
                  ? (
                      <button type="button" disabled={mapping.busy} aria-expanded={menu} aria-label={`Add another input ${available.length} available`} className="flex w-full items-center gap-2 px-4 py-3 text-[12px] text-zinc-400 hover:bg-zinc-900/50" onClick={() => setMenu(!menu)}>
                        <Icon.Plus size={13} />
                        Add another input
                        <span className="ml-auto whitespace-nowrap text-[11px]">
                          {available.length}
                          {' '}
                          available
                        </span>
                      </button>
                    )
                  : <p className="px-4 py-3 text-[11px] text-zinc-400">Every supported input is in use.</p>}
                {menu && (
                  <div className="absolute bottom-full left-3 z-40 mb-1 w-[280px] max-w-[calc(100%-24px)] rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-2xl shadow-black/60">
                    {available.map(id => (
                      <button
                        type="button"
                        key={id}
                        aria-label={inputLabel(id)}
                        onFocus={() => setHovered(parts(id))}
                        onMouseEnter={() => setHovered(parts(id))}
                        onMouseLeave={() => setHovered([])}
                        onClick={() => {
                          mapping.save(side, { kind: 'add', input: id })

                          setMenu(false)

                          setHovered([])
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-zinc-300 hover:bg-zinc-800"
                      >
                        <span className="flex-1">{inputLabel(id)}</span>
                        <span className="mono text-[10px] text-zinc-400">{parts(id).length > 1 ? 'experimental' : '×2'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Card>
            <p className="px-1 text-[11px] leading-relaxed text-zinc-500">The three presses are always shown. Double-presses and two-button combos are opt-in. Combos use an experimental 200 ms overlap window; missing releases cancel stale state. Firmware counts above two and holds are detected but aren’t bindable in this screen.</p>
            <p className="px-1 text-[11px] leading-relaxed text-zinc-500">Unmodified inputs stay with firmware. Factory actions aren’t verified here. “Nothing” disables the custom action only; native haptics and alarm behavior can still occur. Elevation and soundscape control are unavailable.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
export { describe }
