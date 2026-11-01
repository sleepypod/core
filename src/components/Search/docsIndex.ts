/**
 * Contract for the docs site's search index (version 1), shared by the
 * palette and `scripts/sync-docs-index.mjs`. No imports: Node runs this file
 * directly with type stripping.
 */

export const DOCS_BASE = 'https://sleepypod.github.io'
export const DOCS_INDEX_URL = `${DOCS_BASE}/search-index.json`

export interface DocsHeading {
  title: string
  anchor: string
}

export interface DocsPage {
  /** Site path with a leading slash: '/getting-started/'. */
  path: string
  title: string
  section: string | null
  description: string
  headings: DocsHeading[]
  /** Space-separated. */
  keywords: string
}

export interface DocsIndex {
  version: 1
  generatedAt: string
  base: string
  pages: DocsPage[]
}

const MAX_PAGES = 2000
const MAX_HEADINGS = 200

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max

/** A site path that still resolves on the docs origin ('/\evil.example/' would not). */
function isDocsPath(v: unknown): v is string {
  if (!isText(v, 500) || !v.startsWith('/')) return false
  try {
    return new URL(v, DOCS_BASE).origin === DOCS_BASE
  }
  catch {
    return false
  }
}

function isHeading(v: unknown): v is DocsHeading {
  return isObject(v) && isText(v.title, 300) && v.title.trim() !== '' && isText(v.anchor, 300)
}

function isPage(v: unknown): v is DocsPage {
  return isObject(v)
    && isDocsPath(v.path)
    && isText(v.title, 300) && v.title.trim() !== ''
    && (v.section === null || isText(v.section, 300))
    && isText(v.description)
    && Array.isArray(v.headings) && v.headings.length <= MAX_HEADINGS && v.headings.every(isHeading)
    && isText(v.keywords)
}

/** True only for a version 1 index served from the docs site with well-formed, uniquely pathed pages. */
export function isDocsIndex(v: unknown): v is DocsIndex {
  return isObject(v)
    && v.version === 1
    && isText(v.generatedAt, 100)
    && v.base === DOCS_BASE
    && Array.isArray(v.pages) && v.pages.length > 0 && v.pages.length <= MAX_PAGES
    && v.pages.every(isPage)
    && new Set(v.pages.map(p => p.path)).size === v.pages.length
}

const REFRESH_TIMEOUT_MS = 3000

let live: Promise<DocsIndex | null> | undefined

/**
 * The live index, fetched at most once per page load. Resolves to null when
 * the pod is offline, the request times out, or the payload fails the
 * contract, so callers keep the bundled snapshot. JSON only, no credentials.
 */
export function loadLiveDocsIndex(): Promise<DocsIndex | null> {
  live ??= (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
    try {
      const res = await fetch(DOCS_INDEX_URL, {
        credentials: 'omit',
        mode: 'cors',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!res.ok) return null
      const body: unknown = await res.json()
      return isDocsIndex(body) ? body : null
    }
    catch {
      return null
    }
    finally {
      clearTimeout(timer)
    }
  })()
  return live
}

/** Forget the cached live index. Tests only. */
export function resetLiveDocsIndex() {
  live = undefined
}
