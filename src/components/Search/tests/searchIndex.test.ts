import { setupI18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { SECTIONS } from '@/src/components/Settings/sections'
import { SYSTEM_TABS } from '@/src/components/System/systemTabs'
import { DOCS_BASE, isDocsIndex, type DocsIndex } from '../docsIndex'
import docsSnapshot from '../docsIndex.json'
import { buildDocsEntries, buildSearchEntries, createSearch } from '../searchIndex'

const i18n = setupI18n({ locale: 'en', messages: { en: {} } })
i18n.activate('en')
const entries = buildSearchEntries(i18n, { hasBase: false })
const search = createSearch(entries)
const top = (q: string) => search(q)[0]

const snapshot = docsSnapshot as DocsIndex
const docsEntries = buildDocsEntries(i18n, snapshot)
const withDocs = createSearch([...entries, ...docsEntries])

describe('search index', () => {
  it('indexes every page, sub-view and section, hiding Base until one is configured', () => {
    const ids = new Set(entries.map(e => e.id))
    expect(ids.has('nav:base')).toBe(false)
    expect(buildSearchEntries(i18n, { hasBase: true }).some(e => e.id === 'nav:base')).toBe(true)
    for (const sec of SECTIONS) expect(ids.has(`settings:${sec.id}`)).toBe(true)
    for (const tab of SYSTEM_TABS) expect(ids.has(`system:${tab.id}`)).toBe(true)
    for (const id of ['sleep:nights', 'sleep:biometrics', 'autopilot:automations', 'autopilot:diagnostics']) expect(ids.has(id)).toBe(true)
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length)
  })

  it.each(['firewall', 'internet', 'wifi', 'Wi-Fi'])('ranks Settings › Network first for "%s"', (q) => {
    const hit = top(q)
    expect(hit.href).toBe('/settings?section=network')
    expect([...hit.crumbs, hit.title].slice(0, 2)).toEqual(['Settings', 'Network'])
  })

  it('ranks Settings › Biometric calibration first for "calibration"', () => {
    const hits = search('calibration')
    expect(hits[0].id).toBe('settings:biometric-calibration')
    expect(hits.map(h => h.id)).toContain('system:calibration')
  })

  it('finds controls by heading and by synonym, linking to their section', () => {
    expect(top('pump stall')).toMatchObject({ title: 'Pump stall protection', crumbs: ['Settings', 'Device'], href: '/settings?section=device' })
    expect(top('home assistant').href).toBe('/settings?section=mqtt')
    expect(top('vacation')).toMatchObject({ title: 'Away mode', href: '/settings?section=sides' })
    expect(top('dark mode')).toMatchObject({ title: 'Theme', href: '/settings?section=appearance' })
  })

  it('matches the token being typed as a prefix', () => {
    expect(top('calib').href).toBe('/settings?section=biometric-calibration')
    expect(top('homek').title).toBe('HomeKit')
    expect(top('sched').href).toBe('/schedule')
  })

  it('links sub-views to their query-string routes', () => {
    expect(top('biometrics').href).toBe('/sleep?view=biometrics')
    expect(entries.find(e => e.id === 'system:dashboard')?.href).toBe('/system')
    expect(entries.find(e => e.id === 'system:logs')?.href).toBe('/system?tab=logs')
    expect(entries.find(e => e.id === 'autopilot:diagnostics')?.href).toBe('/autopilot?view=diagnostics')
  })

  it('returns nothing for an empty query', () => {
    expect(search('')).toEqual([])
  })
})

describe('docs snapshot', () => {
  const page = { path: '/a/', title: 'A', section: null, description: '', headings: [], keywords: '' }
  const valid: DocsIndex = { version: 1, generatedAt: '2026-10-31T00:00:00Z', base: DOCS_BASE, pages: [page] }

  it('matches the version 1 contract', () => {
    expect(isDocsIndex(docsSnapshot)).toBe(true)
    expect(snapshot.pages.length).toBeGreaterThan(0)
    expect(new Set(docsEntries.map(e => e.id)).size).toBe(docsEntries.length)
  })

  it.each([
    ['another version', { ...valid, version: 2 }],
    ['another origin', { ...valid, base: 'https://example.com' }],
    ['no pages', { ...valid, pages: [] }],
    ['a protocol-relative path', { ...valid, pages: [{ ...page, path: '//example.com/' }] }],
    ['a backslash path that leaves the docs origin', { ...valid, pages: [{ ...page, path: '/\\example.com/' }] }],
    ['a page without a title', { ...valid, pages: [{ ...page, title: ' ' }] }],
    ['a malformed heading', { ...valid, pages: [{ ...page, headings: [{ title: 'x' }] }] }],
    ['a non-string section', { ...valid, pages: [{ ...page, section: 3 }] }],
    ['a repeated path', { ...valid, pages: [page, page] }],
    ['an array', [valid]],
    ['null', null],
  ])('rejects %s', (_, payload) => {
    expect(isDocsIndex(valid)).toBe(true)
    expect(isDocsIndex(payload)).toBe(false)
  })

  it('maps each page to an external docs entry under Docs and its section', () => {
    const network = docsEntries.find(e => e.id === 'docs:/core/settings/network/')
    expect(network).toMatchObject({ title: 'Network', crumbs: ['Docs', 'Core'], external: true, href: `${DOCS_BASE}/core/settings/network/` })
    expect(docsEntries.find(e => e.id === 'docs:/privacy/')?.crumbs).toEqual(['Docs'])
    for (const e of docsEntries) expect(e.href.startsWith(`${DOCS_BASE}/`)).toBe(true)
  })

  it('finds docs pages by title and by heading', () => {
    expect(withDocs('troubleshooting')[0].external).toBe(true)
    const byHeading = buildDocsEntries(i18n, { ...valid, pages: [{ ...page, title: 'Install', headings: [{ title: 'Flash the zeppelin', anchor: 'flash' }] }] })
    expect(createSearch([...entries, ...byHeading])('zeppelin')[0].id).toBe('docs:/a/')
  })

  it('keeps an app page or setting ahead of a docs page with the same name', () => {
    for (const e of entries) {
      expect(withDocs(e.title)[0].external, e.title).toBeUndefined()
    }
    for (const q of ['firewall', 'internet', 'wifi', 'calibration', 'pump stall', 'home assistant', 'vacation', 'dark mode']) {
      expect(withDocs(q)[0].external, q).toBeUndefined()
      expect(withDocs(q)[0].href, q).toBe(search(q)[0].href)
    }
  })
})
