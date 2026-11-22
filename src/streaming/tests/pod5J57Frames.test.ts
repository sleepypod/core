/**
 * Field frames from a Pod 5 hub + J57 cover on NATS firmware (rawmem.*).
 * See fixtures/natsFramesPod5J57.json for provenance and ground truth:
 * still sleeper on the LEFT, RIGHT empty, no Blanket attached, and a
 * sensHealth frame reporting both sides disconnected while the cover streams.
 *
 * These pin the wire shapes so the cover-liveness and Pod 3-dialect occupancy
 * fixes keep matching what this hardware actually publishes.
 */
import { describe, expect, it } from 'vitest'
import fixtures from './fixtures/natsFramesPod5J57.json'
import { __test__ as piezo } from '../piezoStream'
import { capSideChannels } from '../normalizeFrame'
import { disconnectedCovers } from '@/src/components/diagnostics/dashboardLogic'
import type { SensHealthFrame } from '@/src/hooks/useSensorStream'

const decode = piezo.decodeSensorFrames
const bytes = (b64: string) => Buffer.from(b64, 'base64')

describe('Pod 5 hub + J57 cover NATS frames', () => {
  it('every captured payload decodes to its recorded value through the shared decoder', () => {
    for (const f of [...fixtures.sensHealth, ...fixtures.blanketReadings, ...fixtures.capSense]) {
      const frames = decode(bytes(f.payloadB64))
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ type: f.type, ts: f.decoded.ts })
    }
  })

  it('capSense arrives in the Pod 3 dialect and unwraps to [out,out,cen,cen,in,in]', () => {
    const f = fixtures.capSense[0].decoded
    expect(capSideChannels(f.left)).toEqual([2549, 2549, 2978, 2978, 2039, 2039])
    expect(capSideChannels(f.right)).toEqual([1535, 1535, 1868, 1868, 2101, 2101])
  })

  it('the occupied left side reads higher and moves; the empty right stays flat', () => {
    const span = (side: 'left' | 'right', ch: 'out' | 'cen' | 'in') => {
      const v = fixtures.capSense.map(f => f.decoded[side][ch])
      return Math.max(...v) - Math.min(...v)
    }
    const first = fixtures.capSense[0].decoded
    expect(first.left.out).toBeGreaterThan(first.right.out + 500)
    expect(first.left.cen).toBeGreaterThan(first.right.cen + 500)
    expect(span('left', 'cen')).toBeGreaterThan(20)
    expect(span('right', 'cen')).toBeLessThanOrEqual(3)
  })

  it('sensHealth reports both covers unlinked, which live cover frames override', () => {
    const health = fixtures.sensHealth[0].decoded as SensHealthFrame
    expect(health.left.connected).toBe(false)
    expect(health.right.connected).toBe(false)
    expect(disconnectedCovers(health)).toEqual(['left', 'right'])
    // bedTemp/capSense from the same capture window prove the cover is live.
    const liveCover = { ts: health.ts - 5 }
    expect(disconnectedCovers(health, [liveCover])).toEqual([])
  })

  it('blanketReadings reports no blanket, with one hub sensor mirrored to both sides', () => {
    for (const f of fixtures.blanketReadings) {
      expect(f.decoded.left.is_connected).toBe(false)
      expect(f.decoded.right.is_connected).toBe(false)
      expect(f.decoded.left).toEqual(f.decoded.right)
    }
  })
})
