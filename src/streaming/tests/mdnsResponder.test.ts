// @vitest-environment node
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadDiscoveryResponder } from '../mdnsResponder'

it('loads the same installed ciao module used by HomeKit without starting a responder', () => {
  const applicationRequire = createRequire(join(process.cwd(), 'package.json'))
  const homeKitRequire = createRequire(applicationRequire.resolve('hap-nodejs'))
  expect(loadDiscoveryResponder().getResponder).toBe(homeKitRequire('@homebridge/ciao').getResponder)
  expect(homeKitRequire('@homebridge/ciao/package.json').version).toBe('1.3.12')
})
