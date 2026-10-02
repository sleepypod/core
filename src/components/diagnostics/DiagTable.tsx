'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search } from 'lucide-react'
import { GhostIcon } from '@/src/components/ds'
import { cn } from '@/lib/utils'

export interface DiagColumn<T> {
  /** Stable key, also used as the sort identity. */
  key: string
  header: string
  render: (row: T) => ReactNode
  /** Provide to make the column sortable; returns the comparable value. */
  sortValue?: (row: T) => string | number
  align?: 'left' | 'right'
}

/**
 * Dense sortable table on the design tokens (hairline rows, mono label
 * header). Click a sortable header to sort; click again to flip direction.
 * Scrolls horizontally inside its card on narrow screens. Pass `searchText`
 * to show a filter box and `pageSize` to paginate.
 */
export function DiagTable<T>({
  columns,
  rows,
  getRowKey,
  empty = 'No data',
  searchText,
  pageSize,
  defaultSort = null,
}: {
  columns: Array<DiagColumn<T>>
  rows: T[]
  getRowKey: (row: T, index: number) => string
  empty?: string
  /** Text a row is matched against by the filter box (case-insensitive). */
  searchText?: (row: T) => string
  pageSize?: number
  defaultSort?: { key: string, dir: 'asc' | 'desc' } | null
}) {
  const [sort, setSort] = useState<{ key: string, dir: 'asc' | 'desc' } | null>(defaultSort)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !searchText) return rows
    return rows.filter(r => searchText(r).toLowerCase().includes(q))
  }, [rows, query, searchText])

  const sorted = useMemo(() => {
    if (!sort) return filtered
    const col = columns.find(c => c.key === sort.key)
    if (!col?.sortValue) return filtered
    const sv = col.sortValue
    return [...filtered].sort((a, b) => {
      const av = sv(a)
      const bv = sv(b)
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [filtered, sort, columns])

  const pageCount = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1
  const current = Math.min(page, pageCount - 1)
  const visible = pageSize ? sorted.slice(current * pageSize, (current + 1) * pageSize) : sorted

  const toggle = (key: string) => {
    setSort(prev => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
    setPage(0)
  }

  if (rows.length === 0) {
    return <p className="py-2 text-[13px] text-fg-3">{empty}</p>
  }

  return (
    <div className="flex flex-col gap-2.5">
      {searchText && (
        <label className="flex items-center gap-2 rounded-ctl border border-line-2 bg-field px-2.5 py-[7px] text-[13px] text-fg-3 focus-within:border-fg-3">
          <Search size={14} className="shrink-0" />
          <input
            type="search"
            aria-label="Filter rows"
            placeholder="Filter"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[13px] text-fg outline-none placeholder:font-sans placeholder:text-fg-3"
          />
        </label>
      )}
      {sorted.length === 0
        ? <p className="py-2 text-[13px] text-fg-3">No rows match the filter</p>
        : (
            <div className="-mx-[18px] overflow-x-auto px-[18px]">
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line">
                    {columns.map(c => (
                      <th key={c.key} className={cn('sp-label whitespace-nowrap py-2 pr-4 font-normal last:pr-0', c.align === 'right' && 'text-right')}>
                        {c.sortValue
                          ? (
                              <button
                                type="button"
                                onClick={() => toggle(c.key)}
                                className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 uppercase text-inherit hover:text-fg"
                              >
                                {c.header}
                                {sort?.key === c.key && (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                              </button>
                            )
                          : c.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row, i) => (
                    <tr key={getRowKey(row, i)} className="border-b border-line last:border-0 hover:bg-active">
                      {columns.map(c => (
                        <td key={c.key} className={cn('whitespace-nowrap py-2 pr-4 align-top last:pr-0', c.align === 'right' && 'text-right font-mono')}>
                          {c.render(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      {pageSize !== undefined && sorted.length > pageSize && (
        <div className="flex items-center justify-end gap-1 font-mono text-xs text-fg-2">
          <span className="mr-1.5">
            {`${current * pageSize + 1}–${Math.min((current + 1) * pageSize, sorted.length)} of ${sorted.length}`}
          </span>
          <GhostIcon icon={ChevronLeft} label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)} />
          <GhostIcon icon={ChevronRight} label="Next page" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)} />
        </div>
      )}
    </div>
  )
}
