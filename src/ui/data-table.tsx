'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

export interface Column<T> {
  /** Stable key, also used as the sort identity. */
  key: string
  header: string
  /** Cell renderer. */
  render: (row: T) => ReactNode
  /** Provide to make the column sortable; returns the comparable value. */
  sortValue?: (row: T) => string | number
  align?: 'left' | 'right'
  className?: string
}

/**
 * Dense, dependency-free sortable data table. Click a sortable header to sort;
 * click again to flip direction. Built for the desktop diagnostics console
 * where information density matters more than touch ergonomics.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  empty = 'No data',
  rowClassName,
}: {
  columns: Array<Column<T>>
  rows: T[]
  getRowKey: (row: T, index: number) => string
  empty?: string
  rowClassName?: (row: T) => string
}) {
  const [sort, setSort] = useState<{ key: string, dir: 'asc' | 'desc' } | null>(null)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find(c => c.key === sort.key)
    if (!col?.sortValue) return rows
    const sv = col.sortValue
    const out = [...rows].sort((a, b) => {
      const av = sv(a)
      const bv = sv(b)
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return out
  }, [rows, sort, columns])

  const toggle = (key: string) =>
    setSort(prev => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))

  if (rows.length === 0) {
    return <p className="rounded-xl border border-zinc-800/60 px-3 py-4 text-xs text-zinc-500">{empty}</p>
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-900/60 text-[10px] uppercase tracking-wide text-zinc-500">
            {columns.map(c => (
              <th key={c.key} className={`px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : ''}`}>
                {c.sortValue
                  ? (
                      <button type="button" onClick={() => toggle(c.key)} className="inline-flex items-center gap-1 hover:text-zinc-300">
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
          {sorted.map((row, i) => (
            <tr key={getRowKey(row, i)} className={`border-b border-zinc-800/40 last:border-0 hover:bg-zinc-800/30 ${rowClassName?.(row) ?? ''}`}>
              {columns.map(c => (
                <td key={c.key} className={`px-3 py-1.5 align-top text-zinc-300 ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.className ?? ''}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
