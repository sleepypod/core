import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DiagTable, type DiagColumn } from '../DiagTable'

interface Row { id: number, name: string }

const columns: Array<DiagColumn<Row>> = [
  { key: 'id', header: 'ID', render: r => String(r.id), sortValue: r => r.id },
  { key: 'name', header: 'Name', render: r => r.name },
]
const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: i % 2 ? 'odd' : 'even' }))

function bodyIds() {
  return screen.getAllByRole('row').slice(1).map(r => r.firstElementChild?.textContent)
}

describe('DiagTable', () => {
  it('paginates and steps between pages', () => {
    render(<DiagTable columns={columns} rows={rows} getRowKey={r => String(r.id)} pageSize={5} />)
    expect(bodyIds()).toEqual(['1', '2', '3', '4', '5'])
    expect(screen.getByText('1–5 of 12')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(bodyIds()).toEqual(['11', '12'])
    expect(screen.getByText('11–12 of 12')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('filters rows by searchText and resets to the first page', () => {
    render(<DiagTable columns={columns} rows={rows} getRowKey={r => String(r.id)} pageSize={5} searchText={r => r.name} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), { target: { value: 'ODD' } })
    expect(bodyIds()).toEqual(['2', '4', '6', '8', '10'])
    expect(screen.getByText('1–5 of 6')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No rows match the filter')).toBeTruthy()
  })

  it('applies defaultSort and hides paging controls when everything fits', () => {
    render(<DiagTable columns={columns} rows={rows.slice(0, 3)} getRowKey={r => String(r.id)} pageSize={5} defaultSort={{ key: 'id', dir: 'desc' }} />)
    expect(bodyIds()).toEqual(['3', '2', '1'])
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
})
