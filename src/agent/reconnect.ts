import type { AgentRecord, WorkspaceStatus } from "../core/types"

export type AgentReconnectAction =
  | { type: "skip" }
  | { type: "mark_stopped"; reason: string }
  | { type: "mark_orphaned"; reason: string }
  | { type: "restart"; reason: string }

export function planAgentReconnect(input: {
  workspaceStatus: WorkspaceStatus | null
  agent: AgentRecord
  pidAlive: boolean
}): AgentReconnectAction {
  const { workspaceStatus, agent, pidAlive } = input

  if (!workspaceStatus || workspaceStatus === "archived") {
    return {
      type: "mark_stopped",
      reason: "workspace inactive during reconnect",
    }
  }

  if (agent.status === "running" || agent.status === "starting") {
    if (pidAlive) {
      return {
        type: "mark_orphaned",
        reason: "agent process still running but cannot be reattached; use /agent kill then /agent start",
      }
    }

    return {
      type: "restart",
      reason: "agent was active before restart; restoring session",
    }
  }

  if (agent.status === "error" && pidAlive) {
    return {
      type: "mark_orphaned",
      reason: "agent error state has live pid; use /agent kill",
    }
  }

  return { type: "skip" }
}
