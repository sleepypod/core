import { assert } from 'vitest'
import { templateRule } from '../builderModel'

export function requiredTemplate(name: string) {
  const rule = templateRule(name)
  assert(rule, `Missing automation template: ${name}`)
  return rule
}
