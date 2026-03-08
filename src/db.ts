import { mkdirSync } from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
import type { AgentRecord, AgentRuntimeStatus, RepoRecord, WorkspaceRecord } from "./types"

function nowIso() {
  return new Date().toISOString()
}

function mapRepo(row: any): RepoRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    rootPath: String(row.root_path),
    createdAt: String(row.created_at),
  }
}

function mapWorkspace(row: any): WorkspaceRecord {
  return {
    id: Number(row.id),
    repoId: Number(row.repo_id),
    name: String(row.name),
    branch: String(row.branch),
    worktreePath: String(row.worktree_path),
    status: row.status,
    createdAt: String(row.created_at),
    archivedAt: row.archived_at ? String(row.archived_at) : null,
  }
}

function mapAgent(row: any): AgentRecord {
  return {
    workspaceId: Number(row.workspace_id),
    status: row.status,
    pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
    model: row.model ? String(row.model) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    stoppedAt: row.stopped_at ? String(row.stopped_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
  }
}

export class Store {
  private db: Database

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        archived_at TEXT,
        UNIQUE(repo_id, name),
        FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agents (
        workspace_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        pid INTEGER,
        model TEXT,
        session_id TEXT,
        started_at TEXT,
        stopped_at TEXT,
        last_error TEXT,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
    `)
  }

  close() {
    this.db.close()
  }

  listRepos(): RepoRecord[] {
    const rows = this.db
      .query(`
        SELECT id, name, root_path, created_at
        FROM repos
        ORDER BY created_at DESC
      `)
      .all()
    return rows.map(mapRepo)
  }

  getRepoById(id: number): RepoRecord | null {
    const row = this.db
      .query(`
        SELECT id, name, root_path, created_at
        FROM repos
        WHERE id = ?
      `)
      .get(id)
    return row ? mapRepo(row) : null
  }

  getRepoByRootPath(rootPath: string): RepoRecord | null {
    const row = this.db
      .query(`
        SELECT id, name, root_path, created_at
        FROM repos
        WHERE root_path = ?
      `)
      .get(rootPath)
    return row ? mapRepo(row) : null
  }

  upsertRepo(name: string, rootPath: string): RepoRecord {
    const createdAt = nowIso()
    this.db
      .query(`
        INSERT INTO repos(name, root_path, created_at)
        VALUES(?, ?, ?)
        ON CONFLICT(root_path) DO UPDATE SET
          name = excluded.name
      `)
      .run(name, rootPath, createdAt)

    const repo = this.getRepoByRootPath(rootPath)
    if (!repo) {
      throw new Error(`Failed to upsert repo at ${rootPath}`)
    }
    return repo
  }

  listWorkspaces(repoId: number, includeArchived = false): WorkspaceRecord[] {
    const rows = includeArchived
      ? this.db
          .query(`
          SELECT id, repo_id, name, branch, worktree_path, status, created_at, archived_at
          FROM workspaces
          WHERE repo_id = ?
          ORDER BY created_at DESC
        `)
          .all(repoId)
      : this.db
          .query(`
          SELECT id, repo_id, name, branch, worktree_path, status, created_at, archived_at
          FROM workspaces
          WHERE repo_id = ? AND status = 'active'
          ORDER BY created_at DESC
        `)
          .all(repoId)

    return rows.map(mapWorkspace)
  }

  getWorkspaceById(id: number): WorkspaceRecord | null {
    const row = this.db
      .query(`
        SELECT id, repo_id, name, branch, worktree_path, status, created_at, archived_at
        FROM workspaces
        WHERE id = ?
      `)
      .get(id)
    return row ? mapWorkspace(row) : null
  }

  getWorkspaceByPath(worktreePath: string): WorkspaceRecord | null {
    const row = this.db
      .query(`
        SELECT id, repo_id, name, branch, worktree_path, status, created_at, archived_at
        FROM workspaces
        WHERE worktree_path = ?
      `)
      .get(worktreePath)
    return row ? mapWorkspace(row) : null
  }

  createWorkspace(repoId: number, name: string, branch: string, worktreePath: string): WorkspaceRecord {
    const createdAt = nowIso()
    this.db
      .query(`
        INSERT INTO workspaces(repo_id, name, branch, worktree_path, status, created_at)
        VALUES(?, ?, ?, ?, 'active', ?)
        ON CONFLICT(repo_id, name) DO UPDATE SET
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          status = 'active',
          archived_at = NULL
      `)
      .run(repoId, name, branch, worktreePath, createdAt)

    const workspace = this.getWorkspaceByPath(worktreePath)
    if (!workspace) {
      throw new Error(`Failed to persist workspace ${name}`)
    }
    return workspace
  }

  setWorkspaceArchived(workspaceId: number, archived: boolean) {
    if (archived) {
      this.db
        .query(`
          UPDATE workspaces
          SET status = 'archived', archived_at = ?
          WHERE id = ?
        `)
        .run(nowIso(), workspaceId)
    } else {
      this.db
        .query(`
          UPDATE workspaces
          SET status = 'active', archived_at = NULL
          WHERE id = ?
        `)
        .run(workspaceId)
    }
  }

  getAgent(workspaceId: number): AgentRecord | null {
    const row = this.db
      .query(`
        SELECT workspace_id, status, pid, model, session_id, started_at, stopped_at, last_error
        FROM agents
        WHERE workspace_id = ?
      `)
      .get(workspaceId)
    return row ? mapAgent(row) : null
  }

  setAgentState(params: {
    workspaceId: number
    status: AgentRuntimeStatus
    pid?: number | null
    model?: string | null
    sessionId?: string | null
    lastError?: string | null
  }) {
    const current = this.getAgent(params.workspaceId)
    const startedAt = params.status === "running" || params.status === "starting" ? nowIso() : current?.startedAt ?? null
    const stoppedAt = params.status === "stopped" || params.status === "error" ? nowIso() : null

    this.db
      .query(`
        INSERT INTO agents(workspace_id, status, pid, model, session_id, started_at, stopped_at, last_error)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          status = excluded.status,
          pid = excluded.pid,
          model = excluded.model,
          session_id = excluded.session_id,
          started_at = excluded.started_at,
          stopped_at = excluded.stopped_at,
          last_error = excluded.last_error
      `)
      .run(
        params.workspaceId,
        params.status,
        params.pid ?? null,
        params.model ?? null,
        params.sessionId ?? null,
        startedAt,
        stoppedAt,
        params.lastError ?? null,
      )
  }
}
