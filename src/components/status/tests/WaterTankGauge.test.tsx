import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FrzWaterFrame } from '@/src/hooks/useSensorStream'
import { WaterTankGauge } from '../WaterTankGauge'
import { waterTank, type WaterTank } from '../waterTank'

const frame = (over: Partial<FrzWaterFrame> = {}): FrzWaterFrame => ({
  type: 'frzWater', ts: 1, isPriming: false, hasWater: true, capValid: true, capLevel: 4, needsPriming: false, ...over,
})

describe('waterTank', () => {
  it('is undefined without a frzWater frame (older firmware)', () => {
    expect(waterTank(undefined)).toBeUndefined()
  })

  it('uses capLevel when capValid', () => {
    expect(waterTank(frame())).toEqual({ level: 4, label: '4/5', tone: 'ok', prime: null })
    expect(waterTank(frame({ capLevel: 1 }))).toMatchObject({ level: 1, tone: 'warn' })
    expect(waterTank(frame({ capLevel: 0, hasWater: false }))).toMatchObject({ level: 0, label: '0/5', tone: 'warn' })
  })

  it('clamps out-of-range levels to the five bars', () => {
    expect(waterTank(frame({ capLevel: 9 }))?.level).toBe(5)
    expect(waterTank(frame({ capLevel: -2 }))?.level).toBe(0)
  })

  it('ignores capLevel when the capacitive reading is invalid', () => {
    expect(waterTank(frame({ capValid: false, capLevel: 5 }))).toEqual({ level: null, label: 'OK', tone: 'ok', prime: null })
    expect(waterTank(frame({ capValid: false, capLevel: 5, hasWater: false }))).toEqual({ level: null, label: 'Low', tone: 'warn', prime: null })
  })

  it('warns whenever the controller reports no water', () => {
    expect(waterTank(frame({ capLevel: 3, hasWater: false }))?.tone).toBe('warn')
  })

  it('reads the 0/1 integer flags a Pod 3 on thermal v1.6.114 sends', () => {
    const live = JSON.parse('{"type":"frzWater","version":1,"ts":1793239885,"isPriming":1,"hasWater":1,"capValid":0,"capLevel":0,"needsPriming":0}') as FrzWaterFrame
    expect(waterTank(live)).toEqual({ level: null, label: 'OK', tone: 'ok', prime: 'priming' })
    expect(waterTank({ ...live, isPriming: 0, capValid: 1, capLevel: 3 })).toEqual({ level: 3, label: '3/5', tone: 'ok', prime: null })
    expect(waterTank({ ...live, isPriming: 0, hasWater: 0, needsPriming: 1 })).toEqual({ level: null, label: 'Low', tone: 'warn', prime: 'needed' })
  })

  it('reports priming ahead of a pending prime', () => {
    expect(waterTank(frame({ needsPriming: true }))?.prime).toBe('needed')
    expect(waterTank(frame({ isPriming: true, needsPriming: true }))?.prime).toBe('priming')
  })
})

describe('WaterTankGauge', () => {
  const tank = (over: Partial<FrzWaterFrame> = {}) => waterTank(frame(over)) as WaterTank
  const lit = () => screen.getByRole('img').querySelectorAll('[data-lit="true"]').length

  it('lights one bar per level with the level label', () => {
    render(<WaterTankGauge tank={tank({ capLevel: 3 })} />)
    expect(screen.getByRole('img', { name: 'Water tank 3 of 5' })).toBeTruthy()
    expect(screen.getByRole('img').children).toHaveLength(5)
    expect(lit()).toBe(3)
    expect(screen.getByText('3/5')).toBeTruthy()
  })

  it('shows no level when the reading is invalid', () => {
    render(<WaterTankGauge tank={tank({ capValid: false, hasWater: false })} />)
    expect(screen.getByRole('img', { name: 'Water low, tank level unavailable' })).toBeTruthy()
    expect(lit()).toBe(0)
    expect(screen.getByText('Low').className).toContain('text-warn')
  })

  it('pulses while priming and flags a needed prime', () => {
    const { rerender } = render(<WaterTankGauge tank={tank({ isPriming: true })} />)
    expect(screen.getByText('Priming…')).toBeTruthy()
    expect(screen.getByRole('img').className).toContain('animate-pulse')
    rerender(<WaterTankGauge tank={tank({ needsPriming: true })} />)
    expect(screen.getByText('Needs prime').className).toContain('text-warn')
    expect(screen.getByRole('img').className).not.toContain('animate-pulse')
  })
})
