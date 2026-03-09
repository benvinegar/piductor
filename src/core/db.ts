import { mkdirSync } from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
import { nextAgentTimingState } from "../agent/state"
import type {
  AgentRecord,
  AgentRuntimeStatus,
  MergeChecklistItemRecord,
  RepoRecord,
  WorkspaceRecord,
} from "./types"

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
    lastEventAt: row.last_event_at ? String(row.last_event_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
  }
}

function mapMergeChecklistItem(row: any): MergeChecklistItemRecord {
  return {
    workspaceId: Number(row.workspace_id),
    itemKey: String(row.item_key),
    label: String(row.label),
    required: Number(row.required) === 1,
    completed: Number(row.completed) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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
        last_event_at TEXT,
        last_error TEXT,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS merge_checklist_items (
        workspace_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        label TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, item_key),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
    `)

    const agentColumns = this.db.query(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
    const hasLastEventAt = agentColumns.some((column) => String(column.name) === "last_event_at")
    if (!hasLastEventAt) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN last_event_at TEXT`)
    }
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
        SELECT workspace_id, status, pid, model, session_id, started_at, stopped_at, last_event_at, last_error
        FROM agents
        WHERE workspace_id = ?
      `)
      .get(workspaceId)
    return row ? mapAgent(row) : null
  }

  listAgents(): AgentRecord[] {
    const rows = this.db
      .query(`
        SELECT workspace_id, status, pid, model, session_id, started_at, stopped_at, last_event_at, last_error
        FROM agents
        ORDER BY workspace_id ASC
      `)
      .all()

    return rows.map(mapAgent)
  }

  setAgentState(params: {
    workspaceId: number
    status: AgentRuntimeStatus
    pid?: number | null
    model?: string | null
    sessionId?: string | null
    lastEventAt?: string | null
    lastError?: string | null
  }) {
    const now = nowIso()
    const current = this.getAgent(params.workspaceId)
    const timing = nextAgentTimingState({
      current: current
        ? {
            status: current.status,
            startedAt: current.startedAt,
            stoppedAt: current.stoppedAt,
            lastEventAt: current.lastEventAt,
          }
        : null,
      status: params.status,
      nowIso: now,
      lastEventAt: params.lastEventAt,
    })

    this.db
      .query(`
        INSERT INTO agents(workspace_id, status, pid, model, session_id, started_at, stopped_at, last_event_at, last_error)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          status = excluded.status,
          pid = excluded.pid,
          model = excluded.model,
          session_id = excluded.session_id,
          started_at = excluded.started_at,
          stopped_at = excluded.stopped_at,
          last_event_at = excluded.last_event_at,
          last_error = excluded.last_error
      `)
      .run(
        params.workspaceId,
        params.status,
        params.pid ?? null,
        params.model ?? null,
        params.sessionId ?? null,
        timing.startedAt,
        timing.stoppedAt,
        timing.lastEventAt,
        params.lastError ?? null,
      )
  }

  listMergeChecklistItems(workspaceId: number): MergeChecklistItemRecord[] {
    const rows = this.db
      .query(`
        SELECT workspace_id, item_key, label, required, completed, created_at, updated_at
        FROM merge_checklist_items
        WHERE workspace_id = ?
        ORDER BY created_at ASC, item_key ASC
      `)
      .all(workspaceId)

    return rows.map(mapMergeChecklistItem)
  }

  upsertMergeChecklistItem(params: {
    workspaceId: number
    itemKey: string
    label: string
    required?: boolean
    completed?: boolean
  }): MergeChecklistItemRecord {
    const now = nowIso()
    this.db
      .query(`
        INSERT INTO merge_checklist_items(workspace_id, item_key, label, required, completed, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, item_key) DO UPDATE SET
          label = excluded.label,
          required = excluded.required,
          completed = excluded.completed,
          updated_at = excluded.updated_at
      `)
      .run(
        params.workspaceId,
        params.itemKey,
        params.label,
        params.required === false ? 0 : 1,
        params.completed ? 1 : 0,
        now,
        now,
      )

    const item = this.listMergeChecklistItems(params.workspaceId).find((entry) => entry.itemKey === params.itemKey)
    if (!item) {
      throw new Error(`Failed to upsert merge checklist item ${params.itemKey}`)
    }

    return item
  }

  setMergeChecklistItemCompleted(workspaceId: number, itemKey: string, completed: boolean) {
    this.db
      .query(`
        UPDATE merge_checklist_items
        SET completed = ?, updated_at = ?
        WHERE workspace_id = ? AND item_key = ?
      `)
      .run(completed ? 1 : 0, nowIso(), workspaceId, itemKey)
  }

  deleteMergeChecklistItem(workspaceId: number, itemKey: string) {
    this.db
      .query(`
        DELETE FROM merge_checklist_items
        WHERE workspace_id = ? AND item_key = ?
      `)
      .run(workspaceId, itemKey)
  }

  clearMergeChecklistItems(workspaceId: number) {
    this.db
      .query(`
        DELETE FROM merge_checklist_items
        WHERE workspace_id = ?
      `)
      .run(workspaceId)
  }
}
