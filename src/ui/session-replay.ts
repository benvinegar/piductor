import { summarizeToolCall, summarizeToolError } from "./agent-activity"

type SessionContentBlock = {
  type?: string
  text?: string
  thinking?: string
  name?: string
  arguments?: unknown
}

type SessionMessageRecord = {
  role?: string
  content?: unknown
  toolName?: string
  isError?: boolean
}

type SessionEntry = {
  type?: string
  message?: SessionMessageRecord
}

function appendNonEmptyLines(lines: string[], value: string, prefix = "") {
  for (const row of value.split(/\r?\n/)) {
    const trimmed = row.trim()
    if (trimmed.length === 0) {
      continue
    }

    lines.push(prefix.length > 0 ? `${prefix}${trimmed}` : trimmed)
  }
}

function replayAssistantContent(lines: string[], content: unknown) {
  if (typeof content === "string") {
    appendNonEmptyLines(lines, content)
    return
  }

  if (!Array.isArray(content)) {
    return
  }

  for (const blockValue of content) {
    if (!blockValue || typeof blockValue !== "object") {
      continue
    }

    const block = blockValue as SessionContentBlock

    if (block.type === "thinking" && typeof block.thinking === "string") {
      appendNonEmptyLines(lines, block.thinking, "[thinking] ")
      continue
    }

    if (block.type === "toolCall") {
      lines.push(`[tool] ${summarizeToolCall(block.name, block.arguments)}`)
      continue
    }

    if (typeof block.text === "string") {
      appendNonEmptyLines(lines, block.text)
    }
  }
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
      if (typeof parsed.message.content === "string") {
        appendNonEmptyLines(lines, parsed.message.content, "[you/prompt] ")
      } else if (Array.isArray(parsed.message.content)) {
        for (const blockValue of parsed.message.content) {
          if (!blockValue || typeof blockValue !== "object") {
            continue
          }

          const block = blockValue as SessionContentBlock
          if (typeof block.text === "string") {
            appendNonEmptyLines(lines, block.text, "[you/prompt] ")
          }
        }
      }
      continue
    }

    if (role === "assistant") {
      replayAssistantContent(lines, parsed.message.content)
      lines.push("[assistant-break]")
      continue
    }

    if (role === "toolResult" && parsed.message.isError) {
      const detail = summarizeToolError(parsed.message.toolName, { content: parsed.message.content })
      lines.push(`[tool:error] ${detail}`)
    }
  }

  if (lines.length <= maxLines) {
    return lines
  }

  return lines.slice(lines.length - maxLines)
}
