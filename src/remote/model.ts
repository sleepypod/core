import { z } from 'zod'
export const SIDES = ['left', 'right'] as const
export type Side = typeof SIDES[number]
export const BUTTONS = [
  { id: 'top', label: 'Top', glyph: '+', short: 'T', bit: 4 },
  { id: 'mid', label: 'Middle', glyph: '•', short: 'M', bit: 2 },
  { id: 'bottom', label: 'Bottom', glyph: '−', short: 'B', bit: 1 },
] as const
export type Source = typeof BUTTONS[number]['id']
// Stable handoff IDs use physical order, despite its contradictory alphabetical note.
export const INPUTS = ['top.single', 'mid.single', 'bottom.single', 'top.double', 'mid.double', 'bottom.double', 'top+mid.single', 'mid+bottom.single', 'top+bottom.single'] as const
export type InputId = typeof INPUTS[number]
export const BASE_INPUTS: readonly InputId[] = INPUTS.slice(0, 3)
export const inputSchema = z.enum(INPUTS)
export const sideSchema = z.enum(SIDES)
export const bindingSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('none') }).strict(),
  z.object({ action: z.enum(['temp.up', 'temp.down']), deltaF: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
  z.object({ action: z.literal('temp.preset'), temperatureF: z.number().int().min(55).max(110) }).strict(),
  z.object({ action: z.enum(['power.toggle', 'power.off', 'alarm.off', 'away.toggle', 'prime.start']) }).strict(),
  z.object({ action: z.literal('alarm.snooze'), durationSec: z.union([z.literal(300), z.literal(540), z.literal(900)]) }).strict(),
  z.object({ action: z.literal('automation.run'), automationId: z.number().int().positive() }).strict(),
])
export type Binding = z.infer<typeof bindingSchema>
export type RemoteMap = Partial<Record<InputId, Binding>>
export const remoteMapSchema = z.record(z.string(), bindingSchema).superRefine((value, ctx) => {
  for (const key of Object.keys(value))
    if (!inputSchema.safeParse(key).success)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown input: ${key}` })
})
export const configSchema = z.object({
  revision: z.number().int().nonnegative(),
  left: remoteMapSchema,
  right: remoteMapSchema,
  extras: z.object({ left: z.array(inputSchema).max(6), right: z.array(inputSchema).max(6) }).strict(),
}).strict()
export type RemoteConfig = z.infer<typeof configSchema>
/** Create an empty revision-zero mapping that inherits native firmware behavior. */
export function emptyConfig(): RemoteConfig {
  return { revision: 0, left: {}, right: {}, extras: { left: [], right: [] } }
}
export const editSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set'), input: inputSchema, binding: bindingSchema }).strict(),
  z.object({ kind: z.enum(['reset', 'add', 'remove']), input: inputSchema }).strict(),
  z.object({ kind: z.enum(['resetSide', 'copy']) }).strict(),
])
export type Edit = z.infer<typeof editSchema>
/** Apply one immutable side edit and advance the shared revision; base rows cannot be removed. */
export function editConfig(current: RemoteConfig, side: Side, edit: Edit): RemoteConfig {
  const next = structuredClone(current)

  if (edit.kind === 'set')
    next[side][edit.input] = edit.binding
  else if (edit.kind === 'reset')
    next[side] = Object.fromEntries(Object.entries(next[side]).filter(([id]) => id !== edit.input))
  else if (edit.kind === 'add') {
    if (!BASE_INPUTS.includes(edit.input) && !next.extras[side].includes(edit.input))
      next.extras[side].push(edit.input)
  }
  else if (edit.kind === 'remove') {
    if (BASE_INPUTS.includes(edit.input))
      throw new Error('The three single presses cannot be removed')

    next[side] = Object.fromEntries(Object.entries(next[side]).filter(([id]) => id !== edit.input))

    next.extras[side] = next.extras[side].filter(id => id !== edit.input)
  }
  else if (edit.kind === 'resetSide') {
    next[side] = {}

    next.extras[side] = []
  }
  else if (edit.kind === 'copy') {
    const other = side === 'left' ? 'right' : 'left'

    next[other] = structuredClone(next[side])

    next.extras[other] = [...next.extras[side]]
  }

  next.revision++

  return next
}
/** Extract recognized physical buttons from a single or combination input ID. */
export function parts(id: string): Source[] {
  return id.split('.')[0].split('+').filter((p): p is Source => BUTTONS.some(b => b.id === p))
}
/** Format an input ID for mapping rows and detection capture. */
export function inputLabel(id: string): string {
  const label = parts(id).map(p => BUTTONS.find(b => b.id === p)?.label ?? p).join(' + ')

  return parts(id).length > 1 ? label : `${label} · ${id.split('.')[1]}`
}
/** Describe the physical input without claiming an unverified firmware timing window. */
export function inputHint(id: string): string {
  return `${parts(id).map(p => BUTTONS.find(b => b.id === p)?.short ?? p).join(' + ')}${id.endsWith('.double') ? '×2 · firmware count' : parts(id).length > 1 ? ' · together' : ' · press'}`
}
export const ACTIONS = [
  { id: 'none', label: 'Nothing' }, { id: 'temp.up', label: 'Temperature up' },
  { id: 'temp.down', label: 'Temperature down' }, { id: 'temp.preset', label: 'Set temperature' },
  { id: 'power.toggle', label: 'Toggle power' }, { id: 'power.off', label: 'Turn side off' },
  { id: 'alarm.snooze', label: 'Snooze alarm' }, { id: 'alarm.off', label: 'Dismiss alarm' },
  { id: 'elev.preset', label: 'Go to elevation preset', unavailable: 'Elevation control is not implemented on this device' },
  { id: 'elev.step', label: 'Raise / lower head', unavailable: 'Elevation control is not implemented on this device' },
  { id: 'sound.toggle', label: 'Play / pause soundscape', unavailable: 'Soundscape control is not implemented on this device' },
  { id: 'sound.next', label: 'Next soundscape', unavailable: 'Soundscape control is not implemented on this device' },
  { id: 'away.toggle', label: 'Toggle away mode' }, { id: 'prime.start', label: 'Start priming' },
  { id: 'automation.run', label: 'Run an automation…' },
] as const
/** Build validated initial parameters for an available action; invalid actions or IDs throw. */
export function defaultBinding(action: string, automationId?: number): Binding {
  switch (action) {
    case 'temp.up':
    case 'temp.down': return { action, deltaF: 1 }
    case 'temp.preset': return { action, temperatureF: 68 }
    case 'alarm.snooze': return { action, durationSec: 540 }
    case 'automation.run': return bindingSchema.parse({ action, automationId })
    default: return bindingSchema.parse({ action })
  }
}
/** Resolve a binding to display text, including inherited defaults and deleted automations. */
export function describe(binding: Binding | undefined, automations: {
  id: number
  name: string
}[] = []): string {
  if (!binding)
    return 'Firmware default'

  const label = ACTIONS.find(a => a.id === binding.action)?.label ?? binding.action

  if ('deltaF' in binding)
    return `${label} ${binding.deltaF}°F`

  if ('temperatureF' in binding)
    return `${label} ${binding.temperatureF}°F`

  if ('durationSec' in binding)
    return `${label} ${binding.durationSec / 60} min`

  if ('automationId' in binding)
    return `Run “${automations.find(a => a.id === binding.automationId)?.name ?? 'Deleted automation'}”`

  return label
}
export const detectionSchema = z.object({
  id: z.string().min(1).max(512),
  side: sideSchema,
  mask: z.number().int().min(1).max(7),
  gesture: z.enum(['single', 'double', 'combo', 'unsupported']),
  inputId: z.string().min(1).max(100),
  t: z.number().nonnegative(),
  receivedAt: z.number().nonnegative(),
  latencyMs: z.number().nonnegative().nullable(),
  detail: z.string().optional(),
  outcome: z.string().optional(),
})
export type Detection = z.infer<typeof detectionSchema>
