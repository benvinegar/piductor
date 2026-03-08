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
