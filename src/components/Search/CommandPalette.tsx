'use client'

import { useLingui } from '@lingui/react/macro'
import { ExternalLink, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { Modal } from '@/src/components/ds'
import { loadLiveDocsIndex, type DocsIndex } from './docsIndex'
import docsSnapshot from './docsIndex.json'
import { buildDocsEntries, buildSearchEntries, createSearch, type SearchEntry } from './searchIndex'

const MAX_RESULTS = 12

/** Bundled copy of the docs index; `pnpm docs:sync-index` refreshes it. */
const DOCS_SNAPSHOT = docsSnapshot as DocsIndex

const noopSubscribe = () => () => {}
const isMacSnapshot = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

/** ⌘K on Apple platforms, Ctrl K elsewhere; either modifier opens it. */
function isPaletteShortcut(e: globalThis.KeyboardEvent) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k'
}

/** True while a modal dialog other than the palette is open; the shortcut must not stack over it. */
function anotherModalOpen() {
  return [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .some(dialog => !dialog.querySelector('[data-command-palette]'))
}

/**
 * Sidebar search box. Opens the command palette on click or ⌘K / Ctrl K from
 * anywhere in the app — the sidebar stays mounted (CSS-hidden) on phones, so
 * a hardware keyboard works there too.
 */
export function SidebarSearch({ lang, hasBase, className }: { lang: string, hasBase: boolean, className?: string }) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const isMac = useSyncExternalStore(noopSubscribe, isMacSnapshot, () => false)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isPaletteShortcut(e) || e.isComposing || anotherModalOpen()) return
      e.preventDefault()
      setOpen(o => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
        className={cn('flex shrink-0 items-center gap-3 rounded-ctl border border-line px-2.5 py-[7px] text-sm text-fg-2 transition-colors hover:bg-active hover:text-fg', className)}
      >
        <Search size={16} aria-hidden />
        <span className="flex-1 text-left">{t`Search`}</span>
        <kbd aria-hidden className="rounded-tag border border-line px-1.5 font-mono text-[11px] leading-[18px] text-fg-3">
          {isMac ? '⌘K' : t`Ctrl K`}
        </kbd>
      </button>
      <CommandPalette open={open} onClose={close} lang={lang} hasBase={hasBase} />
    </>
  )
}

/** Dialog with a combobox over every page, sub-view and setting. Focus returns to the opener on close. */
export function CommandPalette({ open, onClose, lang, hasBase }: {
  open: boolean
  onClose: () => void
  lang: string
  hasBase: boolean
}) {
  const { t } = useLingui()

  // Layout effect: runs before the body's passive effect moves focus into the input.
  useLayoutEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => opener?.focus()
  }, [open])

  return (
    <Modal open={open} onClose={onClose} title={t`Search`} icon={Search} iconClassName="text-icon" width={560}>
      <PaletteBody lang={lang} hasBase={hasBase} onClose={onClose} />
    </Modal>
  )
}

/** Mounted only while open, so the query and selection reset each time. */
function PaletteBody({ lang, hasBase, onClose }: { lang: string, hasBase: boolean, onClose: () => void }) {
  const { t, i18n } = useLingui()
  const router = useRouter()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [docsIndex, setDocsIndex] = useState(DOCS_SNAPSHOT)

  // Prefer the live docs index when the browser can reach the docs site; keep the snapshot otherwise.
  useEffect(() => {
    let alive = true
    void loadLiveDocsIndex().then((index) => {
      if (alive && index) setDocsIndex(index)
    })
    return () => {
      alive = false
    }
  }, [])

  const { pages, search } = useMemo(() => {
    const entries = buildSearchEntries(i18n, { hasBase })
    return {
      pages: entries.filter(e => e.crumbs.length === 0),
      search: createSearch([...entries, ...buildDocsEntries(i18n, docsIndex)]),
    }
  }, [i18n, hasBase, docsIndex])

  const q = query.trim()
  const results = useMemo(() => (q ? search(q, MAX_RESULTS) : pages), [q, search, pages])
  const current = Math.min(active, results.length - 1)
  const optionId = (i: number) => `${listId}-option-${i}`

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keep Tab inside the dialog (input and close button).
  useEffect(() => {
    const dialog = inputRef.current?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('input, button:not([disabled]), a[href]')]
      if (focusable.length === 0) return
      const i = focusable.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? focusable.length - 1 : i - 1) : (i + 1) % focusable.length
      e.preventDefault()
      focusable[next].focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (current >= 0) document.getElementById(`${listId}-option-${current}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [current, listId])

  const go = (entry: SearchEntry) => {
    onClose()
    if (entry.external) {
      window.open(entry.href, '_blank', 'noopener,noreferrer')
      return
    }
    router.push(`/${lang}${entry.href === '/' ? '' : entry.href}`)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((current + 1) % results.length)
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((current - 1 + results.length) % results.length)
    }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      go(results[current])
    }
  }

  const label = t`Search pages and settings`

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        data-command-palette
        aria-label={label}
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={current >= 0 ? optionId(current) : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={label}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-ctl border border-line-2 bg-field px-3 py-2.5 text-[15px] text-fg outline-none placeholder:text-fg-3 focus:border-fg-3"
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={q ? t`Results` : t`Pages`}
        className={cn('-mx-1 flex max-h-[min(360px,50dvh)] flex-col gap-0.5 overflow-y-auto', results.length === 0 && 'hidden')}
      >
        {results.map((r, i) => (
          <li
            key={r.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === current}
            onMouseMove={() => setActive(i)}
            onClick={() => go(r)}
            className={cn('flex cursor-pointer items-center gap-3 rounded-ctl px-2.5 py-2', i === current ? 'bg-active' : 'hover:bg-active')}
          >
            <r.icon size={16} className="shrink-0 text-icon" aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm text-fg">{r.title}</span>
              <span className="truncate text-xs text-fg-3">{r.crumbs.length > 0 ? r.crumbs.join(' › ') : r.description}</span>
            </span>
            {r.external && (
              <>
                <ExternalLink size={14} className="ml-auto shrink-0 text-fg-3" aria-hidden />
                <span className="sr-only">{t`Opens the docs in a new tab`}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {results.length === 0 && (
        <p role="status" className="py-6 text-center text-sm text-fg-2">{t`No matches for “${q}”`}</p>
      )}
      <p className="hidden text-xs text-fg-3 min-[900px]:block">{t`↑ ↓ to move · Enter to open · Esc to close`}</p>
    </>
  )
}
