import type { AgentRuntimeStatus } from "./types"

export const TREE_REPO_PREFIX = "repo:"
export const TREE_WORKSPACE_PREFIX = "workspace:"

export type WorkspaceTreeSelection =
  | { type: "repo"; repoId: number }
  | { type: "workspace"; repoId: number; workspaceId: number }

export function repoTreeValue(repoId: number): string {
  return `${TREE_REPO_PREFIX}${repoId}`
}

export function workspaceTreeValue(repoId: number, workspaceId: number): string {
  return `${TREE_WORKSPACE_PREFIX}${repoId}:${workspaceId}`
}

export function parseWorkspaceTreeValue(raw: unknown): WorkspaceTreeSelection | null {
  const value = String(raw ?? "")

  if (value.startsWith(TREE_WORKSPACE_PREFIX)) {
    const parts = value.slice(TREE_WORKSPACE_PREFIX.length).split(":")
    const repoId = Number(parts[0])
    const workspaceId = Number(parts[1])

    if (Number.isInteger(repoId) && Number.isInteger(workspaceId)) {
      return { type: "workspace", repoId, workspaceId }
    }

    return null
  }

  if (value.startsWith(TREE_REPO_PREFIX)) {
    const repoId = Number(value.slice(TREE_REPO_PREFIX.length))
    if (Number.isInteger(repoId)) {
      return { type: "repo", repoId }
    }
    return null
  }

  return null
}

export function formatWorkspaceTreeRowName(params: {
  isRepo: boolean
  expanded?: boolean
  repoId: number
  repoName?: string
  workspaceName?: string
  branch?: string
  added?: number
  removed?: number
}): string {
  if (params.isRepo) {
    return `${params.expanded ? "▾" : "▸"} ${params.repoId} - ${params.repoName ?? "repo"}`
  }

  return `  ${params.branch ?? params.workspaceName ?? "branch"}`
}

export type WorkspaceTreeRowMeta = {
  added: number
  removed: number
  status: AgentRuntimeStatus
  activityAt: string | null
}

export function encodeWorkspaceTreeRowMeta(meta: WorkspaceTreeRowMeta): string {
  return JSON.stringify(meta)
}

export function parseWorkspaceTreeRowMeta(raw: unknown): WorkspaceTreeRowMeta {
  const defaults: WorkspaceTreeRowMeta = {
    added: 0,
    removed: 0,
    status: "stopped",
    activityAt: null,
  }

  if (!raw) {
    return defaults
  }

  try {
    const parsed = JSON.parse(String(raw)) as Partial<WorkspaceTreeRowMeta>
    const status = parsed.status
    const normalizedStatus: AgentRuntimeStatus =
      status === "starting" || status === "running" || status === "error" || status === "stopped"
        ? status
        : "stopped"

    return {
      added: Number.isFinite(parsed.added) ? Number(parsed.added) : 0,
      removed: Number.isFinite(parsed.removed) ? Number(parsed.removed) : 0,
      status: normalizedStatus,
      activityAt: parsed.activityAt ? String(parsed.activityAt) : null,
    }
  } catch {
    return defaults
  }
}

export function formatWorkspaceStatusLabel(status: AgentRuntimeStatus): string {
  switch (status) {
    case "starting":
      return "starting"
    case "running":
      return "running"
    case "error":
      return "error"
    default:
      return "stopped"
  }
}

export function formatWorkspaceActivityAge(activityAt: string | null, nowMs = Date.now()): string {
  if (!activityAt) {
    return "-"
  }

  const parsedMs = Date.parse(activityAt)
  if (!Number.isFinite(parsedMs)) {
    return "-"
  }

  const deltaSeconds = Math.max(0, Math.floor((nowMs - parsedMs) / 1000))
  if (deltaSeconds < 5) {
    return "now"
  }
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s`
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60)
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`
  }

  const deltaHours = Math.floor(deltaMinutes / 60)
  if (deltaHours < 24) {
    return `${deltaHours}h`
  }

  const deltaDays = Math.floor(deltaHours / 24)
  return `${deltaDays}d`
}
