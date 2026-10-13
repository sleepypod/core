import type { DemoHandlers, RouterOutputs } from '../types'

type Template = RouterOutputs['curveTemplates']['list'][number]

const templates: Template[] = []
let nextId = 1

export const curveTemplates: DemoHandlers<'curveTemplates'> = {
  list: () => [...templates].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),

  save: (input) => {
    const now = new Date()
    const existing = templates.find(t => t.name === input.name)
    if (existing) {
      Object.assign(existing, { ...input, reasoning: input.reasoning ?? '', updatedAt: now })
      return existing
    }
    const created: Template = { id: nextId++, ...input, reasoning: input.reasoning ?? '', createdAt: now, updatedAt: now }
    templates.push(created)
    return created
  },

  delete: (input) => {
    const i = templates.findIndex(t => t.name === input.name)
    if (i >= 0) templates.splice(i, 1)
    return { deleted: i >= 0 }
  },
}
