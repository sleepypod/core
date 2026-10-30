export function required<Value>(value: Value | null | undefined, description = 'alarm fixture'): Value {
  if (value === null || value === undefined) throw new Error(`Missing ${description}`)
  return value
}
