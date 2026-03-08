export type WorkspaceStatus = "active" | "archived"
export type AgentRuntimeStatus = "stopped" | "starting" | "running" | "error"
export type SendMode = "prompt" | "steer" | "follow_up"

export interface RepoRecord {
  id: number
  name: string
  rootPath: string
  createdAt: string
}

export interface WorkspaceRecord {
  id: number
  repoId: number
  name: string
  branch: string
  worktreePath: string
  status: WorkspaceStatus
  createdAt: string
  archivedAt: string | null
}

export interface AgentRecord {
  workspaceId: number
  status: AgentRuntimeStatus
  pid: number | null
  model: string | null
  sessionId: string | null
  startedAt: string | null
  stoppedAt: string | null
  lastEventAt: string | null
  lastError: string | null
}

export interface ScriptConfig {
  setup?: string
  run?: string
  archive?: string
  runMode?: "concurrent" | "nonconcurrent"
}

export interface AppConfig {
  dataDir: string
  reposDir: string
  workspacesDir: string
  dbPath: string
  piCommand: string
  defaultModel?: string
  maxLogLines: number
  scripts: ScriptConfig
}
