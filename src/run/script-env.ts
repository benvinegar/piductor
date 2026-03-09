import type { RepoRecord, WorkspaceRecord } from "../core/types"

const BASE_PORT = 43000
const PORT_BLOCK_SIZE = 10

export function workspaceBasePort(workspaceId: number): number {
  return BASE_PORT + Math.max(0, workspaceId) * PORT_BLOCK_SIZE
}

export function buildWorkspaceScriptEnv(params: {
  baseEnv: NodeJS.ProcessEnv
  repo: RepoRecord
  workspace: WorkspaceRecord
  defaultBranch: string
}): NodeJS.ProcessEnv {
  const port = String(workspaceBasePort(params.workspace.id))

  return {
    ...params.baseEnv,
    PIDUCTOR_WORKSPACE_NAME: params.workspace.name,
    PIDUCTOR_WORKSPACE_PATH: params.workspace.worktreePath,
    PIDUCTOR_ROOT_PATH: params.repo.rootPath,
    PIDUCTOR_DEFAULT_BRANCH: params.defaultBranch,
    PIDUCTOR_PORT: port,

    CONDUCTOR_WORKSPACE_NAME: params.workspace.name,
    CONDUCTOR_WORKSPACE_PATH: params.workspace.worktreePath,
    CONDUCTOR_ROOT_PATH: params.repo.rootPath,
    CONDUCTOR_DEFAULT_BRANCH: params.defaultBranch,
    CONDUCTOR_PORT: port,
  }
}
