export const DEFAULT_CONVERSATION = "_No conversation yet. Start an agent and send a prompt._"
const MESSAGE_SPACER = "..."

function stripTimestamp(line: string): string {
  return line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "")
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
  const lines = content.split(/\r?\n/)
  const quoted: string[] = []
  let inCodeFence = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith("```")) {
      quoted.push(`> ${line}`)
      inCodeFence = !inCodeFence
      continue
    }

    if (inCodeFence) {
      quoted.push(`> ${line}`)
      continue
    }

    if (line.length === 0) {
      quoted.push(`>`)
      continue
    }

    quoted.push(`> ${line}  `)
  }

  return quoted.join("\n")
}

export function toConversationMarkdown(lines: string[]): string {
  if (lines.length === 0) {
    return DEFAULT_CONVERSATION
  }

  const rendered: string[] = []
  let pendingAssistant: string[] = []

  const flushAssistant = () => {
    if (pendingAssistant.length === 0) return
    rendered.push(formatAssistantMessageRail(pendingAssistant.join("\n")))
    pendingAssistant = []
  }

  const recent = lines.slice(-300)
  for (const rawLine of recent) {
    const line = stripTimestamp(rawLine)

    if (line.length === 0) {
      if (pendingAssistant.length > 0) {
        pendingAssistant.push("")
      }
      continue
    }

    if (line.startsWith("[you/")) {
      flushAssistant()
      const content = line.replace(/^\[you\/[\w_\-]+\]\s*/, "")
      rendered.push(`\`\`\`text\n${formatUserMessageBox(content)}\n\`\`\``)
      continue
    }

    if (line.startsWith("[thinking]")) {
      continue
    }

    if (line.startsWith("[tool]")) {
      continue
    }

    if (line.startsWith("[agent]")) {
      flushAssistant()
      continue
    }

    if (line.startsWith("[pi:stderr]")) {
      flushAssistant()
      const content = line.replace(/^\[pi:stderr\]\s*/, "")
      rendered.push(`> ⚠️ ${content}`)
      continue
    }

    if (line.startsWith("ERROR:")) {
      flushAssistant()
      rendered.push(`> ❌ ${line}`)
      continue
    }

    if (line.startsWith("[system]")) {
      flushAssistant()
      const content = line.replace(/^\[system\]\s*/, "")
      rendered.push(`> ℹ️ ${content}`)
      continue
    }

    if (line.startsWith("[extension-ui]")) {
      flushAssistant()
      rendered.push(`> ℹ️ Agent requested extension UI input.`)
      continue
    }

    if (line.startsWith("[assistant-break]")) {
      flushAssistant()
      continue
    }

    pendingAssistant.push(line)
  }

  flushAssistant()

  return rendered.join(`\n\n${MESSAGE_SPACER}\n\n`) || DEFAULT_CONVERSATION
}
