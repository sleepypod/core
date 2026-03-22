/**
 * AI Curve Prompt Generator & JSON Parser
 * Mirrors iOS CurveGenerator.swift — offloads curve generation to external AI
 * via copy/paste prompt workflow (no API keys needed).
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface GeneratedCurve {
  name: string
  bedtime: string    // "HH:mm"
  wake: string       // "HH:mm"
  points: Record<string, number>  // "HH:mm" → tempF
  reasoning: string
}

export interface CurveTemplate extends GeneratedCurve {
  createdAt: number  // Date.now()
}

// ─── Prompt Generation ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a board-certified sleep medicine physician with expertise in thermoregulation and circadian biology. Based on the user's sleep preferences below, generate an optimal nightly temperature curve for a water-based bed temperature control system.

**System capabilities:**
- Water temperature range: 55°F to 110°F
- Neutral (body-neutral) temperature: ~82.5°F
- Typical comfortable sleep range: 65°F to 90°F

**Sleep science context:**
- Cooling the body before sleep promotes deep sleep onset (Heller & Grahn, Stanford)
- Core body temperature drops ~2°F by 3 AM at the circadian nadir (Kräuchi, University of Basel)
- Gradual warming before wake supports the cortisol awakening response (Czeisler, Harvard)
- Growth hormone release peaks during deep sleep in cooler conditions
- The system heats/cools water in tubing — changes take ~15–20 min to stabilize

**Individual variation guidance:**
Consider the user's thermal phenotype (hot sleeper vs cold sleeper), chronotype (early bird vs night owl), and any mentioned conditions (e.g., menopause, chronic pain, post-exercise recovery). Adjust the curve aggressiveness and temperature floor/ceiling accordingly.`

export function generatePrompt(preferences: string): string {
  return `${SYSTEM_PROMPT}

**User's sleep preferences:**
${preferences}

**Instructions:**
- Generate 8–15 temperature set points spanning from bedtime minus 45 minutes through wake plus 30 minutes
- Include: warm-up phase before bed, cooling ramp after bedtime, deep-sleep cold hold, gradual pre-wake warming, post-wake return to neutral
- All temperatures must be integers between 55 and 110 (°F)
- Times must be in 24-hour "HH:mm" format

Respond ONLY with the following JSON object, no other text:
{
  "name": "Short title (2-3 words max, e.g. Deep Cool, Gentle Warm, Athletic Recovery)",
  "bedtime": "HH:mm",
  "wake": "HH:mm",
  "points": {
    "HH:mm": temperatureF,
    "HH:mm": temperatureF
  },
  "reasoning": "Brief explanation of the curve design choices"
}

IMPORTANT: The "name" field must be 2-3 words maximum. It is used as a label in the UI.`
}

// ─── Example Suggestions ─────────────────────────────────────────────

export const EXAMPLE_SUGGESTIONS = [
  "I run hot, bed at 11pm, wake 6:30. Really cold first few hours.",
  "Light sleeper, cold feet. Warm start, gentle cooling, warm wake at 7am.",
  "Post-workout recovery. Bed 10pm, wake 6am. Extra cold for muscles.",
  "I'm always cold. Minimal cooling, cozy all night. Bed 11:30, wake 7:30.",
]

// ─── JSON Parsing & Validation ───────────────────────────────────────

const TIME_RE = /^\d{2}:\d{2}$/

export type ParseResult = {
  success: true
  curve: GeneratedCurve
} | {
  success: false
  error: string
}

export function parseAIResponse(raw: string): ParseResult {
  // Strip markdown code fences
  let json = raw.trim()
  json = json.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')

  // Try to extract JSON object if surrounded by text
  const braceStart = json.indexOf('{')
  const braceEnd = json.lastIndexOf('}')
  if (braceStart !== -1 && braceEnd > braceStart) {
    json = json.slice(braceStart, braceEnd + 1)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json)
  } catch {
    return { success: false, error: 'Invalid JSON. Make sure you copied the complete response.' }
  }

  // Validate required fields
  if (typeof parsed.bedtime !== 'string' || !TIME_RE.test(parsed.bedtime)) {
    return { success: false, error: 'Missing or invalid "bedtime" field (expected "HH:mm").' }
  }
  if (typeof parsed.wake !== 'string' || !TIME_RE.test(parsed.wake)) {
    return { success: false, error: 'Missing or invalid "wake" field (expected "HH:mm").' }
  }
  if (typeof parsed.points !== 'object' || parsed.points === null || Array.isArray(parsed.points)) {
    return { success: false, error: 'Missing or invalid "points" field (expected object).' }
  }

  const points: Record<string, number> = {}
  const rawPoints = parsed.points as Record<string, unknown>
  const entries = Object.entries(rawPoints)

  if (entries.length < 3) {
    return { success: false, error: `Need at least 3 set points, got ${entries.length}.` }
  }

  for (const [time, temp] of entries) {
    if (!TIME_RE.test(time)) {
      return { success: false, error: `Invalid time format "${time}" (expected "HH:mm").` }
    }
    const t = Number(temp)
    if (!Number.isFinite(t)) {
      return { success: false, error: `Invalid temperature for ${time}: ${temp}` }
    }
    // Clamp to valid range
    points[time] = Math.max(55, Math.min(110, Math.round(t)))
  }

  const name = typeof parsed.name === 'string' ? parsed.name.slice(0, 30) : 'Custom Curve'
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : ''

  return {
    success: true,
    curve: {
      name,
      bedtime: parsed.bedtime as string,
      wake: parsed.wake as string,
      points,
      reasoning,
    },
  }
}

// ─── Template Persistence (localStorage) ─────────────────────────────

const STORAGE_KEY = 'sleepypod_curve_templates'

export function loadTemplates(): CurveTemplate[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveTemplate(curve: GeneratedCurve): CurveTemplate {
  const templates = loadTemplates()
  const template: CurveTemplate = { ...curve, createdAt: Date.now() }

  // Replace if same name exists, otherwise prepend
  const idx = templates.findIndex(t => t.name === curve.name)
  if (idx >= 0) {
    templates[idx] = template
  } else {
    templates.unshift(template)
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates))
  return template
}

export function deleteTemplate(name: string): void {
  const templates = loadTemplates().filter(t => t.name !== name)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates))
}
