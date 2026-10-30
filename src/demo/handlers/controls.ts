import type { DemoHandlers } from '../types'

const unavailable = () => {
  throw new Error('Control receipts require a connected controller; the demo cannot actuate hardware.')
}
export const controls: DemoHandlers<'controls'> = { submit: unavailable, get: unavailable }
