export type AgentCommand =
  | { action: "start"; model?: string }
  | { action: "stop" }
  | { action: "restart"; model?: string }
  | { action: "kill" }
  | { action: "list" }

export function parseAgentCommand(args: string[]): AgentCommand | null {
  const sub = (args[0] || "").toLowerCase()

  if (sub === "start") {
    return { action: "start", model: args[1] || undefined }
  }

  if (sub === "stop") {
    return { action: "stop" }
  }

  if (sub === "restart") {
    return { action: "restart", model: args[1] || undefined }
  }

  if (sub === "kill") {
    return { action: "kill" }
  }

  if (sub === "list") {
    return { action: "list" }
  }

  return null
}

export function resolveRestartModel(
  explicitModel: string | undefined,
  currentModel: string | null | undefined,
  defaultModel: string | undefined,
): string | undefined {
  return explicitModel ?? currentModel ?? defaultModel
}
