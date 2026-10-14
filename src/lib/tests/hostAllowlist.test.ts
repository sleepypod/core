import { describe, expect, it } from 'vitest'
import { hostnameOf, isHostAllowed, parseAllowedHosts } from '../hostAllowlist'

describe('isHostAllowed', () => {
  it.each([
    '192.168.1.88',
    '192.168.1.88:3000',
    '10.0.0.5:80',
    '100.101.102.103:3000',
    '127.0.0.1:3000',
    '0.0.0.0:3000',
    '[::1]',
    '[::1]:3000',
    '[fe80::1c2b:3cff:fe4d:5e6f]:3000',
    '[::ffff:192.168.1.88]:3000',
    'localhost',
    'localhost:3000',
    'LOCALHOST:3000',
    'eight-pod',
    'eight-pod:3000',
    'eight-pod.local',
    'eight-pod.local:3000',
    'eight-pod.local.',
    'pod.lan:3000',
    'pod.home.arpa',
    'pod.internal:3000',
    'pod.localhost:3000',
  ])('allows %s', (host) => {
    expect(isHostAllowed(host)).toBe(true)
  })

  it.each([
    'attacker.example.com',
    'attacker.example.com:3000',
    '192.168.1.88.attacker.example.com',
    'example.com',
    'local.example.com',
    'pod.ts.net:3000',
    '256.1.1.1',
    '1.2.3',
    '[::1',
    '::1',
    'eight-pod:3000:3000',
    '',
  ])('rejects %j', (host) => {
    expect(isHostAllowed(host)).toBe(false)
  })

  it('allows exact extra hosts with or without a port', () => {
    const extra = parseAllowedHosts('pod.tail1234.ts.net, sleep.example.com:8443')
    expect(isHostAllowed('pod.tail1234.ts.net', extra)).toBe(true)
    expect(isHostAllowed('pod.tail1234.ts.net:3000', extra)).toBe(true)
    expect(isHostAllowed('sleep.example.com:8443', extra)).toBe(true)
    expect(isHostAllowed('sleep.example.com:3000', extra)).toBe(false)
    expect(isHostAllowed('other.tail1234.ts.net', extra)).toBe(false)
  })

  it('allows subdomains for wildcard extra hosts, not the bare suffix', () => {
    const extra = parseAllowedHosts('*.tail1234.ts.net')
    expect(isHostAllowed('pod.tail1234.ts.net:3000', extra)).toBe(true)
    expect(isHostAllowed('a.b.tail1234.ts.net', extra)).toBe(true)
    expect(isHostAllowed('tail1234.ts.net', extra)).toBe(false)
    expect(isHostAllowed('eviltail1234.ts.net', extra)).toBe(false)
    expect(isHostAllowed('attacker.example.com', extra)).toBe(false)
  })

  it('matches extra hosts case-insensitively', () => {
    expect(isHostAllowed('POD.Example.COM', parseAllowedHosts('pod.example.com'))).toBe(true)
    expect(isHostAllowed('pod.example.com', parseAllowedHosts('POD.EXAMPLE.COM'))).toBe(true)
  })
})

describe('parseAllowedHosts', () => {
  it.each([
    [undefined, []],
    ['', []],
    [' , ,', []],
    ['a.example.com, *.ts.net ,B.example.com', ['a.example.com', '*.ts.net', 'b.example.com']],
  ])('%j → %j', (raw, expected) => {
    expect(parseAllowedHosts(raw)).toEqual(expected)
  })
})

describe('hostnameOf', () => {
  it.each([
    ['Pod.Local:3000', 'pod.local'],
    ['pod.local.', 'pod.local'],
    ['[::1]:3000', '[::1]'],
    ['192.168.1.88', '192.168.1.88'],
    ['a:b:c', null],
  ])('%j → %j', (host, expected) => {
    expect(hostnameOf(host)).toBe(expected)
  })
})
