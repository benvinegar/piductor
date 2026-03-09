export const DEFAULT_CONVERSATION = "_No conversation yet. Start an agent and send a prompt._"
const MESSAGE_SPACER = "────────────────────────────────────────────────────────────────────────────"
const MAX_RENDER_LINES = 300

function stripTimestamp(line: string): string {
  return line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "")
}

function findLastUserLineIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = stripTimestamp(lines[index] ?? "")
    if (line.startsWith("[you/")) {
      return index
    }
  }

  return -1
}

export function formatUserMessageBox(content: string): string {
  const rawLines = content.split(/\r?\n/).map((line) => line.trimEnd())
  const lines = rawLines.length > 0 ? rawLines : [""]
  const longest = Math.max(...lines.map((line) => line.length), 8)
  const width = Math.min(72, Math.max(8, longest))

  const clipped = lines.map((line) => {
    if (line.length <= width) return line
    return `${line.slice(0, Math.max(0, width - 1))}…`
  })

  const top = `╭${"─".repeat(width + 2)}╮`
  const body = clipped.map((line) => `│ ${line}${" ".repeat(Math.max(0, width - line.length))} │`)
  const bottom = `╰${"─".repeat(width + 2)}╯`
  return [top, ...body, bottom].join("\n")
}

export function formatAssistantMessageRail(content: string): string {
  return content
}

function extractTaggedContent(line: string, tag: string): string | null {
  const token = `[${tag}]`
  if (!line.startsWith(token)) {
    return null
  }

  const content = line.slice(token.length)
  return content.startsWith(" ") ? content.slice(1) : content
}

function normalizeThinkingLine(content: string): string {
  const trimmed = content.trimStart()
  if (trimmed.length === 0) {
    return ""
  }

  if (/^[─-]{4,}$/.test(trimmed)) {
    return MESSAGE_SPACER
  }

  if (trimmed.startsWith("•") || trimmed.startsWith("└") || trimmed.startsWith(">")) {
    return trimmed
  }

  return `• ${trimmed}`
}

export function toConversationMarkdown(lines: string[]): string {
  if (lines.length === 0) {
    return DEFAULT_CONVERSATION
  }

  const rendered: string[] = []
  let pendingAssistant: string[] = []
  let pendingTimeline: string[] = []
  let toolSectionOpen = false

  const pushTimelineLine = (value: string) => {
    if (value.length === 0) {
      if (pendingTimeline[pendingTimeline.length - 1] !== "") {
        pendingTimeline.push("")
      }
      return
    }

    pendingTimeline.push(value)
  }

  const flushAssistant = () => {
    if (pendingAssistant.length === 0) return
    rendered.push(formatAssistantMessageRail(pendingAssistant.join("\n")))
    pendingAssistant = []
  }

  const flushTimeline = () => {
    if (pendingTimeline.length === 0) return
    rendered.push(pendingTimeline.join("\n"))
    pendingTimeline = []
    toolSectionOpen = false
  }

  const appendThinking = (content: string) => {
    const normalized = normalizeThinkingLine(content.trimEnd())
    if (normalized.length === 0) {
      pushTimelineLine("")
      toolSectionOpen = false
      return
    }

    if (toolSectionOpen) {
      pushTimelineLine("")
      toolSectionOpen = false
    }

    pushTimelineLine(normalized)
  }

  const appendTool = (content: string, isError: boolean) => {
    if (!toolSectionOpen) {
      if (pendingTimeline.length > 0) {
        pushTimelineLine("")
      }
      pushTimelineLine("• Explored")
      toolSectionOpen = true
    }

    const detail = content.trim().length > 0 ? content.trim() : "Tool call"
    pushTimelineLine(`  └ ${isError ? `⚠️ ${detail}` : detail}`)
  }

  const startIndex = Math.max(0, lines.length - MAX_RENDER_LINES)
  let recent = lines.slice(startIndex)
  const lastUserIndex = findLastUserLineIndex(lines)
  if (lastUserIndex !== -1 && lastUserIndex < startIndex) {
    recent = [lines[lastUserIndex] ?? "", ...recent]
  }

  for (const rawLine of recent) {
    const line = stripTimestamp(rawLine)

    if (line.length === 0) {
      if (pendingAssistant.length > 0) {
        pendingAssistant.push("")
      } else if (pendingTimeline.length > 0) {
        pushTimelineLine("")
      }
      continue
    }

    if (line.startsWith("[you/")) {
      flushAssistant()
      flushTimeline()
      const content = line.replace(/^\[you\/[\w_\-]+\]\s*/, "")
      rendered.push(`\`\`\`text\n${formatUserMessageBox(content)}\n\`\`\``)
      continue
    }

    const thinking = extractTaggedContent(line, "thinking")
    if (thinking !== null) {
      flushAssistant()
      appendThinking(thinking)
      continue
    }

    const toolError = extractTaggedContent(line, "tool:error")
    if (toolError !== null) {
      flushAssistant()
      appendTool(toolError, true)
      continue
    }

    const tool = extractTaggedContent(line, "tool")
    if (tool !== null) {
      flushAssistant()
      appendTool(tool, false)
      continue
    }

    if (line.startsWith("[agent]")) {
      flushAssistant()
      flushTimeline()
      continue
    }

    if (line.startsWith("[pi:stderr]")) {
      flushAssistant()
      flushTimeline()
      const content = line.replace(/^\[pi:stderr\]\s*/, "")
      rendered.push(`> ⚠️ ${content}`)
      continue
    }

    if (line.startsWith("ERROR:")) {
      flushAssistant()
      flushTimeline()
      rendered.push(`> ❌ ${line}`)
      continue
    }

    if (line.startsWith("[system]")) {
      flushAssistant()
      flushTimeline()
      const content = line.replace(/^\[system\]\s*/, "")
      rendered.push(`> ℹ️ ${content}`)
      continue
    }

    if (line.startsWith("[extension-ui]")) {
      flushAssistant()
      flushTimeline()
      rendered.push(`> ℹ️ Agent requested extension UI input.`)
      continue
    }

    if (line.startsWith("[assistant-break]")) {
      flushAssistant()
      flushTimeline()
      continue
    }

    if (pendingTimeline.length > 0) {
      flushTimeline()
    }

    pendingAssistant.push(line)
  }

  flushAssistant()
  flushTimeline()

  return rendered.join(`\n\n${MESSAGE_SPACER}\n\n`) || DEFAULT_CONVERSATION
}
