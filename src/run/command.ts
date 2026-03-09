import type { ScriptConfig } from "../core/types"

export type RunMode = NonNullable<ScriptConfig["runMode"]>

export type ParsedRunCommand =
  | { action: "run"; command: string | null }
  | { action: "stop" }
  | { action: "setup" }
  | { action: "archive" }
  | { action: "mode-get" }
  | { action: "mode-set"; mode: RunMode }

export function normalizeRunMode(value: ScriptConfig["runMode"]): RunMode {
  return value === "nonconcurrent" ? "nonconcurrent" : "concurrent"
}

export function parseRunCommandArgs(args: string[]): ParsedRunCommand | null {
  if (args.length === 0) {
    return { action: "run", command: null }
  }

  const [first, ...rest] = args
  const firstLower = first.toLowerCase()

  if (firstLower === "stop") {
    return { action: "stop" }
  }

  if (firstLower === "setup") {
    return { action: "setup" }
  }

  if (firstLower === "archive") {
    return { action: "archive" }
  }

  if (firstLower === "mode") {
    if (rest.length === 0) {
      return { action: "mode-get" }
    }

    if (rest.length === 1) {
      const modeInput = rest[0].toLowerCase()
      const mode = normalizeRunMode(modeInput as ScriptConfig["runMode"])
      if (modeInput === "concurrent" || modeInput === "nonconcurrent") {
        return { action: "mode-set", mode }
      }
    }

    return null
  }

  return { action: "run", command: args.join(" ") }
}

export function runCommandUsage(): string {
  return "Usage: /run [command] | /run stop | /run setup | /run archive | /run mode [concurrent|nonconcurrent]"
}
