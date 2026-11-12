import { reportEvidenceTitles, type SavedMorningReport } from './morning'

export interface ReportBlock {
  kind: 'heading' | 'paragraph' | 'bullet' | 'quote' | 'code' | 'table'
  text: string
  evidence: string[]
  level?: number
  marker?: string
  cells?: string[][]
}
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(value => value.trim())
const separator = (line: string) => cells(line).every(value => /^:?-{3,}:?$/.test(value))

/** Match native's bounded display grammar; prose never creates HTML, remote images or navigable links. */
export function reportBlocks(text: string, facts: SavedMorningReport['facts']): ReportBlock[] {
  const allowed = new Set(facts.filter(fact => reportEvidenceTitles[fact.id]).map(fact => fact.id))
  const result: ReportBlock[] = []
  let paragraph: string[] = [], code: string[] | null = null
  const append = (body: string, kind: ReportBlock['kind'], extra: Partial<ReportBlock> = {}) => {
    const evidence: string[] = []
    const content = ['code', 'table'].includes(kind)
      ? body
      : body.replace(/\[([a-z][a-z0-9_.-]*)\](?!\()/g, (whole, identifier: string) => {
          if (!allowed.has(identifier)) return whole
          if (!evidence.includes(identifier)) evidence.push(identifier)
          return ''
        })
    result.push({ kind, text: content.trim(), evidence, ...extra })
  }
  const flush = () => {
    if (paragraph.length) append(paragraph.join('\n'), 'paragraph')
    paragraph = []
  }
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index], line = raw.trim()
    if (line.startsWith('```')) {
      flush()
      if (code !== null) {
        append(code.join('\n'), 'code')
        code = null
      }
      else code = []
      continue
    }
    if (code !== null) {
      code.push(raw)
      continue
    }
    if (!line || ['---', '***', '___'].includes(line)) {
      flush()
      continue
    }
    if (line.includes('|') && lines[index + 1] !== undefined && separator(lines[index + 1])) {
      flush()
      const rows = [cells(line)]
      index++
      while (lines[index + 1]?.includes('|')) rows.push(cells(lines[++index]))
      append('', 'table', { cells: rows })
      continue
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line)
    const bullet = /^(?:([-*+]) |(\d+)\. )(.*)$/.exec(line)
    if (heading) {
      flush()
      append(heading[2], 'heading', { level: heading[1].length })
      continue
    }
    if (bullet) {
      flush()
      append(bullet[3], 'bullet', { marker: bullet[2] ? `${bullet[2]}.` : '•' })
      continue
    }
    if (line.startsWith('> ')) {
      flush()
      append(line.slice(2), 'quote')
      continue
    }
    paragraph.push(line)
  }
  flush()
  if (code !== null) append(code.join('\n'), 'code')
  return result
}

export function reportExperiment(blocks: ReportBlock[]): ReportBlock[] | null {
  const headings = blocks.flatMap((block, index) => block.kind === 'heading'
    && ['one experiment to consider', 'one optional experiment'].includes(block.text.replaceAll('**', '').replaceAll('__', '').trim().toLowerCase())
    ? [index]
    : [])
  if (headings.length !== 1) return null
  const start = headings[0], level = blocks[start].level ?? 1
  const end = blocks.findIndex((block, index) => index > start && block.kind === 'heading' && (block.level ?? 1) <= level)
  const content = blocks.slice(start + 1, end === -1 ? undefined : end)
  return content.some(block => block.text.length > 0) && content.reduce((count, block) => count + block.text.length, 0) <= 1200 ? content : null
}

export interface InlineRun { kind: 'text' | 'strong' | 'emphasis' | 'code', text: string }
export function reportInline(text: string): InlineRun[] {
  // Remove destinations, retaining readable labels. React still escapes all literal HTML.
  const source = text.replace(/!?\[([^\]\n]+)\]\([^\n)]*\)/g, '$1')
  const pattern = /(\*\*|__)([^\n]+?)\1|`([^`\n]+)`|(?:\*([^*\n]+)\*|_([^_\n]+)_)/g
  const output: InlineRun[] = []
  let start = 0
  for (const match of source.matchAll(pattern)) {
    if (match.index > start) output.push({ kind: 'text', text: source.slice(start, match.index) })
    output.push({ kind: match[2] ? 'strong' : match[3] ? 'code' : 'emphasis', text: match[2] ?? match[3] ?? match[4] ?? match[5] })
    start = match.index + match[0].length
  }
  if (start < source.length) output.push({ kind: 'text', text: source.slice(start) })
  return output
}
