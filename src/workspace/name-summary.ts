import { PiRpcProcess } from "../network/pi-rpc"

const DEFAULT_SUMMARY_TIMEOUT_MS = 45_000

export function buildWorkspaceNameSummaryPrompt(taskText: string): string {
  const task = taskText.trim()

  return [
    "You write short workspace labels for coding tasks.",
    "Return one concise label for the task below.",
    "Rules:",
    "- 3 to 7 words.",
    "- plain text only.",
    "- no markdown, bullets, quotes, or emoji.",
    "- no trailing punctuation.",
    "- max 48 characters.",
    "",
    `Task: ${task}`,
    "",
    "Label:",
  ].join("\n")
}

export function normalizeWorkspaceNameSummary(raw: string, maxChars = 48): string | null {
  if (!raw || maxChars <= 0) {
    return null
  }

  const line = raw
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0)

  if (!line) {
    return null
  }

  let summary = line
    .replace(/^[*-]\s+/, "")
    .replace(/^label\s*:\s*/i, "")
    .replace(/^workspace\s*(name|label|summary)\s*[:\-]\s*/i, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[_]+/g, " ")
    .replace(/[^a-zA-Z0-9\s/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

  if (!summary) {
    return null
  }

  if (summary.length > maxChars) {
    const clipped = summary.slice(0, maxChars).trimEnd()
    const lastSpace = clipped.lastIndexOf(" ")
    summary = lastSpace >= Math.floor(maxChars * 0.5) ? clipped.slice(0, lastSpace).trimEnd() : clipped
  }

  if (summary.length < 3) {
    return null
  }

  return summary
}

export function formatWorkspaceNameWithSummary(workspaceName: string, summary: string | null | undefined): string {
  const base = workspaceName.trim() || "workspace"
  const normalized = normalizeWorkspaceNameSummary(summary ?? "")

  if (!normalized) {
    return base
  }

  const normalizedBase = base.toLowerCase()
  if (normalizedBase.endsWith(`· ${normalized}`)) {
    return base
  }

  return `${base} · ${normalized}`
}

export function extractAssistantTextFromMessages(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index]
    if (!entry || typeof entry !== "object") {
      continue
    }

    const message = entry as Record<string, unknown>
    if (message.role !== "assistant") {
      continue
    }

    const content = message.content
    if (typeof content === "string" && content.trim().length > 0) {
      return content
    }

    if (!Array.isArray(content)) {
      continue
    }

    const text = content
      .filter((block) => block && typeof block === "object")
      .map((block) => {
        const value = block as Record<string, unknown>
        return typeof value.text === "string" ? value.text : ""
      })
      .join("\n")
      .trim()

    if (text.length > 0) {
      return text
    }
  }

  return null
}

function waitForTurnEnd(process: PiRpcProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      unsubscribe()
    }

    const finish = () => {
      cleanup()
      resolve()
    }

    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }

    const unsubscribe = process.onEvent((event) => {
      const type = String(event?.type ?? "")

      if (type === "extension_ui_request" && typeof event.id === "string") {
        process.respondExtensionUiCancel(event.id)
        return
      }

      if (type === "turn_end" || type === "agent_end") {
        finish()
        return
      }

      if (type === "process_error") {
        fail(new Error(String(event.error ?? "Pi process error")))
        return
      }

      if (type === "process_exit") {
        const code = Number(event.code ?? 0)
        if (code === 0) {
          finish()
        } else {
          fail(new Error(`Pi process exited with code ${code}`))
        }
      }
    })

    const timer = setTimeout(() => {
      fail(new Error("Workspace name summary timed out"))
    }, Math.max(1_000, timeoutMs))
  })
}

export async function generateWorkspaceNameSummary(params: {
  piCommand: string
  cwd: string
  model?: string
  taskText: string
  timeoutMs?: number
}): Promise<string | null> {
  const taskText = params.taskText.trim()
  if (!taskText) {
    return null
  }

  const process = new PiRpcProcess({
    piCommand: params.piCommand,
    cwd: params.cwd,
    model: params.model,
  })

  await process.start()

  try {
    const waitForTurn = waitForTurnEnd(process, params.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS)

    try {
      await process.prompt(buildWorkspaceNameSummaryPrompt(taskText))
    } catch (error) {
      void waitForTurn.catch(() => undefined)
      throw error
    }

    await waitForTurn

    let assistantText: string | null = null
    try {
      assistantText = await process.getLastAssistantText()
    } catch {
      // Fallback below for older pi versions.
    }

    if (!assistantText) {
      const messages = await process.getMessages()
      assistantText = extractAssistantTextFromMessages(messages)
    }

    return assistantText ? normalizeWorkspaceNameSummary(assistantText) : null
  } finally {
    try {
      await process.stop()
    } catch {
      // Ignore shutdown errors.
    }
  }
}
