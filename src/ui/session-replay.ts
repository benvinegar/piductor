type SessionContentBlock = {
  type?: string
  text?: string
}

type SessionMessageRecord = {
  role?: string
  content?: unknown
}

type SessionEntry = {
  type?: string
  message?: SessionMessageRecord
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim()
  }

  if (!Array.isArray(value)) {
    return ""
  }

  const text = value
    .map((block) => {
      if (!block || typeof block !== "object") {
        return ""
      }

      const content = block as SessionContentBlock
      if (typeof content.text === "string") {
        return content.text
      }

      return ""
    })
    .filter(Boolean)
    .join("\n")

  return text.trim()
}

export function replaySessionMessagesToLogLines(sessionJsonl: string, maxLines = 500): string[] {
  const lines: string[] = []
  const rows = sessionJsonl.split(/\r?\n/)

  for (const row of rows) {
    const trimmed = row.trim()
    if (!trimmed) {
      continue
    }

    let parsed: SessionEntry
    try {
      parsed = JSON.parse(trimmed) as SessionEntry
    } catch {
      continue
    }

    if (parsed.type !== "message" || !parsed.message) {
      continue
    }

    const role = parsed.message.role
    if (role === "user") {
      const content = extractText(parsed.message.content)
      if (content.length > 0) {
        lines.push(`[you/prompt] ${content}`)
      }
      continue
    }

    if (role === "assistant") {
      const content = extractText(parsed.message.content)
      if (content.length > 0) {
        for (const line of content.split(/\r?\n/)) {
          if (line.trim().length > 0) {
            lines.push(line)
          }
        }
      }
      lines.push("[assistant-break]")
    }
  }

  if (lines.length <= maxLines) {
    return lines
  }

  return lines.slice(lines.length - maxLines)
}
