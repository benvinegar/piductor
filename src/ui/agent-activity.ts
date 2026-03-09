const DEFAULT_MAX_INLINE = 88

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function readStringField(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) {
    return null
  }

  const value = record[key]
  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function compactInline(value: string, maxChars = DEFAULT_MAX_INLINE): string {
  const compact = value.replace(/\s+/g, " ").trim()
  if (compact.length <= maxChars) {
    return compact
  }

  if (maxChars <= 1) {
    return "…"
  }

  return `${compact.slice(0, maxChars - 1).trimEnd()}…`
}

function code(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``
}

function humanizeToolName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function compactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").trim()
  if (normalized.length === 0) {
    return ""
  }

  const parts = normalized.split("/").filter((part) => part.length > 0)
  if (parts.length <= 3) {
    return normalized
  }

  return `…/${parts.slice(-3).join("/")}`
}

function summarizeBashCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase()
  if (normalized.length === 0) {
    return "Run shell command"
  }

  if (/\b(rg|grep|find|fd)\b/.test(normalized)) {
    return "Search project files"
  }

  if (/\b(npm|pnpm|yarn|bun)\s+test\b|\bvitest\b|\bjest\b/.test(normalized)) {
    return "Run tests"
  }

  if (/\b(tsc|typecheck)\b/.test(normalized)) {
    return "Run typecheck"
  }

  if (/\bgit\s+(status|diff|log|show|branch|rev-parse|ls-files)\b/.test(normalized)) {
    return "Inspect git state"
  }

  if (/\b(ls|pwd|tree)\b/.test(normalized)) {
    return "Inspect workspace files"
  }

  if (/\bsqlite3\b/.test(normalized)) {
    return "Query workspace database"
  }

  if (/\b(npm|pnpm|yarn|bun)\s+run\s+dev\b|\bnext\s+dev\b|\bvite\b/.test(normalized)) {
    return "Start development server"
  }

  if (/\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\bnext\s+build\b/.test(normalized)) {
    return "Run project build"
  }

  return "Run shell command"
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value
  }

  if (Array.isArray(value)) {
    const text = value
      .map((entry) => {
        const block = asRecord(entry)
        if (!block) {
          return ""
        }

        const directText = readStringField(block, "text")
        return directText ?? ""
      })
      .filter((entry) => entry.length > 0)
      .join("\n")

    return text
  }

  return ""
}

export function summarizeToolCall(toolNameRaw: unknown, args: unknown): string {
  const toolName = typeof toolNameRaw === "string" && toolNameRaw.trim().length > 0 ? toolNameRaw.trim() : "tool"
  const argRecord = asRecord(args)
  const directArg = typeof args === "string" ? args : null

  switch (toolName) {
    case "read": {
      const target = directArg ?? readStringField(argRecord, "path")
      return target ? `Read ${code(compactInline(compactPath(target), 96))}` : "Read file"
    }

    case "edit": {
      const target = directArg ?? readStringField(argRecord, "path")
      return target ? `Edit ${code(compactInline(compactPath(target), 96))}` : "Edit file"
    }

    case "write": {
      const target = directArg ?? readStringField(argRecord, "path")
      return target ? `Write ${code(compactInline(compactPath(target), 96))}` : "Write file"
    }

    case "bash": {
      const command = directArg ?? readStringField(argRecord, "command")
      return command ? summarizeBashCommand(command) : "Run shell command"
    }

    case "todo": {
      const action = readStringField(argRecord, "action")
      const id = readStringField(argRecord, "id")
      const suffix = [action, id].filter((entry): entry is string => Boolean(entry)).join(" ")
      return suffix.length > 0 ? `Todo ${suffix}` : "Todo update"
    }

    default: {
      const label = humanizeToolName(toolName)
      return label
    }
  }
}

export function summarizeToolError(toolNameRaw: unknown, result: unknown): string {
  const toolName = typeof toolNameRaw === "string" && toolNameRaw.trim().length > 0 ? toolNameRaw.trim() : "tool"
  const label = humanizeToolName(toolName)

  if (typeof result === "string") {
    const detail = compactInline(result)
    return detail.length > 0 ? `${label} failed: ${code(detail)}` : `${label} failed`
  }

  const resultRecord = asRecord(result)
  const detail =
    readStringField(resultRecord, "error") ??
    readStringField(resultRecord, "message") ??
    readStringField(resultRecord, "stderr") ??
    extractTextFromUnknown(resultRecord?.content)

  if (!detail) {
    return `${label} failed`
  }

  return `${label} failed: ${code(compactInline(detail))}`
}
