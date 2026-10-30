import { formatResetCountdown, type QuotaSnapshot } from "./usage.js"

export const COLOR_KEYS = ["percent5h", "percent7d", "reset5h", "reset7d"] as const
export type ColorKey = (typeof COLOR_KEYS)[number]
export type Variable = ColorKey
export interface DisplaySettings {
  template: string
  defaultColor?: string
  colors: Record<ColorKey, string>
}
export const DEFAULT_SETTINGS: DisplaySettings = {
  template: "{percent5h} {percent7d} | {reset5h} {reset7d}",
  defaultColor: "#808080",
  colors: { percent5h: "#02dbf7", percent7d: "#f3f702", reset5h: "#02dbf7", reset7d: "#f3f702" },
}
export type TemplateToken = { text: string } | { variable: Variable }
export interface DisplaySegment { text: string; color?: string }

export function validateText(value: string, maxLength: number): void {
  if (value.length > maxLength) throw new Error(`Maximum length is ${maxLength} characters`)
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value)) {
    throw new Error("Use a single line without terminal control characters")
  }
}

// Only named placeholders are interpreted. No expressions, HTML, or executable code.
export function parseTemplate(template: string): TemplateToken[] {
  validateText(template, 500)
  const tokens: TemplateToken[] = []
  let offset = 0
  const pattern = /\{([^{}]*)\}/g
  for (const match of template.matchAll(pattern)) {
    const text = template.slice(offset, match.index)
    if (/[{}]/.test(text)) throw new Error("Unmatched template brace")
    if (text) tokens.push({ text })
    const name = match[1]
    if (!COLOR_KEYS.includes(name as ColorKey)) {
      throw new Error(`Unknown variable: {${name}}`)
    }
    tokens.push({ variable: name as Variable })
    offset = match.index! + match[0].length
  }
  const tail = template.slice(offset)
  if (/[{}]/.test(tail)) throw new Error("Unmatched template brace")
  if (tail) tokens.push({ text: tail })
  return tokens
}

export function validateColor(value: string): string {
  const color = value.trim()
  if (color && !/^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) {
    throw new Error("Use #RRGGBB, #RRGGBBAA, or leave empty for the theme color")
  }
  return color.toLowerCase()
}

export function renderTemplate(settings: DisplaySettings, snapshot: QuotaSnapshot | null, now = Date.now()): DisplaySegment[] {
  const values: Record<Variable, string> = {
    percent5h: snapshot?.primaryRemaining == null ? "—" : `${snapshot.primaryRemaining}%`,
    percent7d: snapshot?.secondaryRemaining == null ? "—" : `${snapshot.secondaryRemaining}%`,
    reset5h: formatResetCountdown(snapshot?.primaryResetAt, now),
    reset7d: formatResetCountdown(snapshot?.secondaryResetAt, now),
  }
  const tokens = parseTemplate(settings.template)
  const defaultColor = settings.defaultColor || undefined
  return tokens.map((token): DisplaySegment => {
    if ("variable" in token) {
      const key = token.variable
      return { text: values[key], color: settings.colors[key] || defaultColor }
    }
    return { text: token.text, color: defaultColor }
  })
}

// Called only for saved settings from before prefix became literal template text.
export function migratePrefix(settings: DisplaySettings & { prefix: string }): DisplaySettings {
  const { prefix, ...rest } = settings
  const template = prefix
    ? settings.template.replace(/\{prefix\}/g, () => prefix)
    : settings.template.replace(/ *\{prefix\} */g, "")
  return { ...rest, template }
}
