const DEFAULT_MAX_CHARS = 180

export function compactThinkingPreview(value: string, maxChars = DEFAULT_MAX_CHARS): string {
  const compact = value.replace(/\s+/g, " ").trim()
  if (compact.length === 0) {
    return ""
  }

  if (compact.length <= maxChars) {
    return compact
  }

  if (maxChars <= 1) {
    return "…"
  }

  return `${compact.slice(0, maxChars - 1).trimEnd()}…`
}
