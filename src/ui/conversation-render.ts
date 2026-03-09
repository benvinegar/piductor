export const DEFAULT_CONVERSATION = "_No conversation yet. Start an agent and send a prompt._"
const MAX_RENDER_LINES = 300

export type ConversationBlock =
  | {
      kind: "user"
      text: string
    }
  | {
      kind: "assistant"
      markdown: string
    }
  | {
      kind: "activity"
      text: string
    }
  | {
      kind: "notice"
      markdown: string
    }

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
  return content.trimEnd()
}

function expandInlineBullets(line: string): string[] {
  const leading = line.match(/^\s*/)?.[0] ?? ""
  const trimmed = line.trim()

  if (!trimmed.includes(" - ")) {
    return [line]
  }

  const withIntro = trimmed.match(/^(.*?:)\s+-\s+(.+)$/)
  if (withIntro) {
    const intro = withIntro[1]?.trimEnd() ?? ""
    const rest = withIntro[2] ?? ""
    const items = rest
      .split(/\s+-\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)

    if (items.length >= 1) {
      return [`${leading}${intro}`, ...items.map((item) => `${leading}- ${item}`)]
    }
  }

  if (/^-\s+.+\s+-\s+.+/.test(trimmed)) {
    const parts = trimmed
      .replace(/^-\s+/, "")
      .split(/\s+-\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)

    if (parts.length >= 2) {
      return parts.map((item) => `${leading}- ${item}`)
    }
  }

  return [line]
}

function normalizeAssistantMessage(content: string): string {
  const sourceLines = content.split(/\r?\n/).map((line) => line.trimEnd())
  const expanded: string[] = []
  let inCodeFence = false

  for (const line of sourceLines) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence
      expanded.push(line)
      continue
    }

    if (inCodeFence) {
      expanded.push(line)
      continue
    }

    expanded.push(...expandInlineBullets(line))
  }

  const normalized: string[] = []
  inCodeFence = false

  for (const line of expanded) {
    const trimmed = line.trimStart()
    const isFence = trimmed.startsWith("```")

    if (isFence) {
      inCodeFence = !inCodeFence
      normalized.push(line)
      continue
    }

    if (line.length === 0) {
      if (normalized[normalized.length - 1] !== "") {
        normalized.push("")
      }
      continue
    }

    const isBullet = /^[-*•]\s+/.test(trimmed)
    const previous = normalized[normalized.length - 1] ?? ""
    const previousIsBullet = /^[-*•]\s+/.test(previous.trimStart())

    if (!inCodeFence && isBullet && previous.length > 0 && !previousIsBullet) {
      normalized.push("")
    }

    normalized.push(line)
  }

  while (normalized[0] === "") {
    normalized.shift()
  }

  while (normalized[normalized.length - 1] === "") {
    normalized.pop()
  }

  return normalized.join("\n")
}

export function formatAssistantMessageRail(content: string): string {
  return normalizeAssistantMessage(content)
}

function extractTaggedContent(line: string, tag: string): string | null {
  const token = `[${tag}]`
  if (!line.startsWith(token)) {
    return null
  }

  const content = line.slice(token.length)
  return content.startsWith(" ") ? content.slice(1) : content
}

export function toConversationBlocks(lines: string[]): ConversationBlock[] {
  if (lines.length === 0) {
    return []
  }

  const rendered: ConversationBlock[] = []
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
    rendered.push({
      kind: "assistant",
      markdown: formatAssistantMessageRail(pendingAssistant.join("\n")),
    })
    pendingAssistant = []
  }

  const flushTimeline = () => {
    if (pendingTimeline.length === 0) return
    rendered.push({
      kind: "activity",
      text: pendingTimeline.join("\n"),
    })
    pendingTimeline = []
    toolSectionOpen = false
  }

  const appendTool = (content: string, isError: boolean) => {
    if (!toolSectionOpen) {
      if (pendingTimeline.length > 0 && pendingTimeline[pendingTimeline.length - 1] !== "") {
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
      rendered.push({
        kind: "user",
        text: formatUserMessageBox(content),
      })
      continue
    }

    const thinking = extractTaggedContent(line, "thinking")
    if (thinking !== null) {
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
      rendered.push({ kind: "notice", markdown: `> ⚠️ ${content}` })
      continue
    }

    if (line.startsWith("ERROR:")) {
      flushAssistant()
      flushTimeline()
      rendered.push({ kind: "notice", markdown: `> ❌ ${line}` })
      continue
    }

    if (line.startsWith("[system]")) {
      flushAssistant()
      flushTimeline()
      const content = line.replace(/^\[system\]\s*/, "")
      rendered.push({ kind: "notice", markdown: `> ℹ️ ${content}` })
      continue
    }

    if (line.startsWith("[extension-ui]")) {
      flushAssistant()
      flushTimeline()
      rendered.push({ kind: "notice", markdown: "> ℹ️ Agent requested extension UI input." })
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

  return rendered
}

export function toConversationMarkdown(lines: string[]): string {
  const blocks = toConversationBlocks(lines)
  if (blocks.length === 0) {
    return DEFAULT_CONVERSATION
  }

  return (
    blocks
      .map((block) => {
        if (block.kind === "user") {
          return `**You:** ${block.text}`
        }

        if (block.kind === "activity") {
          return block.text
        }

        return block.markdown
      })
      .filter((value) => value.trim().length > 0)
      .join("\n\n") || DEFAULT_CONVERSATION
  )
}
