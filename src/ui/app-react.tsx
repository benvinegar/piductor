import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  createCliRenderer,
  parseColor,
  SyntaxStyle,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
  type TextareaRenderable,
} from "@opentui/core"
import { createRoot, useKeyboard, useTerminalDimensions, type Root } from "@opentui/react"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Store } from "../core/db"
import { PiRpcProcess } from "../network/pi-rpc"
import type { AppConfig, RepoRecord, SendMode, WorkspaceRecord } from "../core/types"
import {
  addWorktreeForBranch,
  cloneRepo,
  createWorktree,
  ensureRepoFromLocalPath,
  getChangedFiles,
  getChangedFileStats,
  getDefaultBranchName,
  getDiffForFile,
  listBranchRefs,
  removeWorktree,
  resolveWorkspaceBaseRef,
} from "../vcs/git"
import {
  encodeWorkspaceTreeRowMeta,
  formatWorkspaceActivityAge,
  formatWorkspaceRuntimeLabel,
  formatWorkspaceTreeRowName,
  parseWorkspaceTreeRowMeta,
  parseWorkspaceTreeValue,
  repoTreeValue,
  TREE_REPO_PREFIX,
  workspaceTreeValue,
} from "../workspace/tree"
import { parseWorkspaceNewArgs, suggestWorkspaceNameFromBranch, workspaceNewUsage } from "../workspace/new"
import { extractFirstUrl, parsePrCreateArgs, prCreateUsage } from "../vcs/pr-command"
import { buildWorkspaceScriptEnv } from "../run/script-env"
import { shouldStopExistingRun, stopSignalSequence } from "../run/policy"
import { normalizeRunMode, parseRunCommandArgs, runCommandUsage, type RunMode } from "../run/command"
import { formatRunExitSummary, formatRunLogLine } from "../run/log"
import { parseFileDiff, type DiffViewMode } from "../review/diff-review"
import { formatTestRunStatus, nextTestRunFinished, nextTestRunStarted, type TestRunState } from "../run/test-status"
import { evaluateWorkspaceReadiness, formatWorkspaceReadinessLabel } from "../workspace/readiness"
import {
  createChecklistItemKey,
  evaluateMergeChecklist,
  findChecklistItemByNeedle,
  mergeChecklistSummaryLabel,
  toMergeChecklistMarkdown,
} from "../workspace/merge-checklist"
import { diffFingerprintFromStats } from "../review/diff-fingerprint"
import { LOADING_TOKEN, renderLoadingTokens } from "./loading"
import { buildHelpMarkdown, findCommandSuggestions } from "./commands"
import { compactThinkingPreview } from "./thinking-preview"
import { sanitizePiStderrLine, shouldSurfacePiStderr } from "../network/pi-stderr"
import { parseAgentCommand, resolveRestartModel } from "../agent/control"
import { killProcessByPid } from "../agent/process-kill"
import { UiFlushScheduler } from "./flush-scheduler"
import { consumeBufferedLines } from "../run/stream-buffer"
import { DEFAULT_CONVERSATION, toConversationMarkdown as renderConversationMarkdown } from "./conversation-render"
import {
  clearDraftForWorkspace,
  getWorkspaceSendMode,
  setWorkspaceSendMode,
  switchWorkspaceDraft,
  type DraftState,
  type SendModeState,
} from "../workspace/session-state"

const GLOBAL_LOG_STREAM_ID = 0
const APP_VERSION = process.env.npm_package_version ?? "0.1.0"

type FocusTarget = "repo" | "workspace" | "changes" | "input"
type ResizeEdge = "left" | "right"
type ResizeState = {
  edge: ResizeEdge
  startX: number
  startLeftWidth: number
  startRightWidth: number
}

const MIN_LEFT_WIDTH = 24
const MAX_LEFT_WIDTH = 72
const MIN_RIGHT_WIDTH = 34
const MAX_RIGHT_WIDTH = 84
const MIN_CENTER_WIDTH = 52
const MAX_STREAM_REMAINDER_CHARS = 8192

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function maxLeftWidth(totalWidth: number, rightVisible: boolean, rightWidth: number): number {
  const splitters = rightVisible ? 2 : 1
  return totalWidth - (rightVisible ? rightWidth : 0) - splitters - MIN_CENTER_WIDTH
}

function maxRightWidth(totalWidth: number, leftVisible: boolean, leftWidth: number): number {
  const splitters = leftVisible ? 2 : 1
  return totalWidth - (leftVisible ? leftWidth : 0) - splitters - MIN_CENTER_WIDTH
}

function formatSectionHeader(title: string, collapsed: boolean, width: number): string {
  const icon = collapsed ? "▸" : "▾"
  const prefix = `${icon} ${title} `
  const filler = Math.max(0, width - prefix.length)
  return `${prefix}${"─".repeat(filler)}`
}

function truncateWithEllipsis(value: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (value.length <= maxChars) return value
  if (maxChars === 1) return "…"
  return `${value.slice(0, maxChars - 1).trimEnd()}…`
}

function formatCommandSuggestionLine(command: string, description: string, width: number): string {
  const lhs = `/${command}`
  const rhs = description
  const minGap = 2
  const free = width - lhs.length - rhs.length

  if (free >= minGap) {
    return `${lhs}${" ".repeat(free)}${rhs}`
  }

  return truncateWithEllipsis(`${lhs} — ${rhs}`, width)
}

function workspaceStatusColor(status: string): string {
  switch (status) {
    case "active":
      return "#86efac"
    case "busy":
      return "#93c5fd"
    case "error":
      return "#fca5a5"
    default:
      return "#94a3b8"
  }
}

type DiffRow = {
  plus: string
  minus: string
  path: string
}

type RunProcessEntry = {
  id: number
  label: string
  command: string
  child: ChildProcessWithoutNullStreams
}

export interface AppSnapshot {
  repos: RepoRecord[]
  workspaces: WorkspaceRecord[]
  repoOptions: SelectOption[]
  workspaceOptions: SelectOption[]
  workspaceTreeOptions: SelectOption[]
  repoSelectedIndex: number
  workspaceSelectedIndex: number
  workspaceTreeSelectedIndex: number
  selectedRepoId: number | null
  selectedWorkspaceId: number | null
  sendMode: SendMode
  leftSidebarCollapsed: boolean
  rightSidebarCollapsed: boolean
  agentBusy: boolean
  thinkingActive: boolean
  thinkingPreview: string
  headerText: string
  statusText: string
  conversationTabsText: string
  conversationMarkdown: string
  commandModalVisible: boolean
  commandModalTitle: string
  commandModalMarkdown: string
  diffModalVisible: boolean
  diffViewMode: DiffViewMode
  diffReviewTitle: string
  diffReviewDiff: string
  diffReviewFiletype: string | undefined
  diffHunkIndex: number
  diffHunkCount: number
  diffFileCount: number
  diffSelectedIndex: number
  diffRows: DiffRow[]
  diffText: string
  terminalText: string
  footerText: string
}

function timePrefix() {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, "0")
  const mm = String(now.getMinutes()).padStart(2, "0")
  const ss = String(now.getSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

function isLikelyGitUrl(value: string) {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("git@") ||
    value.startsWith("ssh://") ||
    value.endsWith(".git")
  )
}

function safeErr(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function filetypeForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case ".ts":
      return "typescript"
    case ".tsx":
      return "tsx"
    case ".js":
      return "javascript"
    case ".jsx":
      return "jsx"
    case ".json":
      return "json"
    case ".md":
      return "markdown"
    case ".yml":
    case ".yaml":
      return "yaml"
    case ".sh":
      return "bash"
    case ".css":
      return "css"
    case ".html":
      return "html"
    default:
      return undefined
  }
}

function parseArgs(input: string): string[] {
  const args: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let escaping = false

  const pushCurrent = () => {
    if (current.length > 0) {
      args.push(current)
      current = ""
    }
  }

  for (const ch of input.trim()) {
    if (escaping) {
      current += ch
      escaping = false
      continue
    }

    if (ch === "\\") {
      escaping = true
      continue
    }

    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'"
      continue
    }

    if (/\s/.test(ch)) {
      pushCurrent()
      continue
    }

    current += ch
  }

  pushCurrent()

  return args
}

function expandUserPath(value: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return value
}

export class PiConductorApp {
  private readonly renderer: CliRenderer
  private readonly root: Root
  private readonly config: AppConfig
  private readonly store: Store
  private runMode: RunMode

  private repos: RepoRecord[] = []
  private workspaces: WorkspaceRecord[] = []

  private repoOptions: SelectOption[] = []
  private workspaceOptions: SelectOption[] = []
  private workspaceTreeOptions: SelectOption[] = []
  private repoSelectedIndex = 0
  private workspaceSelectedIndex = 0
  private workspaceTreeSelectedIndex = 0

  private selectedRepoId: number | null = null
  private selectedWorkspaceId: number | null = null
  private sendModeState: SendModeState = { defaultMode: "prompt", byWorkspace: new Map<number, SendMode>() }

  private readonly agentByWorkspace = new Map<number, PiRpcProcess>()
  private readonly logsByStream = new Map<number, string[]>()
  private readonly runLogsByWorkspace = new Map<number, string[]>()
  private readonly assistantPartialByWorkspace = new Map<number, string>()
  private readonly thinkingPartialByWorkspace = new Map<number, string>()
  private readonly lastThinkingPreviewByWorkspace = new Map<number, string>()
  private readonly runProcessesByWorkspace = new Map<number, Set<RunProcessEntry>>()
  private readonly runSequenceByWorkspace = new Map<number, number>()
  private readonly agentTurnsInFlight = new Set<number>()
  private readonly expandedRepoIds = new Set<number>()
  private readonly lastActivityByWorkspace = new Map<number, string>()
  private readonly lastTestRunByWorkspace = new Map<number, TestRunState>()
  private readonly uiFlushScheduler = new UiFlushScheduler(45, () => {
    this.refreshStatusPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  })

  private leftSidebarCollapsed = false
  private rightSidebarCollapsed = false
  private agentBusy = false
  private isShuttingDown = false

  private headerText = "Piductor · loading..."
  private statusText = "repo       <none>"
  private diffModalVisible = false
  private conversationTabsText = " All changes · Review branch changes · Debugging"
  private conversationMarkdown = DEFAULT_CONVERSATION
  private commandModalVisible = false
  private commandModalTitle = ""
  private commandModalMarkdown = ""
  private diffViewMode: DiffViewMode = "unified"
  private diffReviewTitle = "Review branch changes"
  private diffReviewDiff = ""
  private diffReviewFiletype: string | undefined = undefined
  private diffReviewHunkCount = 0
  private diffReviewHunkIndex = 0
  private diffFileCount = 0
  private diffSelectedIndex = 0
  private diffRows: DiffRow[] = []
  private diffText = "No workspace selected."
  private readonly selectedDiffPathByWorkspace = new Map<number, string>()
  private readonly selectedDiffHunkByWorkspace = new Map<number, number>()
  private readonly diffFingerprintByWorkspace = new Map<number, string>()
  private readonly reviewedDiffFingerprintByWorkspace = new Map<number, string>()
  private lastDiffReviewRefreshKey = ""
  private terminalText = "No workspace selected."
  private footerText = ""

  private snapshot: AppSnapshot = {
    repos: [],
    workspaces: [],
    repoOptions: [],
    workspaceOptions: [],
    workspaceTreeOptions: [],
    repoSelectedIndex: 0,
    workspaceSelectedIndex: 0,
    workspaceTreeSelectedIndex: 0,
    selectedRepoId: null,
    selectedWorkspaceId: null,
    sendMode: this.sendModeState.defaultMode,
    leftSidebarCollapsed: false,
    rightSidebarCollapsed: false,
    agentBusy: false,
    thinkingActive: false,
    thinkingPreview: "",
    headerText: this.headerText,
    statusText: this.statusText,
    conversationTabsText: this.conversationTabsText,
    conversationMarkdown: this.conversationMarkdown,
    commandModalVisible: this.commandModalVisible,
    commandModalTitle: this.commandModalTitle,
    commandModalMarkdown: this.commandModalMarkdown,
    diffModalVisible: this.diffModalVisible,
    diffViewMode: this.diffViewMode,
    diffReviewTitle: this.diffReviewTitle,
    diffReviewDiff: this.diffReviewDiff,
    diffReviewFiletype: this.diffReviewFiletype,
    diffHunkIndex: this.diffReviewHunkIndex,
    diffHunkCount: this.diffReviewHunkCount,
    diffFileCount: this.diffFileCount,
    diffSelectedIndex: this.diffSelectedIndex,
    diffRows: [],
    diffText: this.diffText,
    terminalText: this.terminalText,
    footerText: this.footerText,
  }

  private readonly listeners = new Set<() => void>()

  private constructor(renderer: CliRenderer, root: Root, config: AppConfig, store: Store) {
    this.renderer = renderer
    this.root = root
    this.config = config
    this.store = store
    this.runMode = normalizeRunMode(config.scripts.runMode)
  }

  static async create(config: AppConfig, store: Store): Promise<PiConductorApp> {
    const renderer = await createCliRenderer({
      targetFps: 60,
      exitOnCtrlC: false,
      useConsole: true,
      useMouse: true,
    })

    renderer.setBackgroundColor("#0b1220")

    const root = createRoot(renderer)
    const app = new PiConductorApp(renderer, root, config, store)

    root.render(<PiConductorView app={app} />)

    await app.bootstrap()

    renderer.start()

    return app
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => {
    return this.snapshot
  }

  private emitSnapshot() {
    const selectedWorkspaceId = this.selectedWorkspaceId
    const liveThinkingRaw = selectedWorkspaceId ? this.thinkingPartialByWorkspace.get(selectedWorkspaceId) ?? "" : ""
    const persistedThinkingPreview = selectedWorkspaceId
      ? this.lastThinkingPreviewByWorkspace.get(selectedWorkspaceId) ?? ""
      : ""
    const thinkingPreview = compactThinkingPreview(liveThinkingRaw || persistedThinkingPreview)
    const thinkingActive = selectedWorkspaceId ? this.agentTurnsInFlight.has(selectedWorkspaceId) : false

    this.snapshot = {
      repos: [...this.repos],
      workspaces: [...this.workspaces],
      repoOptions: [...this.repoOptions],
      workspaceOptions: [...this.workspaceOptions],
      workspaceTreeOptions: [...this.workspaceTreeOptions],
      repoSelectedIndex: this.repoSelectedIndex,
      workspaceSelectedIndex: this.workspaceSelectedIndex,
      workspaceTreeSelectedIndex: this.workspaceTreeSelectedIndex,
      selectedRepoId: this.selectedRepoId,
      selectedWorkspaceId: this.selectedWorkspaceId,
      sendMode: this.getActiveSendMode(),
      leftSidebarCollapsed: this.leftSidebarCollapsed,
      rightSidebarCollapsed: this.rightSidebarCollapsed,
      agentBusy: this.agentBusy,
      thinkingActive,
      thinkingPreview,
      headerText: this.headerText,
      statusText: this.statusText,
      conversationTabsText: this.conversationTabsText,
      conversationMarkdown: this.conversationMarkdown,
      commandModalVisible: this.commandModalVisible,
      commandModalTitle: this.commandModalTitle,
      commandModalMarkdown: this.commandModalMarkdown,
      diffModalVisible: this.diffModalVisible,
      diffViewMode: this.diffViewMode,
      diffReviewTitle: this.diffReviewTitle,
      diffReviewDiff: this.diffReviewDiff,
      diffReviewFiletype: this.diffReviewFiletype,
      diffHunkIndex: this.diffReviewHunkIndex,
      diffHunkCount: this.diffReviewHunkCount,
      diffFileCount: this.diffFileCount,
      diffSelectedIndex: this.diffSelectedIndex,
      diffRows: [...this.diffRows],
      diffText: this.diffText,
      terminalText: this.terminalText,
      footerText: this.footerText,
    }

    for (const listener of this.listeners) {
      listener()
    }
  }

  private async bootstrap() {
    this.appendGlobalLog("Welcome to Piductor (terminal prototype).")
    this.appendGlobalLog("Type /help to see commands.")

    await this.autoAddCurrentRepoIfPossible()
    this.reloadRepos()
    this.reloadWorkspaces()
    this.refreshStatusPanel()
    this.refreshDiffPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  }

  public toggleLeftSidebar() {
    this.leftSidebarCollapsed = !this.leftSidebarCollapsed
    this.emitSnapshot()
  }

  public toggleRightSidebar() {
    this.rightSidebarCollapsed = !this.rightSidebarCollapsed
    this.emitSnapshot()
  }

  public async refreshEverythingFromDisk() {
    this.reloadRepos()
    this.reloadWorkspaces()
    this.refreshDiffPanel()
    this.refreshStatusPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.appendGlobalLog("Refreshed repos/workspaces.")
    this.refreshLogsPanel()
    this.emitSnapshot()
  }

  public clearCurrentLogs() {
    const keyId = this.selectedWorkspaceId ?? GLOBAL_LOG_STREAM_ID
    this.logsByStream.set(keyId, [])
    if (this.selectedWorkspaceId) {
      this.runLogsByWorkspace.set(this.selectedWorkspaceId, [])
    }
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  }

  public selectRepoOption(option: SelectOption | null) {
    if (!option) return
    this.selectedRepoId = Number(option.value)
    this.expandedRepoIds.add(this.selectedRepoId)
    this.repoSelectedIndex = Math.max(
      0,
      this.repoOptions.findIndex((it) => Number(it.value) === this.selectedRepoId),
    )
    this.reloadWorkspaces()
    this.rebuildWorkspaceTreeOptions(repoTreeValue(this.selectedRepoId))
    this.refreshStatusPanel()
    this.refreshDiffPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  }

  public selectWorkspaceOption(option: SelectOption | null) {
    if (!option) return
    this.selectedWorkspaceId = Number(option.value)
    const workspace = this.store.getWorkspaceById(this.selectedWorkspaceId)
    if (workspace) {
      this.selectedRepoId = workspace.repoId
      this.expandedRepoIds.add(workspace.repoId)
      this.reloadRepos(workspace.repoId)
    }
    this.workspaceSelectedIndex = Math.max(
      0,
      this.workspaceOptions.findIndex((it) => Number(it.value) === this.selectedWorkspaceId),
    )
    if (workspace) {
      this.rebuildWorkspaceTreeOptions(workspaceTreeValue(workspace.repoId, workspace.id))
    } else {
      this.rebuildWorkspaceTreeOptions()
    }
    this.refreshStatusPanel()
    this.refreshDiffPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  }

  private nextWorkspaceName(repoId: number, baseName: string): string {
    const trimmed = baseName.trim()
    const stem = trimmed.length > 0 ? trimmed : "workspace"
    const existing = new Set(this.store.listWorkspaces(repoId, true).map((workspace) => workspace.name))

    if (!existing.has(stem)) {
      return stem
    }

    for (let index = 2; index <= 999; index += 1) {
      const candidate = `${stem}-${index}`
      if (!existing.has(candidate)) {
        return candidate
      }
    }

    return `${stem}-${Date.now().toString(36).slice(-4)}`
  }

  public async createWorkspaceFromPath(inputPath: string): Promise<boolean> {
    const raw = inputPath.trim()
    if (!raw) {
      this.appendGlobalLog("Path is required.")
      this.refreshAllAndEmit()
      return false
    }

    const expanded = expandUserPath(raw)
    const resolved = path.resolve(process.cwd(), expanded)

    let repoRoot = ""
    let repoName = ""
    try {
      const ensured = ensureRepoFromLocalPath(resolved)
      repoRoot = ensured.repoRoot
      repoName = ensured.repoName
    } catch (error) {
      this.appendGlobalLog(`Invalid repo path: ${resolved}`)
      this.appendGlobalLog(`ERROR: ${safeErr(error)}`)
      this.refreshAllAndEmit()
      return false
    }

    try {
      const repo = this.store.upsertRepo(repoName, repoRoot)
      this.selectedRepoId = repo.id
      this.expandedRepoIds.add(repo.id)
      this.reloadRepos(repo.id)

      const baseRef = getDefaultBranchName(repo.rootPath)
      const workspaceName = this.nextWorkspaceName(repo.id, suggestWorkspaceNameFromBranch(baseRef))
      const created = createWorktree({
        repoRoot: repo.rootPath,
        workspacesDir: this.config.workspacesDir,
        workspaceName,
        baseRef,
      })

      const workspace = this.store.createWorkspace(repo.id, workspaceName, created.branch, created.worktreePath)
      this.selectedWorkspaceId = workspace.id
      this.reloadWorkspaces(workspace.id)
      this.appendWorkspaceLog(
        workspace.id,
        `Workspace created at ${workspace.worktreePath} on branch ${workspace.branch} (base ${baseRef})`,
      )

      if (this.config.scripts.setup) {
        void this.runConfiguredScript(workspace.id, "setup")
      }

      this.refreshAllAndEmit()
      return true
    } catch (error) {
      this.appendGlobalLog(`Failed to create workspace from path: ${resolved}`)
      this.appendGlobalLog(`ERROR: ${safeErr(error)}`)
      this.refreshAllAndEmit()
      return false
    }
  }

  public async submitInput(input: string) {
    const text = input.trim()
    if (!text) return

    try {
      if (text.startsWith("/")) {
        await this.handleCommand(text)
      } else {
        await this.sendMessageToSelectedAgent(text)
      }
    } catch (error) {
      this.appendGlobalLog(`ERROR: ${safeErr(error)}`)
    }

    this.refreshStatusPanel()
    this.refreshDiffPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  }

  private async handleCommand(commandLine: string) {
    const [command, ...args] = parseArgs(commandLine.slice(1))

    switch (command) {
      case "help": {
        this.openCommandModal("Help", buildHelpMarkdown())
        return
      }

      case "repo": {
        const sub = args[0]
        if (sub === "add") {
          const target = args[1]
          const preferredName = args[2]
          if (!target) {
            this.appendGlobalLog("Usage: /repo add <local-path|git-url> [name]")
            return
          }

          if (isLikelyGitUrl(target)) {
            const { repoRoot, repoName } = cloneRepo(target, this.config.reposDir, preferredName)
            const repo = this.store.upsertRepo(preferredName || repoName, repoRoot)
            this.selectedRepoId = repo.id
            this.appendGlobalLog(`Cloned and added repo: ${repo.name} (${repo.rootPath})`)
          } else {
            const expanded = expandUserPath(target)
            const resolved = path.resolve(process.cwd(), expanded)
            const { repoRoot, repoName } = ensureRepoFromLocalPath(resolved)
            const repo = this.store.upsertRepo(preferredName || repoName, repoRoot)
            this.selectedRepoId = repo.id
            this.appendGlobalLog(`Added local repo: ${repo.name} (${repo.rootPath})`)
          }

          this.reloadRepos(this.selectedRepoId)
          this.reloadWorkspaces()
          return
        }

        if (sub === "select") {
          const needle = args[1]
          if (!needle) {
            this.appendGlobalLog("Usage: /repo select <id|name>")
            return
          }
          const repo =
            this.repos.find((it) => String(it.id) === needle) ||
            this.repos.find((it) => it.name.toLowerCase() === needle.toLowerCase())

          if (!repo) {
            this.appendGlobalLog(`Repo not found: ${needle}`)
            return
          }

          this.selectedRepoId = repo.id
          this.reloadRepos(repo.id)
          this.reloadWorkspaces()
          this.appendGlobalLog(`Selected repo: ${repo.name}`)
          return
        }

        this.appendGlobalLog("Usage: /repo add|select ...")
        return
      }

      case "workspace": {
        const sub = args[0]
        if (sub === "new") {
          if (!this.selectedRepoId) {
            this.appendGlobalLog("No repo selected. Add/select a repo first.")
            return
          }

          const repo = this.store.getRepoById(this.selectedRepoId)
          if (!repo) {
            this.appendGlobalLog("Selected repo no longer exists.")
            return
          }

          const parsed = parseWorkspaceNewArgs(args.slice(1))
          if (!parsed) {
            this.appendGlobalLog(workspaceNewUsage())
            return
          }

          let baseRef = parsed.baseRef
          if (parsed.fromBranch) {
            const resolved = resolveWorkspaceBaseRef(repo.rootPath, parsed.baseRef)
            if (!resolved) {
              this.appendGlobalLog(`Branch not found: ${parsed.baseRef}`)
              this.appendGlobalLog("Use /workspace branches to list available branches.")
              return
            }
            baseRef = resolved
          }

          const created = createWorktree({
            repoRoot: repo.rootPath,
            workspacesDir: this.config.workspacesDir,
            workspaceName: parsed.workspaceName,
            baseRef,
          })

          const workspace = this.store.createWorkspace(
            this.selectedRepoId,
            parsed.workspaceName,
            created.branch,
            created.worktreePath,
          )
          this.selectedWorkspaceId = workspace.id
          this.reloadWorkspaces(workspace.id)

          this.appendWorkspaceLog(
            workspace.id,
            `Workspace created at ${workspace.worktreePath} on branch ${workspace.branch} (base ${baseRef})`,
          )

          if (this.config.scripts.setup) {
            void this.runConfiguredScript(workspace.id, "setup")
          }

          return
        }

        if (sub === "branches") {
          if (!this.selectedRepoId) {
            this.appendGlobalLog("No repo selected. Add/select a repo first.")
            return
          }

          const repo = this.store.getRepoById(this.selectedRepoId)
          if (!repo) {
            this.appendGlobalLog("Selected repo no longer exists.")
            return
          }

          const refs = listBranchRefs(repo.rootPath)
          if (refs.length === 0) {
            this.appendGlobalLog("No branches found.")
            return
          }

          this.appendGlobalLog(`Branches for ${repo.name}:`)
          for (const ref of refs.slice(0, 30)) {
            this.appendGlobalLog(`  ${ref}`)
          }
          if (refs.length > 30) {
            this.appendGlobalLog(`  ... (${refs.length - 30} more)`)
          }

          return
        }

        if (sub === "archive") {
          const workspace = this.getSelectedWorkspace()
          if (!workspace) {
            this.appendGlobalLog("No workspace selected.")
            return
          }

          const repo = this.store.getRepoById(workspace.repoId)
          if (!repo) {
            this.appendGlobalLog("Workspace repo missing.")
            return
          }

          await this.stopAgent(workspace.id, { force: false, reason: "archive" })

          if (this.config.scripts.archive) {
            await this.runConfiguredScript(workspace.id, "archive")
          }

          removeWorktree({ repoRoot: repo.rootPath, worktreePath: workspace.worktreePath, force: true })
          this.store.setWorkspaceArchived(workspace.id, true)

          this.appendGlobalLog(`Archived workspace: ${workspace.name}`)
          this.reloadWorkspaces()
          return
        }

        if (sub === "archived") {
          const archived = this.listArchivedWorkspaces()
          if (archived.length === 0) {
            this.appendGlobalLog("No archived workspaces.")
            return
          }

          this.appendGlobalLog("Archived workspaces:")
          for (const workspace of archived.slice(0, 40)) {
            const repo = this.store.getRepoById(workspace.repoId)
            const repoLabel = repo ? `${repo.name} (#${repo.id})` : `repo #${workspace.repoId}`
            this.appendGlobalLog(`  ${workspace.id} · ${workspace.name} · ${workspace.branch} · ${repoLabel}`)
          }
          if (archived.length > 40) {
            this.appendGlobalLog(`  ... (${archived.length - 40} more)`)
          }
          this.appendGlobalLog("Use /workspace restore <id|name> to restore one.")
          return
        }

        if (sub === "restore") {
          const needle = args[1]
          if (!needle) {
            this.appendGlobalLog("Usage: /workspace restore <id|name>")
            return
          }

          const workspace = this.findArchivedWorkspace(needle)
          if (!workspace) {
            this.appendGlobalLog(`Archived workspace not found: ${needle}`)
            return
          }

          const repo = this.store.getRepoById(workspace.repoId)
          if (!repo) {
            this.appendGlobalLog("Workspace repo missing.")
            return
          }

          if (existsSync(workspace.worktreePath)) {
            this.appendGlobalLog(`Cannot restore: path already exists (${workspace.worktreePath})`)
            return
          }

          addWorktreeForBranch({
            repoRoot: repo.rootPath,
            worktreePath: workspace.worktreePath,
            branch: workspace.branch,
          })

          this.store.setWorkspaceArchived(workspace.id, false)
          this.selectedRepoId = workspace.repoId
          this.selectedWorkspaceId = workspace.id
          this.reloadRepos(workspace.repoId)
          this.reloadWorkspaces(workspace.id)
          this.appendGlobalLog(`Restored workspace: ${workspace.name}`)
          return
        }

        if (sub === "select") {
          const needle = args[1]
          if (!needle) {
            this.appendGlobalLog("Usage: /workspace select <id|name>")
            return
          }

          const workspace =
            this.workspaces.find((it) => String(it.id) === needle) ||
            this.workspaces.find((it) => it.name.toLowerCase() === needle.toLowerCase())

          if (!workspace) {
            this.appendGlobalLog(`Workspace not found: ${needle}`)
            return
          }

          this.selectedWorkspaceId = workspace.id
          this.reloadWorkspaces(workspace.id)
          this.appendGlobalLog(`Selected workspace: ${workspace.name}`)
          return
        }

        this.appendGlobalLog("Usage: /workspace new|branches|archive|archived|restore|select ...")
        return
      }

      case "agent": {
        const parsed = parseAgentCommand(args)
        if (!parsed) {
          this.appendGlobalLog("Usage: /agent start [model] | /agent stop | /agent restart [model] | /agent kill | /agent list")
          return
        }

        if (parsed.action === "list") {
          this.logAgentRegistry()
          return
        }

        const workspace = this.getSelectedWorkspace()
        if (!workspace) {
          this.appendGlobalLog("No workspace selected.")
          return
        }

        if (parsed.action === "start") {
          await this.startAgent(workspace.id, parsed.model || this.config.defaultModel)
          return
        }

        if (parsed.action === "stop") {
          await this.stopAgent(workspace.id, { force: false, reason: "manual stop" })
          return
        }

        if (parsed.action === "restart") {
          const current = this.store.getAgent(workspace.id)
          const restartModel = resolveRestartModel(parsed.model, current?.model, this.config.defaultModel)
          await this.stopAgent(workspace.id, { force: false, reason: "restart" })
          await this.startAgent(workspace.id, restartModel)
          return
        }

        await this.stopAgent(workspace.id, { force: true, reason: "manual kill" })
        return
      }

      case "pr": {
        const sub = (args[0] || "").toLowerCase()
        if (sub !== "create") {
          this.appendGlobalLog(prCreateUsage())
          return
        }

        const parsed = parsePrCreateArgs(args.slice(1))
        if (!parsed) {
          this.appendGlobalLog(prCreateUsage())
          return
        }

        const workspace = this.getSelectedWorkspace()
        if (!workspace) {
          this.appendGlobalLog("No workspace selected.")
          return
        }

        if (!parsed.dryRun) {
          this.refreshDiffPanel()
          const mergeChecklist = this.evaluateWorkspaceMergeChecklist(workspace).evaluation
          if (mergeChecklist.blocked) {
            this.appendWorkspaceLog(
              workspace.id,
              `[pr] blocked by merge checklist (${mergeChecklist.pendingRequired.length} pending):`,
            )
            for (const item of mergeChecklist.pendingRequired) {
              this.appendWorkspaceLog(workspace.id, `  - [ ] ${item.label} (${item.key})`)
            }
            this.openWorkspaceChecklistModal(workspace)
            return
          }
        }

        const auth = this.runCommand("gh", ["auth", "status"], workspace.worktreePath)
        if (auth.status !== 0) {
          this.appendWorkspaceLog(workspace.id, "GitHub auth unavailable. Run `gh auth login` first.")
          if (auth.stderr) this.appendWorkspaceLog(workspace.id, auth.stderr)
          return
        }

        if (parsed.dryRun) {
          this.appendWorkspaceLog(workspace.id, `[pr] dry run: would push branch ${workspace.branch}`)
          this.appendWorkspaceLog(workspace.id, `[pr] dry run: gh pr create --fill --head ${workspace.branch}`)
          return
        }

        this.appendWorkspaceLog(workspace.id, `[pr] pushing branch ${workspace.branch} ...`)
        const push = this.runCommand("git", ["push", "-u", "origin", workspace.branch], workspace.worktreePath)
        if (push.status !== 0) {
          const detail = [push.stderr, push.stdout].filter(Boolean).join("\n") || "git push failed"
          this.appendWorkspaceLog(workspace.id, `[pr] push failed:\n${detail}`)
          return
        }

        this.appendWorkspaceLog(workspace.id, "[pr] creating pull request via gh ...")
        const create = this.runCommand("gh", ["pr", "create", "--fill", "--head", workspace.branch], workspace.worktreePath)
        const output = [create.stdout, create.stderr].filter(Boolean).join("\n")
        const prUrl = extractFirstUrl(output)

        if (create.status !== 0) {
          if (prUrl) {
            this.appendWorkspaceLog(workspace.id, `[pr] pull request already exists: ${prUrl}`)
          } else {
            this.appendWorkspaceLog(workspace.id, `[pr] create failed:\n${output || "unknown error"}`)
          }
          return
        }

        if (prUrl) {
          this.appendWorkspaceLog(workspace.id, `[pr] created: ${prUrl}`)
          this.appendGlobalLog(`PR created for ${workspace.name}: ${prUrl}`)
        } else {
          this.appendWorkspaceLog(workspace.id, `[pr] created. Output:\n${output || "(no output)"}`)
          this.appendGlobalLog(`PR created for ${workspace.name}.`)
        }
        return
      }

      case "mode": {
        const nextMode = args[0] as SendMode | undefined
        if (!nextMode || !["prompt", "steer", "follow_up"].includes(nextMode)) {
          this.appendGlobalLog("Usage: /mode <prompt|steer|follow_up>")
          return
        }

        this.setSendModeForCurrentSelection(nextMode)

        const workspace = this.getSelectedWorkspace()
        if (workspace) {
          this.appendGlobalLog(`Send mode for ${workspace.name} set to ${nextMode}`)
        } else {
          this.appendGlobalLog(`Default send mode set to ${nextMode}`)
        }
        return
      }

      case "run": {
        const workspace = this.getSelectedWorkspace()
        if (!workspace) {
          this.appendGlobalLog("No workspace selected.")
          return
        }

        const parsed = parseRunCommandArgs(args)
        if (!parsed) {
          this.appendGlobalLog(runCommandUsage())
          return
        }

        if (parsed.action === "stop") {
          const runningCount = this.runProcessCount(workspace.id)
          if (runningCount === 0) {
            this.appendWorkspaceLog(workspace.id, "No run process to stop.")
            this.appendRunLog(workspace.id, "No run process to stop.")
            this.refreshTerminalPanel()
            return
          }

          this.appendWorkspaceLog(workspace.id, "Requested run process stop.")
          await this.stopRunProcess(workspace.id, "manual stop")
          this.refreshTerminalPanel()
          return
        }

        if (parsed.action === "mode-get") {
          this.appendWorkspaceLog(workspace.id, `Run mode: ${this.runMode}`)
          this.appendGlobalLog(`Run mode (${workspace.name}): ${this.runMode}`)
          return
        }

        if (parsed.action === "mode-set") {
          this.runMode = parsed.mode
          this.appendWorkspaceLog(workspace.id, `Run mode set to ${this.runMode}`)
          this.appendGlobalLog(`Run mode updated to ${this.runMode}`)
          return
        }

        if (parsed.action === "setup") {
          await this.runConfiguredScript(workspace.id, "setup")
          return
        }

        if (parsed.action === "archive") {
          await this.runConfiguredScript(workspace.id, "archive")
          return
        }

        const command = parsed.command ?? this.config.scripts.run
        if (!command) {
          this.appendWorkspaceLog(workspace.id, "No run command specified. Set scripts.run or pass /run <command>.")
          return
        }

        await this.startRunProcess(workspace.id, command, "run", false)
        return
      }

      case "test": {
        const workspace = this.getSelectedWorkspace()
        if (!workspace) {
          this.appendGlobalLog("No workspace selected.")
          return
        }

        const command = args.length > 0 ? args.join(" ") : this.config.scripts.test
        if (!command) {
          this.appendWorkspaceLog(workspace.id, "No test command specified. Set scripts.test or pass /test <command>.")
          return
        }

        const startedAt = new Date().toISOString()
        this.lastTestRunByWorkspace.set(workspace.id, nextTestRunStarted(startedAt))
        this.appendWorkspaceLog(workspace.id, `[test] started at ${startedAt}`)
        this.refreshStatusPanel()
        this.emitSnapshot()

        await this.startRunProcess(workspace.id, command, "test", false, {
          onExit: (code, signal) => {
            const finishedAt = new Date().toISOString()
            const result = nextTestRunFinished(code, signal, finishedAt)
            this.lastTestRunByWorkspace.set(workspace.id, result)
            this.appendWorkspaceLog(workspace.id, `[test] ${formatTestRunStatus(result)} at ${finishedAt}`)
            this.refreshStatusPanel()
            this.emitSnapshot()
          },
        })
        return
      }

      case "ui": {
        const sub = (args[0] || "").toLowerCase()
        if (sub === "left") {
          this.toggleLeftSidebar()
          return
        }
        if (sub === "right") {
          this.toggleRightSidebar()
          return
        }
        if (sub === "toggle") {
          this.toggleLeftSidebar()
          this.toggleRightSidebar()
          return
        }
        this.appendGlobalLog("Usage: /ui left|right|toggle")
        return
      }

      case "status": {
        this.appendGlobalLog("Status refreshed.")
        this.refreshStatusPanel()
        return
      }

      case "checklist": {
        const workspace = this.getSelectedWorkspace()
        if (!workspace) {
          this.appendGlobalLog("No workspace selected.")
          return
        }

        const sub = (args[0] || "show").toLowerCase()

        if (!sub || sub === "show") {
          this.openWorkspaceChecklistModal(workspace)
          return
        }

        if (sub === "add") {
          const label = args.slice(1).join(" ").trim()
          if (!label) {
            this.appendGlobalLog("Usage: /checklist add <label>")
            return
          }

          const existingKeys = this.store.listMergeChecklistItems(workspace.id).map((item) => item.itemKey)
          const key = createChecklistItemKey(label, existingKeys)
          this.store.upsertMergeChecklistItem({
            workspaceId: workspace.id,
            itemKey: key,
            label,
            required: true,
            completed: false,
          })
          this.appendWorkspaceLog(workspace.id, `[checklist] added: ${label} (key=${key})`)
          this.refreshStatusPanel()
          return
        }

        if (sub === "done" || sub === "undone" || sub === "remove") {
          const needle = args.slice(1).join(" ").trim()
          if (!needle) {
            this.appendGlobalLog(`Usage: /checklist ${sub} <key|label>`)
            return
          }

          const found = this.findManualChecklistItem(workspace.id, needle)
          if (!found) {
            this.appendWorkspaceLog(workspace.id, `[checklist] item not found: ${needle}`)
            return
          }

          if (sub === "remove") {
            this.store.deleteMergeChecklistItem(workspace.id, found.itemKey)
            this.appendWorkspaceLog(workspace.id, `[checklist] removed: ${found.label} (key=${found.itemKey})`)
          } else {
            const completed = sub === "done"
            this.store.setMergeChecklistItemCompleted(workspace.id, found.itemKey, completed)
            this.appendWorkspaceLog(
              workspace.id,
              `[checklist] ${completed ? "done" : "undone"}: ${found.label} (key=${found.itemKey})`,
            )
          }

          this.refreshStatusPanel()
          return
        }

        if (sub === "clear") {
          this.store.clearMergeChecklistItems(workspace.id)
          this.appendWorkspaceLog(workspace.id, "[checklist] cleared all manual items.")
          this.refreshStatusPanel()
          return
        }

        this.appendGlobalLog("Usage: /checklist [show|add|done|undone|remove|clear] ...")
        return
      }

      case "diff": {
        const sub = (args[0] || "").toLowerCase()

        if (!sub || sub === "open") {
          this.refreshDiffPanel()
          this.openDiffReview()
          this.appendGlobalLog("Opened diff review.")
          return
        }

        if (sub === "close") {
          this.closeDiffReview()
          this.appendGlobalLog("Closed diff review.")
          return
        }

        if (sub === "next") {
          this.cycleDiffFile(1)
          return
        }

        if (sub === "prev") {
          this.cycleDiffFile(-1)
          return
        }

        if (sub === "hunk") {
          this.appendGlobalLog("Hunk jumping is not available in stacked view yet.")
          return
        }

        if (sub === "mode") {
          const mode = (args[1] || "").toLowerCase()
          if (mode === "unified" && this.diffViewMode !== "unified") {
            this.toggleDiffViewMode()
            return
          }
          if (mode === "split" && this.diffViewMode !== "split") {
            this.toggleDiffViewMode()
            return
          }
          if (!mode) {
            this.toggleDiffViewMode()
            return
          }
          this.appendGlobalLog("Usage: /diff mode [unified|split]")
          return
        }

        if (sub === "refresh") {
          this.refreshDiffPanel()
          if (this.diffModalVisible) {
            this.refreshDiffReviewPanel(true)
          }
          this.emitSnapshot()
          this.appendGlobalLog("Diff panel refreshed.")
          return
        }

        this.appendGlobalLog("Usage: /diff [open|close|next|prev|mode [unified|split]|refresh]")
        return
      }

      default:
        this.appendGlobalLog(`Unknown command: /${command}`)
    }
  }

  private runCommand(command: string, args: string[], cwd: string) {
    const result = spawnSync(command, args, {
      cwd,
      env: process.env,
      encoding: "utf8",
    })

    return {
      status: result.status ?? -1,
      stdout: String(result.stdout ?? "").trim(),
      stderr: String(result.stderr ?? "").trim(),
    }
  }

  private signalRunProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
    if (!child.pid) return

    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, signal)
        return
      }
    } catch {
      // Fall back to direct child signal below.
    }

    try {
      child.kill(signal)
    } catch {
      // Already exited.
    }
  }

  private runProcessCount(workspaceId: number): number {
    return this.runProcessesByWorkspace.get(workspaceId)?.size ?? 0
  }

  private nextRunId(workspaceId: number): number {
    const next = (this.runSequenceByWorkspace.get(workspaceId) ?? 0) + 1
    this.runSequenceByWorkspace.set(workspaceId, next)
    return next
  }

  private trackRunProcess(workspaceId: number, entry: RunProcessEntry) {
    const running = this.runProcessesByWorkspace.get(workspaceId) ?? new Set<RunProcessEntry>()
    running.add(entry)
    this.runProcessesByWorkspace.set(workspaceId, running)
  }

  private untrackRunProcess(workspaceId: number, entry: RunProcessEntry) {
    const running = this.runProcessesByWorkspace.get(workspaceId)
    if (!running) {
      return
    }

    running.delete(entry)
    if (running.size === 0) {
      this.runProcessesByWorkspace.delete(workspaceId)
    }
  }

  private async stopRunProcess(workspaceId: number, reason: string) {
    const running = [...(this.runProcessesByWorkspace.get(workspaceId) ?? [])]
    if (running.length === 0) return

    const [gracefulSignal, forceSignal] = stopSignalSequence()
    for (const entry of running) {
      this.appendRunLog(workspaceId, formatRunLogLine(entry.id, "meta", `stopping (${reason}) ...`))
      this.signalRunProcess(entry.child, gracefulSignal)
    }
    await sleep(220)

    const remaining = [...(this.runProcessesByWorkspace.get(workspaceId) ?? [])]
    if (remaining.length > 0) {
      for (const entry of remaining) {
        this.signalRunProcess(entry.child, forceSignal)
        this.appendRunLog(workspaceId, formatRunLogLine(entry.id, "meta", `escalated to ${forceSignal}`))
      }
    }

    this.refreshTerminalPanel()
    this.refreshStatusPanel()
    this.emitSnapshot()
  }

  private async sendMessageToSelectedAgent(message: string) {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) {
      this.appendGlobalLog("No workspace selected.")
      return
    }

    this.flushThinkingPartial(workspace.id, false)

    const sendMode = this.getSendModeForWorkspace(workspace.id)
    let agent = this.agentByWorkspace.get(workspace.id)

    if (!agent && sendMode !== "prompt") {
      this.appendWorkspaceLog(workspace.id, "Agent is not running. Use /agent start")
      return
    }

    this.appendWorkspaceLog(workspace.id, `[you/${sendMode}] ${message}`)

    if (!agent) {
      await this.startAgent(workspace.id, this.config.defaultModel)
      agent = this.agentByWorkspace.get(workspace.id)
      if (!agent) {
        return
      }
    }

    this.agentTurnsInFlight.add(workspace.id)
    this.refreshStatusPanel()
    this.emitSnapshot()

    try {
      if (sendMode === "prompt") {
        await agent.prompt(message)
      } else if (sendMode === "steer") {
        await agent.steer(message)
      } else {
        await agent.followUp(message)
      }
    } catch (error) {
      this.agentTurnsInFlight.delete(workspace.id)
      this.refreshStatusPanel()
      this.emitSnapshot()
      throw error
    }
  }

  private async startAgent(workspaceId: number, model?: string) {
    const workspace = this.store.getWorkspaceById(workspaceId)
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)

    if (this.agentByWorkspace.has(workspaceId)) {
      this.appendWorkspaceLog(workspaceId, "Agent already running.")
      return
    }

    const agent = new PiRpcProcess({
      piCommand: this.config.piCommand,
      cwd: workspace.worktreePath,
      model,
    })

    this.agentByWorkspace.set(workspaceId, agent)
    this.store.setAgentState({
      workspaceId,
      status: "starting",
      model: model ?? null,
      pid: null,
    })

    agent.onEvent((event) => {
      this.handleAgentEvent(workspaceId, event)
    })

    agent.onStderr((line) => {
      const cleaned = sanitizePiStderrLine(line)
      if (!shouldSurfacePiStderr(cleaned)) {
        return
      }

      this.appendWorkspaceLog(workspaceId, `[pi:stderr] ${cleaned}`)
      this.scheduleUiFlush()
    })

    try {
      await agent.start()
      await agent.setSessionName(workspace.name)

      const state = await agent.getState()
      this.store.setAgentState({
        workspaceId,
        status: "running",
        pid: agent.pid,
        model: model ?? null,
        sessionId: state?.sessionId ?? null,
      })

      this.appendWorkspaceLog(workspaceId, `[agent] started (pid=${agent.pid ?? "?"}).`)
    } catch (error) {
      this.store.setAgentState({
        workspaceId,
        status: "error",
        pid: null,
        model: model ?? null,
        lastError: safeErr(error),
      })
      this.agentByWorkspace.delete(workspaceId)
      this.appendWorkspaceLog(workspaceId, `Failed to start agent: ${safeErr(error)}`)
    }

    this.reloadWorkspaces(this.selectedWorkspaceId)
    this.refreshStatusPanel()
    this.refreshLogsPanel()
    this.emitSnapshot()
  }

  private async stopAgent(workspaceId: number, options: { force: boolean; reason: string }) {
    const { force, reason } = options
    const agent = this.agentByWorkspace.get(workspaceId)
    const persisted = this.store.getAgent(workspaceId)

    if (!agent) {
      if (force && persisted?.pid) {
        const result = killProcessByPid(persisted.pid, { signal: "SIGKILL" })
        if (result === "killed") {
          this.appendWorkspaceLog(workspaceId, `[agent] killed stale pid ${persisted.pid} (${reason})`)
        } else if (result === "missing") {
          this.appendWorkspaceLog(workspaceId, `[agent] stale pid ${persisted.pid} already exited`)
        } else {
          this.appendWorkspaceLog(workspaceId, `[agent] failed to kill stale pid ${persisted.pid}`)
        }
      } else {
        this.appendWorkspaceLog(workspaceId, "Agent is not running.")
      }

      this.agentTurnsInFlight.delete(workspaceId)
      this.store.setAgentState({
        workspaceId,
        status: "stopped",
        pid: null,
        model: persisted?.model ?? null,
        sessionId: null,
      })
      this.reloadWorkspaces(this.selectedWorkspaceId)
      this.refreshStatusPanel()
      this.refreshLogsPanel()
      this.emitSnapshot()
      return
    }

    try {
      if (force) {
        await agent.kill()
      } else {
        await agent.stop()
      }
    } catch (error) {
      this.appendWorkspaceLog(workspaceId, `Error while ${force ? "killing" : "stopping"} agent: ${safeErr(error)}`)
    }

    this.agentByWorkspace.delete(workspaceId)
    this.agentTurnsInFlight.delete(workspaceId)
    this.store.setAgentState({
      workspaceId,
      status: "stopped",
      pid: null,
      model: persisted?.model ?? null,
      sessionId: null,
    })
    this.appendWorkspaceLog(workspaceId, force ? `Agent killed (${reason}).` : `Agent stopped (${reason}).`)
    this.reloadWorkspaces(this.selectedWorkspaceId)
    this.refreshStatusPanel()
    this.refreshLogsPanel()
    this.emitSnapshot()
  }

  private async runConfiguredScript(workspaceId: number, scriptType: "setup" | "archive") {
    const command = scriptType === "setup" ? this.config.scripts.setup : this.config.scripts.archive
    if (!command) {
      this.appendWorkspaceLog(workspaceId, `No ${scriptType} script configured. Set scripts.${scriptType} in piductor.json.`)
      return
    }

    this.appendWorkspaceLog(workspaceId, `Running ${scriptType} script: ${command}`)
    await this.startRunProcess(workspaceId, command, scriptType, true)
  }

  private async startRunProcess(
    workspaceId: number,
    command: string,
    label: string,
    waitForExit: boolean,
    options?: { onExit?: (code: number | null, signal: NodeJS.Signals | null) => void },
  ) {
    const workspace = this.store.getWorkspaceById(workspaceId)
    if (!workspace) {
      this.appendGlobalLog(`Workspace ${workspaceId} not found for ${label} script.`)
      return
    }

    const repo = this.store.getRepoById(workspace.repoId)
    if (!repo) {
      this.appendGlobalLog(`Repo for workspace ${workspace.name} not found for ${label} script.`)
      return
    }

    if (shouldStopExistingRun(this.runMode, this.runProcessCount(workspaceId) > 0)) {
      this.appendRunLog(workspaceId, `[run] replacing existing process (mode=${this.runMode})`)
      await this.stopRunProcess(workspaceId, "nonconcurrent mode")
    }

    const runId = this.nextRunId(workspaceId)

    const defaultBranch = getDefaultBranchName(repo.rootPath)
    const scriptEnv = buildWorkspaceScriptEnv({
      baseEnv: process.env,
      repo,
      workspace,
      defaultBranch,
    })

    const child = spawn("bash", ["-lc", command], {
      cwd: workspace.worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: scriptEnv,
      detached: process.platform !== "win32",
    })

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")

    const runEntry: RunProcessEntry = { id: runId, label, command, child }
    this.trackRunProcess(workspaceId, runEntry)
    this.appendWorkspaceLog(workspaceId, `[${label}#${runId}] started (mode=${this.runMode})`)
    this.appendRunLog(workspaceId, formatRunLogLine(runId, "meta", `${label} mode=${this.runMode} active=${this.runProcessCount(workspaceId)}`))
    this.appendRunLog(workspaceId, formatRunLogLine(runId, "cmd", `$ ${command}`))
    this.refreshTerminalPanel()
    this.refreshStatusPanel()
    this.emitSnapshot()

    const attach = (stream: NodeJS.ReadableStream, prefix: string) => {
      let buffer = ""
      stream.on("data", (chunk: any) => {
        const consumed = consumeBufferedLines(buffer, String(chunk), MAX_STREAM_REMAINDER_CHARS)
        buffer = consumed.remainder

        for (const rawLine of consumed.lines) {
          const line = rawLine.trimEnd()
          if (!line) {
            continue
          }

          this.appendRunLog(workspaceId, formatRunLogLine(runId, prefix === "out" ? "out" : "err", line))
          if (this.selectedWorkspaceId === workspaceId) {
            this.scheduleUiFlush()
          }
        }
      })
    }

    attach(child.stdout, "out")
    attach(child.stderr, "err")

    const exitPromise = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        this.untrackRunProcess(workspaceId, runEntry)
        this.appendWorkspaceLog(workspaceId, `[${label}#${runId}] ${formatRunExitSummary(code, signal)}`)
        this.appendRunLog(workspaceId, formatRunLogLine(runId, "exit", formatRunExitSummary(code, signal)))
        options?.onExit?.(code, signal)
        this.reloadWorkspaces(this.selectedWorkspaceId)
        this.refreshStatusPanel()
        this.refreshDiffPanel()
        this.refreshTerminalPanel()
        this.refreshLogsPanel()
        this.emitSnapshot()
        resolve()
      })
    })

    if (waitForExit) {
      await exitPromise
    }
  }

  private handleAgentEvent(workspaceId: number, event: Record<string, any>) {
    switch (event.type) {
      case "process_error":
        this.agentTurnsInFlight.delete(workspaceId)
        this.flushThinkingPartial(workspaceId)
        this.store.setAgentState({
          workspaceId,
          status: "error",
          pid: null,
          model: null,
          sessionId: null,
          lastError: event.error,
        })
        this.appendWorkspaceLog(workspaceId, `[agent] process error: ${event.error}`)
        break

      case "process_exit":
        this.agentTurnsInFlight.delete(workspaceId)
        this.store.setAgentState({
          workspaceId,
          status: event.code === 0 ? "stopped" : "error",
          pid: null,
          model: null,
          sessionId: null,
          lastError: event.code === 0 ? null : `exit code ${event.code}`,
        })
        this.agentByWorkspace.delete(workspaceId)
        this.flushThinkingPartial(workspaceId)
        this.flushAssistantPartial(workspaceId)
        this.appendWorkspaceLog(
          workspaceId,
          `[agent] exited code=${event.code ?? "null"} signal=${event.signal ?? "none"}`,
        )
        break

      case "agent_start":
        this.agentTurnsInFlight.add(workspaceId)
        this.flushThinkingPartial(workspaceId, false)
        this.appendWorkspaceLog(workspaceId, "[agent] started turn")
        break

      case "turn_start":
        this.agentTurnsInFlight.add(workspaceId)
        this.flushThinkingPartial(workspaceId, false)
        break

      case "agent_end":
        this.agentTurnsInFlight.delete(workspaceId)
        this.flushThinkingPartial(workspaceId)
        this.flushAssistantPartial(workspaceId)
        this.appendWorkspaceLog(workspaceId, "[agent] completed turn")
        this.refreshDiffPanel()
        break

      case "tool_execution_start":
        this.appendWorkspaceLog(workspaceId, `[tool] ${event.toolName} start`)
        break

      case "tool_execution_end":
        this.appendWorkspaceLog(workspaceId, `[tool] ${event.toolName} ${event.isError ? "error" : "ok"}`)
        this.refreshDiffPanel()
        break

      case "message_update": {
        const delta = event.assistantMessageEvent
        if (delta?.type === "text_delta") {
          this.appendAssistantStream(workspaceId, String(delta.delta ?? ""))
        } else if (delta?.type === "thinking_delta") {
          this.appendThinkingStream(workspaceId, String(delta.delta ?? ""))
        }
        break
      }

      case "message_end":
        this.flushThinkingPartial(workspaceId)
        this.flushAssistantPartial(workspaceId)
        this.appendWorkspaceLog(workspaceId, "[assistant-break]")
        break

      case "turn_end":
        this.agentTurnsInFlight.delete(workspaceId)
        this.flushThinkingPartial(workspaceId)
        this.flushAssistantPartial(workspaceId)
        break

      case "extension_ui_request": {
        const method = typeof event.method === "string" ? event.method : ""
        const requiresResponse = method === "select" || method === "confirm" || method === "input" || method === "editor"

        if (!requiresResponse) {
          break
        }

        const agent = this.agentByWorkspace.get(workspaceId)
        if (agent && typeof event.id === "string") {
          agent.respondExtensionUiCancel(event.id)
        }

        break
      }
    }

    const eventType = String(event.type ?? "")
    const shouldThrottle =
      eventType === "message_update" ||
      eventType === "turn_start" ||
      eventType === "agent_start" ||
      eventType === "tool_execution_start" ||
      eventType === "extension_ui_request"

    if (shouldThrottle) {
      this.scheduleUiFlush()
      return
    }

    this.refreshAllAndEmit()
  }

  private appendAssistantStream(workspaceId: number, delta: string) {
    const current = this.assistantPartialByWorkspace.get(workspaceId) ?? ""
    const consumed = consumeBufferedLines(current, delta, MAX_STREAM_REMAINDER_CHARS)

    for (const line of consumed.lines) {
      this.appendWorkspaceLog(workspaceId, line)
    }

    this.assistantPartialByWorkspace.set(workspaceId, consumed.remainder)
  }

  private appendThinkingStream(workspaceId: number, delta: string) {
    const current = this.thinkingPartialByWorkspace.get(workspaceId) ?? ""
    const combined = `${current}${delta}`
    const clipped = combined.slice(-640)
    this.thinkingPartialByWorkspace.set(workspaceId, clipped)
    this.lastThinkingPreviewByWorkspace.set(workspaceId, compactThinkingPreview(clipped))
  }

  private flushThinkingPartial(workspaceId: number, persist = true) {
    const partial = this.thinkingPartialByWorkspace.get(workspaceId) ?? ""

    if (persist) {
      const preview = compactThinkingPreview(partial)
      if (preview.length > 0) {
        this.lastThinkingPreviewByWorkspace.set(workspaceId, preview)
      }
    } else {
      this.lastThinkingPreviewByWorkspace.delete(workspaceId)
    }

    this.thinkingPartialByWorkspace.delete(workspaceId)
  }

  private flushAssistantPartial(workspaceId: number) {
    const partial = this.assistantPartialByWorkspace.get(workspaceId)
    if (partial && partial.trim().length > 0) {
      this.appendWorkspaceLog(workspaceId, partial)
    }
    this.assistantPartialByWorkspace.delete(workspaceId)
  }

  private async autoAddCurrentRepoIfPossible() {
    if (this.store.listRepos().length > 0) return

    try {
      const { repoRoot, repoName } = ensureRepoFromLocalPath(process.cwd())
      const repo = this.store.upsertRepo(repoName, repoRoot)
      this.selectedRepoId = repo.id
      this.appendGlobalLog(`Auto-added current repo: ${repoName}`)
    } catch {
      this.appendGlobalLog("No git repo detected in current directory. Add one with /repo add ...")
    }
  }

  private workspaceTreeValueForSelection(): string | null {
    if (this.selectedWorkspaceId) {
      const selectedWorkspace = this.store.getWorkspaceById(this.selectedWorkspaceId)
      if (selectedWorkspace) {
        return workspaceTreeValue(selectedWorkspace.repoId, selectedWorkspace.id)
      }
    }

    if (this.selectedRepoId) {
      return repoTreeValue(this.selectedRepoId)
    }

    return null
  }

  private getWorkspaceDiffTotals(worktreePath: string): { added: number; removed: number } {
    try {
      const stats = getChangedFileStats(worktreePath)
      let added = 0
      let removed = 0

      for (const entry of stats) {
        if (entry.added !== null) {
          added += entry.added
        }

        if (entry.removed !== null) {
          removed += entry.removed
        }
      }

      return { added, removed }
    } catch {
      return { added: 0, removed: 0 }
    }
  }

  private rebuildWorkspaceTreeOptions(preferredValue?: string | null) {
    const repoIds = new Set(this.repos.map((repo) => repo.id))
    for (const repoId of [...this.expandedRepoIds]) {
      if (!repoIds.has(repoId)) {
        this.expandedRepoIds.delete(repoId)
      }
    }

    if (this.selectedRepoId && repoIds.has(this.selectedRepoId)) {
      this.expandedRepoIds.add(this.selectedRepoId)
    }

    const treeOptions: SelectOption[] = []

    for (const repo of this.repos) {
      const repoWorkspaces = this.store.listWorkspaces(repo.id).sort((a, b) => a.id - b.id)
      const expanded = this.expandedRepoIds.has(repo.id)

      treeOptions.push({
        name: formatWorkspaceTreeRowName({
          isRepo: true,
          expanded,
          repoId: repo.id,
          repoName: repo.name,
        }),
        description: `${repoWorkspaces.length} workspace${repoWorkspaces.length === 1 ? "" : "s"} · ${repo.rootPath}`,
        value: repoTreeValue(repo.id),
      })

      if (!expanded) {
        continue
      }

      for (const workspace of repoWorkspaces) {
        const { added, removed } = this.getWorkspaceDiffTotals(workspace.worktreePath)
        const agent = this.store.getAgent(workspace.id)
        const activityAt =
          this.lastActivityByWorkspace.get(workspace.id) ?? agent?.lastEventAt ?? agent?.startedAt ?? agent?.stoppedAt ?? null

        treeOptions.push({
          name: formatWorkspaceTreeRowName({
            isRepo: false,
            repoId: repo.id,
            workspaceName: workspace.name,
            branch: workspace.branch,
            added,
            removed,
          }),
          description: encodeWorkspaceTreeRowMeta({
            added,
            removed,
            status: agent?.status ?? "stopped",
            busy: this.agentTurnsInFlight.has(workspace.id),
            activityAt,
          }),
          value: workspaceTreeValue(repo.id, workspace.id),
        })
      }
    }

    this.workspaceTreeOptions = treeOptions

    const selectedWorkspaceValue = this.workspaceTreeValueForSelection()
    const selectedRepoValue = this.selectedRepoId ? repoTreeValue(this.selectedRepoId) : null
    const targetValue = preferredValue ?? selectedWorkspaceValue ?? selectedRepoValue

    let selectedIndex = targetValue ? treeOptions.findIndex((option) => String(option.value) === targetValue) : -1

    if (selectedIndex === -1 && selectedRepoValue) {
      selectedIndex = treeOptions.findIndex((option) => String(option.value) === selectedRepoValue)
    }

    this.workspaceTreeSelectedIndex = Math.max(0, selectedIndex)
  }

  private parseWorkspaceTreeOption(option: SelectOption) {
    return parseWorkspaceTreeValue(option.value)
  }

  private listArchivedWorkspaces(): WorkspaceRecord[] {
    const repoIds = this.selectedRepoId ? [this.selectedRepoId] : this.repos.map((repo) => repo.id)
    return repoIds.flatMap((repoId) => this.store.listWorkspaces(repoId, true).filter((it) => it.status === "archived"))
  }

  private findArchivedWorkspace(needle: string): WorkspaceRecord | null {
    const archived = this.listArchivedWorkspaces()
    return (
      archived.find((it) => String(it.id) === needle) ||
      archived.find((it) => it.name.toLowerCase() === needle.toLowerCase()) ||
      null
    )
  }

  private reloadRepos(preferredRepoId?: number | null) {
    this.repos = this.store.listRepos().sort((a, b) => a.id - b.id)

    if (this.repos.length === 0) {
      this.selectedRepoId = null
      this.repoOptions = []
      this.repoSelectedIndex = 0
      this.workspaceTreeOptions = []
      this.workspaceTreeSelectedIndex = 0
      this.expandedRepoIds.clear()
      return
    }

    const keep = preferredRepoId ?? this.selectedRepoId
    const selected = keep ? this.repos.find((repo) => repo.id === keep) : null
    this.selectedRepoId = selected ? selected.id : this.repos[0].id

    this.repoOptions = this.repos.map((repo) => ({
      name: `${repo.id} · ${repo.name}`,
      description: repo.rootPath,
      value: repo.id,
    }))

    this.repoSelectedIndex = Math.max(
      0,
      this.repoOptions.findIndex((option) => Number(option.value) === this.selectedRepoId),
    )

    this.rebuildWorkspaceTreeOptions()
  }

  private reloadWorkspaces(preferredWorkspaceId?: number | null) {
    if (!this.selectedRepoId) {
      this.workspaces = []
      this.selectedWorkspaceId = null
      this.workspaceOptions = []
      this.workspaceSelectedIndex = 0
      this.rebuildWorkspaceTreeOptions()
      return
    }

    this.workspaces = this.store.listWorkspaces(this.selectedRepoId).sort((a, b) => a.id - b.id)

    if (this.workspaces.length === 0) {
      this.selectedWorkspaceId = null
      this.workspaceOptions = []
      this.workspaceSelectedIndex = 0
      this.rebuildWorkspaceTreeOptions()
      return
    }

    const keep = preferredWorkspaceId === undefined ? this.selectedWorkspaceId : preferredWorkspaceId
    const selected = keep ? this.workspaces.find((workspace) => workspace.id === keep) : null
    this.selectedWorkspaceId = selected ? selected.id : null

    this.workspaceOptions = this.workspaces.map((workspace) => {
      const agentState = this.store.getAgent(workspace.id)
      const status = agentState?.status ?? "stopped"
      let changed = 0
      try {
        changed = getChangedFiles(workspace.worktreePath).length
      } catch {
        changed = 0
      }

      return {
        name: `${workspace.id} · ${workspace.name}`,
        description: `${workspace.branch} · ${status} · ${changed} files changed`,
        value: workspace.id,
      }
    })

    const selectedIndex = this.workspaceOptions.findIndex((option) => Number(option.value) === this.selectedWorkspaceId)
    this.workspaceSelectedIndex = selectedIndex >= 0 ? selectedIndex : 0

    this.rebuildWorkspaceTreeOptions()
  }

  public selectWorkspaceTreeOption(option: SelectOption | null, toggleRepo = false) {
    if (!option) return

    const parsed = this.parseWorkspaceTreeOption(option)
    if (!parsed) {
      return
    }

    if (parsed.type === "repo") {
      const wasSelected = this.selectedRepoId === parsed.repoId
      const wasExpanded = this.expandedRepoIds.has(parsed.repoId)

      this.selectedRepoId = parsed.repoId
      if (toggleRepo && wasSelected && wasExpanded) {
        this.expandedRepoIds.delete(parsed.repoId)
      } else {
        this.expandedRepoIds.add(parsed.repoId)
      }

      this.reloadRepos(parsed.repoId)
      this.reloadWorkspaces()
      this.rebuildWorkspaceTreeOptions(repoTreeValue(parsed.repoId))
    } else {
      this.selectedRepoId = parsed.repoId
      this.expandedRepoIds.add(parsed.repoId)
      this.reloadRepos(parsed.repoId)
      this.reloadWorkspaces(parsed.workspaceId)
      this.selectedWorkspaceId = parsed.workspaceId
      this.workspaceSelectedIndex = Math.max(
        0,
        this.workspaceOptions.findIndex((it) => Number(it.value) === parsed.workspaceId),
      )
      this.rebuildWorkspaceTreeOptions(workspaceTreeValue(parsed.repoId, parsed.workspaceId))
    }

    this.refreshStatusPanel()
    this.refreshDiffPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  }

  public selectDiffRow(index: number, openReview: boolean) {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) return

    if (this.diffRows.length === 0) return
    const clamped = Math.max(0, Math.min(index, this.diffRows.length - 1))
    const row = this.diffRows[clamped]
    if (!row) return

    this.selectedDiffPathByWorkspace.set(workspace.id, row.path)
    this.selectedDiffHunkByWorkspace.set(workspace.id, 0)
    this.diffSelectedIndex = clamped

    if (openReview) {
      this.diffModalVisible = true
      this.markDiffReviewed(workspace.id)
      this.refreshStatusPanel()
      this.refreshDiffReviewPanel(true)
    }

    this.emitSnapshot()
  }

  public openCommandModal(title: string, markdown: string) {
    this.commandModalTitle = title
    this.commandModalMarkdown = markdown
    this.commandModalVisible = true
    this.emitSnapshot()
  }

  public closeCommandModal() {
    if (!this.commandModalVisible) return
    this.commandModalVisible = false
    this.commandModalTitle = ""
    this.commandModalMarkdown = ""
    this.emitSnapshot()
  }

  public openDiffReview() {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) return

    if (this.diffRows.length === 0) {
      this.diffModalVisible = true
      this.reviewedDiffFingerprintByWorkspace.delete(workspace.id)
      this.diffReviewTitle = "Review branch changes"
      this.diffReviewDiff = ""
      this.diffReviewFiletype = undefined
      this.diffReviewHunkCount = 0
      this.diffReviewHunkIndex = 0
      this.emitSnapshot()
      return
    }

    if (!this.selectedDiffPathByWorkspace.get(workspace.id)) {
      const first = this.diffRows[0]
      if (first) {
        this.selectedDiffPathByWorkspace.set(workspace.id, first.path)
      }
    }

    this.diffModalVisible = true
    this.markDiffReviewed(workspace.id)
    this.refreshStatusPanel()
    this.refreshDiffReviewPanel(true)
    this.emitSnapshot()
  }

  public closeDiffReview() {
    this.diffModalVisible = false
    this.emitSnapshot()
  }

  public cycleDiffFile(delta: number) {
    const workspace = this.getSelectedWorkspace()
    if (!workspace || this.diffRows.length === 0) return

    const current = this.diffRows.findIndex((row) => row.path === this.selectedDiffPathByWorkspace.get(workspace.id))
    const start = current >= 0 ? current : 0
    const next = (start + delta + this.diffRows.length) % this.diffRows.length
    this.selectDiffRow(next, this.diffModalVisible)
  }

  public cycleDiffHunk(delta: number) {
    const workspace = this.getSelectedWorkspace()
    if (!workspace || !this.diffModalVisible) return

    const current = this.selectedDiffHunkByWorkspace.get(workspace.id) ?? 0
    const max = Math.max(0, this.diffReviewHunkCount - 1)
    if (max === 0) {
      this.selectedDiffHunkByWorkspace.set(workspace.id, 0)
    } else {
      const next = (current + delta + this.diffReviewHunkCount) % this.diffReviewHunkCount
      this.selectedDiffHunkByWorkspace.set(workspace.id, Math.max(0, Math.min(next, max)))
    }

    this.refreshDiffReviewPanel(true)
    this.emitSnapshot()
  }

  public toggleDiffViewMode() {
    this.diffViewMode = this.diffViewMode === "unified" ? "split" : "unified"
    if (this.diffModalVisible) {
      this.refreshDiffReviewPanel(true)
    }
    this.emitSnapshot()
  }

  private markDiffReviewed(workspaceId: number) {
    const fingerprint = this.diffFingerprintByWorkspace.get(workspaceId)
    if (!fingerprint) {
      this.reviewedDiffFingerprintByWorkspace.delete(workspaceId)
      return
    }

    this.reviewedDiffFingerprintByWorkspace.set(workspaceId, fingerprint)
  }

  private getSelectedWorkspace(): WorkspaceRecord | null {
    if (!this.selectedWorkspaceId) return null

    const workspace = this.store.getWorkspaceById(this.selectedWorkspaceId)
    if (!workspace) {
      return null
    }

    if (this.selectedRepoId && workspace.repoId !== this.selectedRepoId) {
      return null
    }

    return workspace
  }

  private getSendModeForWorkspace(workspaceId: number | null): SendMode {
    return getWorkspaceSendMode(this.sendModeState, workspaceId)
  }

  private getActiveSendMode(): SendMode {
    return this.getSendModeForWorkspace(this.selectedWorkspaceId)
  }

  private setSendModeForCurrentSelection(mode: SendMode) {
    this.sendModeState = setWorkspaceSendMode(this.sendModeState, this.selectedWorkspaceId, mode)
  }

  private logAgentRegistry() {
    const agents = this.store.listAgents()
    if (agents.length === 0) {
      this.appendVisibleLog("No agent records yet.")
      return
    }

    this.appendVisibleLog("Agents:")
    for (const agent of agents) {
      const workspace = this.store.getWorkspaceById(agent.workspaceId)
      const repo = workspace ? this.store.getRepoById(workspace.repoId) : null
      const label = workspace ? `${repo?.name ?? "repo"}/${workspace.name}` : `workspace#${agent.workspaceId}`
      const lastEvent = agent.lastEventAt ?? "-"
      const started = agent.startedAt ?? "-"

      this.appendVisibleLog(
        `  #${agent.workspaceId} ${label} · ${agent.status}${agent.pid ? ` (pid ${agent.pid})` : ""} · session=${agent.sessionId ?? "-"} · started=${started} · last=${lastEvent}`,
      )
    }
  }

  private appendVisibleLog(message: string) {
    const workspace = this.getSelectedWorkspace()
    if (workspace) {
      this.appendWorkspaceLog(workspace.id, message)
      return
    }

    this.appendGlobalLog(message)
  }

  private scheduleUiFlush() {
    this.uiFlushScheduler.schedule()
  }

  private refreshAllAndEmit() {
    this.uiFlushScheduler.cancel()
    this.reloadWorkspaces(this.selectedWorkspaceId)
    this.refreshStatusPanel()
    this.refreshDiffPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  }

  private evaluateWorkspaceMergeChecklist(workspace: WorkspaceRecord) {
    let changedCount = 0
    try {
      changedCount = getChangedFiles(workspace.worktreePath).length
    } catch {
      changedCount = 0
    }

    const runCount = this.runProcessCount(workspace.id)
    const testState = this.lastTestRunByWorkspace.get(workspace.id) ?? null
    const diffFingerprint = this.diffFingerprintByWorkspace.get(workspace.id) ?? ""
    const reviewedDiffFingerprint = this.reviewedDiffFingerprintByWorkspace.get(workspace.id) ?? null
    const turnInFlight = this.agentTurnsInFlight.has(workspace.id)
    const manualItems = this.store.listMergeChecklistItems(workspace.id)

    const evaluation = evaluateMergeChecklist({
      runCount,
      changedCount,
      testState,
      diffFingerprint,
      reviewedDiffFingerprint,
      turnInFlight,
      manualItems,
    })

    return {
      evaluation,
      changedCount,
      runCount,
      testState,
      diffFingerprint,
      reviewedDiffFingerprint,
      turnInFlight,
    }
  }

  private openWorkspaceChecklistModal(workspace: WorkspaceRecord) {
    const { evaluation } = this.evaluateWorkspaceMergeChecklist(workspace)
    const markdown = toMergeChecklistMarkdown(workspace.name, evaluation)
    this.openCommandModal("Merge checklist", markdown)
  }

  private findManualChecklistItem(workspaceId: number, needle: string) {
    const records = this.store.listMergeChecklistItems(workspaceId)
    const items = records.map((item) => ({
      key: item.itemKey,
      label: item.label,
      required: item.required,
      completed: item.completed,
      source: "manual" as const,
    }))

    const match = findChecklistItemByNeedle(items, needle)
    return match ? records.find((entry) => entry.itemKey === match.key) ?? null : null
  }

  private appendGlobalLog(message: string) {
    this.appendLog(GLOBAL_LOG_STREAM_ID, message)
  }

  private appendWorkspaceLog(workspaceId: number, message: string) {
    this.lastActivityByWorkspace.set(workspaceId, new Date().toISOString())
    this.appendLog(workspaceId, message)
  }

  private appendRunLog(workspaceId: number, message: string) {
    const lines = this.runLogsByWorkspace.get(workspaceId) ?? []
    const split = message.split(/\r?\n/)

    for (const line of split) {
      lines.push(`[${timePrefix()}] ${line}`)
    }

    if (lines.length > this.config.maxLogLines) {
      lines.splice(0, lines.length - this.config.maxLogLines)
    }

    this.runLogsByWorkspace.set(workspaceId, lines)
  }

  private appendLog(streamId: number, message: string) {
    const lines = this.logsByStream.get(streamId) ?? []
    const split = message.split(/\r?\n/)

    for (const line of split) {
      lines.push(`[${timePrefix()}] ${line}`)
    }

    if (lines.length > this.config.maxLogLines) {
      lines.splice(0, lines.length - this.config.maxLogLines)
    }

    this.logsByStream.set(streamId, lines)
  }

  private refreshStatusPanel() {
    const repo = this.selectedRepoId ? this.store.getRepoById(this.selectedRepoId) : null
    const workspace = this.getSelectedWorkspace()
    const agent = workspace ? this.store.getAgent(workspace.id) : null

    const mergeState = workspace ? this.evaluateWorkspaceMergeChecklist(workspace) : null
    const changedCount = mergeState?.changedCount ?? 0
    const runCount = mergeState?.runCount ?? 0
    const runState = runCount > 0 ? `running (${runCount})` : "idle"
    const testState = mergeState?.testState ?? null
    const testStatus = formatTestRunStatus(testState)
    const diffFingerprint = mergeState?.diffFingerprint ?? ""
    const reviewedFingerprint = mergeState?.reviewedDiffFingerprint ?? null
    const readiness = evaluateWorkspaceReadiness({
      runCount,
      changedCount,
      testState,
      diffFingerprint,
      reviewedDiffFingerprint: reviewedFingerprint,
    })
    const readinessLabel = formatWorkspaceReadinessLabel(readiness)
    const mergeLabel = workspace && mergeState ? mergeChecklistSummaryLabel(mergeState.evaluation) : "blocked · no workspace"

    const agentStatus = agent?.status ?? "stopped"
    const turnInFlight = mergeState?.turnInFlight ?? false
    const shouldShowAgentSpinner = agentStatus === "starting" || turnInFlight
    const agentStatusLabel = turnInFlight ? "running" : agentStatus
    this.agentBusy = shouldShowAgentSpinner

    const activeSendMode = this.getActiveSendMode()

    this.headerText = workspace
      ? `${repo?.name ?? "repo"}/${workspace.name} · ${workspace.branch} · mode=${activeSendMode} · ${readinessLabel}`
      : `Piductor · select a repo/workspace · mode=${activeSendMode}`

    const activityTime = agent?.lastEventAt ?? agent?.startedAt ?? agent?.stoppedAt ?? "<none>"
    const statusLines = [
      `repo       ${repo ? `${repo.name} (#${repo.id})` : "<none>"}`,
      `workspace  ${workspace ? `${workspace.name} (#${workspace.id})` : "<none>"}`,
      `branch     ${workspace?.branch ?? "<none>"}`,
      `agent      ${agentStatusLabel}${agent?.pid ? ` (pid ${agent.pid})` : ""}`,
      `activity   ${activityTime}`,
      `run        ${runState} · mode=${this.runMode}`,
      `tests      ${testStatus}`,
      `readiness  ${readinessLabel}`,
      `merge      ${mergeLabel}`,
      `changes    ${changedCount} files`,
    ]

    this.statusText = statusLines.join("\n")
    this.conversationTabsText = workspace ? workspace.branch : "No workspace selected"
    this.footerText = `repos=${this.repos.length} workspaces=${this.workspaces.length} · data=${this.config.dataDir} · pi=${this.config.piCommand}`
  }

  private toConversationMarkdown(lines: string[]): string {
    return renderConversationMarkdown(lines)
  }

  private refreshLogsPanel() {
    const selectedWorkspace = this.getSelectedWorkspace()
    const streamId = selectedWorkspace?.id ?? GLOBAL_LOG_STREAM_ID
    const lines = this.logsByStream.get(streamId) ?? []
    this.conversationMarkdown = this.toConversationMarkdown(lines)
  }

  private refreshTerminalPanel() {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) {
      this.terminalText = "No workspace selected."
      return
    }

    const lines = this.runLogsByWorkspace.get(workspace.id) ?? []
    this.terminalText = lines.length > 0 ? lines.slice(-120).join("\n") : "No run output. Use /run <cmd> or configure scripts.run."
  }

  private refreshDiffReviewPanel(force = false) {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) {
      this.diffReviewTitle = "Review branch changes"
      this.diffReviewDiff = ""
      this.diffReviewFiletype = undefined
      this.diffReviewHunkCount = 0
      this.diffReviewHunkIndex = 0
      return
    }

    const selectedPath = this.selectedDiffPathByWorkspace.get(workspace.id)
    if (!selectedPath) {
      this.diffReviewTitle = "Review branch changes"
      this.diffReviewDiff = ""
      this.diffReviewFiletype = undefined
      this.diffReviewHunkCount = 0
      this.diffReviewHunkIndex = 0
      return
    }

    const selectedHunk = this.selectedDiffHunkByWorkspace.get(workspace.id) ?? 0
    const diffFingerprint = this.diffRows.map((row) => `${row.path}:${row.plus}:${row.minus}`).join("|")
    const refreshKey = `${workspace.id}|${selectedPath}|${this.diffViewMode}|${selectedHunk}|${diffFingerprint}`
    if (!force && refreshKey === this.lastDiffReviewRefreshKey) {
      return
    }

    this.lastDiffReviewRefreshKey = refreshKey

    try {
      const fullDiffText = getDiffForFile(workspace.worktreePath, selectedPath)
      const parsed = parseFileDiff(fullDiffText)
      const hunkCount = parsed.hunks.length

      this.diffReviewDiff = fullDiffText
      this.diffReviewFiletype = filetypeForPath(selectedPath)
      this.diffReviewHunkCount = hunkCount
      this.diffReviewHunkIndex = Math.max(0, Math.min(selectedHunk, Math.max(0, hunkCount - 1)))
      this.selectedDiffHunkByWorkspace.set(workspace.id, this.diffReviewHunkIndex)
      this.diffReviewTitle =
        hunkCount > 0
          ? `${selectedPath} · ${this.diffViewMode} · ${hunkCount} hunk${hunkCount === 1 ? "" : "s"}`
          : `${selectedPath} · ${this.diffViewMode}`
    } catch (error) {
      this.diffReviewTitle = `${selectedPath} · ${this.diffViewMode}`
      this.diffReviewDiff = `diff --git a/${selectedPath} b/${selectedPath}\n--- a/${selectedPath}\n+++ b/${selectedPath}\n@@ -0,0 +1 @@\n+Failed to load diff: ${safeErr(error)}`
      this.diffReviewFiletype = filetypeForPath(selectedPath)
      this.diffReviewHunkCount = 0
      this.diffReviewHunkIndex = 0
    }
  }

  private refreshDiffPanel() {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) {
      this.diffFileCount = 0
      this.diffSelectedIndex = 0
      this.diffRows = []
      this.diffText = "No workspace selected."
      this.lastDiffReviewRefreshKey = ""
      if (this.diffModalVisible) {
        this.refreshDiffReviewPanel(true)
      }
      return
    }

    try {
      const stats = getChangedFileStats(workspace.worktreePath)
      this.diffFileCount = stats.length

      if (stats.length === 0) {
        this.diffSelectedIndex = 0
        this.diffRows = []
        this.diffText = "Working tree clean."
        this.selectedDiffPathByWorkspace.delete(workspace.id)
        this.selectedDiffHunkByWorkspace.delete(workspace.id)
        this.diffFingerprintByWorkspace.set(workspace.id, "")
        this.reviewedDiffFingerprintByWorkspace.delete(workspace.id)
        this.lastDiffReviewRefreshKey = ""
        if (this.diffModalVisible) {
          this.refreshDiffReviewPanel(true)
        }
        return
      }

      this.diffFingerprintByWorkspace.set(workspace.id, diffFingerprintFromStats(stats))

      const visible = stats.slice(0, 120)
      this.diffRows = visible.map((entry) => ({
        plus: entry.added === null ? "+?" : `+${entry.added}`,
        minus: entry.removed === null ? "-?" : `-${entry.removed}`,
        path: entry.path,
      }))

      const selectedPath = this.selectedDiffPathByWorkspace.get(workspace.id)
      const hasSelectedPath = selectedPath ? this.diffRows.some((row) => row.path === selectedPath) : false
      if (!hasSelectedPath) {
        const firstPath = this.diffRows[0]?.path
        if (firstPath) {
          this.selectedDiffPathByWorkspace.set(workspace.id, firstPath)
          this.selectedDiffHunkByWorkspace.set(workspace.id, 0)
        }
      }

      const activePath = this.selectedDiffPathByWorkspace.get(workspace.id)
      this.diffSelectedIndex = Math.max(0, this.diffRows.findIndex((row) => row.path === activePath))
      this.diffText = stats.length > visible.length ? `... ${stats.length - visible.length} more files` : ""
      this.lastDiffReviewRefreshKey = ""

      if (this.diffModalVisible) {
        this.refreshDiffReviewPanel(true)
      }
    } catch (error) {
      this.diffFileCount = 0
      this.diffSelectedIndex = 0
      this.diffRows = []
      this.diffText = `Failed to read changes: ${safeErr(error)}`
      this.diffFingerprintByWorkspace.delete(workspace.id)
      this.reviewedDiffFingerprintByWorkspace.delete(workspace.id)
      this.lastDiffReviewRefreshKey = ""
      if (this.diffModalVisible) {
        this.refreshDiffReviewPanel(true)
      }
    }
  }

  async shutdown() {
    if (this.isShuttingDown) return
    this.isShuttingDown = true

    this.appendGlobalLog("Shutting down...")
    this.refreshLogsPanel()
    this.emitSnapshot()

    for (const workspaceId of [...this.runProcessesByWorkspace.keys()]) {
      await this.stopRunProcess(workspaceId, "app shutdown")
    }

    for (const [workspaceId] of this.agentByWorkspace.entries()) {
      await this.stopAgent(workspaceId, { force: false, reason: "app shutdown" })
    }

    this.uiFlushScheduler.cancel()
    this.store.close()
    this.root.unmount()
    this.renderer.destroy()
    process.exit(0)
  }
}

function PiConductorView({ app }: { app: PiConductorApp }) {
  const snapshot = useSyncExternalStore(app.subscribe, app.getSnapshot, app.getSnapshot)
  const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions()
  const composerRef = useRef<TextareaRenderable | null>(null)
  const createPathRef = useRef<TextareaRenderable | null>(null)
  const previousWorkspaceIdRef = useRef<number | null>(null)
  const previousWorkspaceSelectionModeRef = useRef<boolean | null>(null)
  const draftStateRef = useRef<DraftState>({ globalDraft: "", byWorkspace: new Map<number, string>() })
  const [focusTarget, setFocusTarget] = useState<FocusTarget>("workspace")
  const [leftColumnWidth, setLeftColumnWidth] = useState(36)
  const [rightColumnWidth, setRightColumnWidth] = useState(52)
  const [resizeState, setResizeState] = useState<ResizeState | null>(null)
  const [workspaceTreeCollapsed, setWorkspaceTreeCollapsed] = useState(false)
  const [statusSectionCollapsed, setStatusSectionCollapsed] = useState(false)
  const [changesSectionCollapsed, setChangesSectionCollapsed] = useState(false)
  const [terminalSectionCollapsed, setTerminalSectionCollapsed] = useState(false)
  const [createWorkspaceModalVisible, setCreateWorkspaceModalVisible] = useState(false)
  const [composerText, setComposerText] = useState("")
  const [commandSuggestionIndex, setCommandSuggestionIndex] = useState(0)
  const [loadingFrameIndex, setLoadingFrameIndex] = useState(0)

  const conversationSyntaxStyle = useMemo(
    () =>
      SyntaxStyle.fromStyles({
        keyword: { fg: parseColor("#93c5fd"), bold: true },
        string: { fg: parseColor("#a7f3d0") },
        comment: { fg: parseColor("#9ca3af"), italic: true },
        number: { fg: parseColor("#fca5a5") },
        function: { fg: parseColor("#c4b5fd") },
        type: { fg: parseColor("#f9a8d4") },
        operator: { fg: parseColor("#fcd34d") },
        variable: { fg: parseColor("#e5e7eb") },
        property: { fg: parseColor("#93c5fd") },
        "markup.heading": { fg: parseColor("#d1d5db"), bold: true },
        "markup.heading.1": { fg: parseColor("#f9fafb"), bold: true },
        "markup.heading.2": { fg: parseColor("#e5e7eb"), bold: true },
        "markup.bold": { fg: parseColor("#f9fafb"), bold: true },
        "markup.strong": { fg: parseColor("#f9fafb"), bold: true },
        "markup.italic": { fg: parseColor("#d1d5db"), italic: true },
        "markup.list": { fg: parseColor("#9ca3af") },
        "markup.quote": { fg: parseColor("#a1a1aa"), italic: true },
        "markup.raw": { fg: parseColor("#93c5fd"), bg: parseColor("#111827") },
        "markup.raw.block": { fg: parseColor("#93c5fd"), bg: parseColor("#111827") },
        "markup.raw.inline": { fg: parseColor("#93c5fd"), bg: parseColor("#111827") },
        "markup.link": { fg: parseColor("#60a5fa"), underline: true },
        "markup.link.label": { fg: parseColor("#93c5fd"), underline: true },
        "markup.link.url": { fg: parseColor("#60a5fa"), underline: true },
        default: { fg: parseColor("#e5e7eb") },
      }),
    [],
  )

  const workspaceSelectionMode = snapshot.selectedWorkspaceId === null
  const leftVisible = workspaceSelectionMode ? true : !snapshot.leftSidebarCollapsed
  const rightVisible = workspaceSelectionMode ? false : !snapshot.rightSidebarCollapsed

  const leftSectionHeaderWidth = Math.max(12, leftColumnWidth - 2)
  const workspaceTreeHeader = formatSectionHeader("Workspaces", workspaceTreeCollapsed, leftSectionHeaderWidth)

  const rightSectionHeaderWidth = Math.max(12, rightColumnWidth - 2)
  const statusSectionHeader = formatSectionHeader("Workspace Status", statusSectionCollapsed, rightSectionHeaderWidth)
  const changesSectionHeader = formatSectionHeader(
    `Changes (${snapshot.diffFileCount})`,
    changesSectionCollapsed,
    rightSectionHeaderWidth,
  )
  const terminalSectionHeader = formatSectionHeader("Run Terminal", terminalSectionCollapsed, rightSectionHeaderWidth)
  const lobbyAscii = [
    "██████╗ ██╗██████╗ ██╗   ██╗ ██████╗████████╗ ██████╗ ██████╗",
    "██╔══██╗██║██╔══██╗██║   ██║██╔════╝╚══██╔══╝██╔═══██╗██╔══██╗",
    "██████╔╝██║██║  ██║██║   ██║██║        ██║   ██║   ██║██████╔╝",
    "██╔═══╝ ██║██║  ██║██║   ██║██║        ██║   ██║   ██║██╔══██╗",
    "██║     ██║██████╔╝╚██████╔╝╚██████╗   ██║   ╚██████╔╝██║  ██║",
    "╚═╝     ╚═╝╚═════╝  ╚═════╝  ╚═════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝",
  ]

  const centerColumnWidth = Math.max(
    24,
    terminalWidth - (leftVisible ? leftColumnWidth + 1 : 0) - (rightVisible ? rightColumnWidth + 1 : 0),
  )
  const commandModalWidth = clamp(Math.floor(terminalWidth * 0.76), 64, Math.max(64, terminalWidth - 6))
  const commandModalHeight = clamp(Math.floor(terminalHeight * 0.72), 14, Math.max(14, terminalHeight - 4))
  const diffModalWidth = clamp(Math.floor(terminalWidth * 0.9), 72, Math.max(72, terminalWidth - 4))
  const diffModalHeight = clamp(Math.floor(terminalHeight * 0.85), 16, Math.max(16, terminalHeight - 3))
  const headerActions = "/help · /mode · /ui"
  const headerWidth = Math.max(12, centerColumnWidth - 2)
  const minGap = 3
  const maxTitleWidth = Math.max(4, headerWidth - headerActions.length - minGap)
  const centerTitle = snapshot.conversationTabsText
  const truncatedTitle =
    centerTitle.length > maxTitleWidth ? `${centerTitle.slice(0, Math.max(0, maxTitleWidth - 1))}…` : centerTitle
  const fillerLen = Math.max(1, headerWidth - truncatedTitle.length - headerActions.length - 2)
  const conversationHeaderText = `${truncatedTitle} ${"─".repeat(fillerLen)} ${headerActions}`
  const lobbySubtitle = "Select a workspace to continue"
  const lobbyAsciiWidth = lobbyAscii.reduce((max, line) => Math.max(max, line.length), 0)
  const lobbyContentWidth = Math.max(lobbyAsciiWidth, lobbySubtitle.length)
  const lobbyContentHeight = lobbyAscii.length + 2
  const lobbyHorizontalNudge = Math.floor((leftVisible ? leftColumnWidth + 1 : 0) / 2)

  const hasLoadingToken = snapshot.agentBusy
  useEffect(() => {
    if (!hasLoadingToken) {
      setLoadingFrameIndex(0)
      return
    }

    const timer = setInterval(() => {
      setLoadingFrameIndex((current) => current + 1)
    }, 90)

    return () => clearInterval(timer)
  }, [hasLoadingToken])

  const composerSpinner = hasLoadingToken ? renderLoadingTokens(LOADING_TOKEN, loadingFrameIndex) : ""
  const thinkingIndicatorText = snapshot.thinkingActive
    ? `${composerSpinner || "•"} Thinking${snapshot.thinkingPreview ? ` · ${snapshot.thinkingPreview}` : "…"}`
    : snapshot.thinkingPreview
      ? `Thinking · ${snapshot.thinkingPreview}`
      : ""
  const centerMarkdown = snapshot.conversationMarkdown
  const composerFirstLine = composerText.split(/\r?\n/, 1)[0] ?? ""
  const hasSlashCommandPrefix = composerFirstLine.trimStart().startsWith("/")
  const commandQuery = hasSlashCommandPrefix ? composerFirstLine.trimStart().slice(1) : ""
  const commandSuggestions = findCommandSuggestions(commandQuery)
  const commandAutocompleteVisible =
    focusTarget === "input" &&
    !workspaceSelectionMode &&
    !createWorkspaceModalVisible &&
    !snapshot.commandModalVisible &&
    hasSlashCommandPrefix
  const selectedCommandSuggestion = commandSuggestions[commandSuggestionIndex] ?? commandSuggestions[0] ?? null
  const commandSuggestionHeight = commandAutocompleteVisible ? Math.min(commandSuggestions.length, 6) + 1 : 0
  const commandSuggestionLineWidth = Math.max(32, centerColumnWidth - 12)

  const statusRows = snapshot.statusText
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\S+)\s+(.*)$/)
      if (!match) {
        return { label: "", value: line }
      }
      return {
        label: match[1] ?? "",
        value: match[2] ?? "",
      }
    })

  const workspaceTreeHasFocus = focusTarget === "workspace" || focusTarget === "repo"
  const changesPanelHasFocus = focusTarget === "changes"

  const selectWorkspaceTreeIndex = (index: number, toggleRepo: boolean) => {
    const option = snapshot.workspaceTreeOptions[index]
    if (!option) {
      return
    }

    app.selectWorkspaceTreeOption(option, toggleRepo)
    const parsed = parseWorkspaceTreeValue(option.value)
    setFocusTarget(parsed?.type === "workspace" ? "input" : "workspace")
  }

  useEffect(() => {
    const composer = composerRef.current
    if (!composer) {
      previousWorkspaceIdRef.current = snapshot.selectedWorkspaceId
      return
    }

    const previousWorkspaceId = previousWorkspaceIdRef.current
    const nextWorkspaceId = snapshot.selectedWorkspaceId
    if (previousWorkspaceId === nextWorkspaceId) {
      return
    }

    const transition = switchWorkspaceDraft(
      draftStateRef.current,
      previousWorkspaceId,
      nextWorkspaceId,
      composer.plainText ?? "",
    )

    draftStateRef.current = transition.state
    composer.setText(transition.nextDraft)
    setComposerText(transition.nextDraft)
    previousWorkspaceIdRef.current = nextWorkspaceId
  }, [snapshot.selectedWorkspaceId])

  useEffect(() => {
    const timer = setInterval(() => {
      const current = composerRef.current?.plainText ?? ""
      setComposerText((prev) => (prev === current ? prev : current))
    }, 80)

    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    setCommandSuggestionIndex(0)
  }, [commandQuery])

  useEffect(() => {
    if (!commandAutocompleteVisible) {
      setCommandSuggestionIndex(0)
      return
    }

    const maxIndex = Math.max(0, commandSuggestions.length - 1)
    setCommandSuggestionIndex((prev) => Math.max(0, Math.min(prev, maxIndex)))
  }, [commandAutocompleteVisible, commandSuggestions])

  const applyCommandSuggestion = (command: string) => {
    const next = `/${command} `
    composerRef.current?.setText(next)
    setComposerText(next)
    setFocusTarget("input")
  }

  useEffect(() => {
    if (workspaceSelectionMode) {
      return
    }

    if (snapshot.leftSidebarCollapsed && (focusTarget === "repo" || focusTarget === "workspace")) {
      setFocusTarget("input")
    }
  }, [workspaceSelectionMode, snapshot.leftSidebarCollapsed, focusTarget])

  useEffect(() => {
    if (workspaceSelectionMode) {
      return
    }

    if (workspaceTreeCollapsed && (focusTarget === "repo" || focusTarget === "workspace")) {
      setFocusTarget("input")
    }
  }, [workspaceSelectionMode, workspaceTreeCollapsed, focusTarget])

  useEffect(() => {
    const previousSelectionMode = previousWorkspaceSelectionModeRef.current
    previousWorkspaceSelectionModeRef.current = workspaceSelectionMode

    if (workspaceSelectionMode && previousSelectionMode === false) {
      setFocusTarget("workspace")
      return
    }

    if (snapshot.rightSidebarCollapsed && focusTarget === "changes") {
      setFocusTarget("input")
    }
  }, [workspaceSelectionMode, snapshot.rightSidebarCollapsed, focusTarget])

  useEffect(() => {
    if (workspaceSelectionMode) {
      setWorkspaceTreeCollapsed(false)
    }
  }, [workspaceSelectionMode])

  useEffect(() => {
    if (changesSectionCollapsed && focusTarget === "changes") {
      setFocusTarget("input")
    }
  }, [changesSectionCollapsed, focusTarget])

  useEffect(() => {
    if (resizeState?.edge === "left" && !leftVisible) {
      setResizeState(null)
    }
    if (resizeState?.edge === "right" && !rightVisible) {
      setResizeState(null)
    }
  }, [resizeState, leftVisible, rightVisible])

  useEffect(() => {
    if (leftVisible) {
      const layoutMax = maxLeftWidth(terminalWidth, rightVisible, rightColumnWidth)
      const maxAllowed = Math.min(MAX_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, layoutMax))
      setLeftColumnWidth((current) => clamp(current, MIN_LEFT_WIDTH, maxAllowed))
    }

    if (rightVisible) {
      const layoutMax = maxRightWidth(terminalWidth, leftVisible, leftColumnWidth)
      const maxAllowed = Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, layoutMax))
      setRightColumnWidth((current) => clamp(current, MIN_RIGHT_WIDTH, maxAllowed))
    }
  }, [terminalWidth, leftVisible, rightVisible, leftColumnWidth, rightColumnWidth])

  const startResize = (edge: ResizeEdge, x: number) => {
    setResizeState({
      edge,
      startX: x,
      startLeftWidth: leftColumnWidth,
      startRightWidth: rightColumnWidth,
    })
  }

  const dragResize = (edge: ResizeEdge, x: number) => {
    if (!resizeState || resizeState.edge !== edge) return

    const delta = x - resizeState.startX
    if (edge === "left") {
      const layoutMax = maxLeftWidth(terminalWidth, rightVisible, resizeState.startRightWidth)
      const maxAllowed = Math.min(MAX_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, layoutMax))
      const next = clamp(resizeState.startLeftWidth + delta, MIN_LEFT_WIDTH, maxAllowed)
      setLeftColumnWidth(next)
      return
    }

    const layoutMax = maxRightWidth(terminalWidth, leftVisible, resizeState.startLeftWidth)
    const maxAllowed = Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, layoutMax))
    const next = clamp(resizeState.startRightWidth - delta, MIN_RIGHT_WIDTH, maxAllowed)
    setRightColumnWidth(next)
  }

  const leftResizerActive = resizeState?.edge === "left"
  const rightResizerActive = resizeState?.edge === "right"

  useEffect(() => {
    if (!createWorkspaceModalVisible) {
      return
    }

    const input = createPathRef.current
    if (!input) {
      return
    }

    const existing = input.plainText?.trim() ?? ""
    if (existing.length === 0) {
      input.setText(process.cwd())
    }
  }, [createWorkspaceModalVisible])

  useEffect(() => {
    if (!workspaceSelectionMode && createWorkspaceModalVisible) {
      setCreateWorkspaceModalVisible(false)
    }
  }, [workspaceSelectionMode, createWorkspaceModalVisible])

  const submitCreateWorkspaceFromModal = async () => {
    const targetPath = createPathRef.current?.plainText ?? ""
    const created = await app.createWorkspaceFromPath(targetPath)
    if (!created) {
      return
    }

    setCreateWorkspaceModalVisible(false)
    createPathRef.current?.clear()
    setFocusTarget("input")
  }

  useKeyboard((key: KeyEvent) => {
    if (createWorkspaceModalVisible && key.name === "escape") {
      key.preventDefault()
      setCreateWorkspaceModalVisible(false)
      return
    }

    if (createWorkspaceModalVisible) {
      return
    }

    if (snapshot.commandModalVisible && key.name === "escape") {
      key.preventDefault()
      app.closeCommandModal()
      return
    }

    if (snapshot.commandModalVisible) {
      return
    }

    if (key.ctrl && (key.name === "1" || key.name === "2")) {
      key.preventDefault()
      if (snapshot.leftSidebarCollapsed) {
        app.toggleLeftSidebar()
      }
      setWorkspaceTreeCollapsed(false)
      setFocusTarget("workspace")
      return
    }

    if (commandAutocompleteVisible && focusTarget === "input") {
      if (key.name === "down") {
        key.preventDefault()
        setCommandSuggestionIndex((prev) => {
          if (commandSuggestions.length === 0) return 0
          return (prev + 1) % commandSuggestions.length
        })
        return
      }

      if (key.name === "up") {
        key.preventDefault()
        setCommandSuggestionIndex((prev) => {
          if (commandSuggestions.length === 0) return 0
          return (prev - 1 + commandSuggestions.length) % commandSuggestions.length
        })
        return
      }

      if (key.name === "tab") {
        if (selectedCommandSuggestion) {
          key.preventDefault()
          applyCommandSuggestion(selectedCommandSuggestion.command)
          return
        }
      }
    }

    if (!snapshot.leftSidebarCollapsed && !workspaceTreeCollapsed && workspaceTreeHasFocus) {
      if (key.name === "up") {
        if (snapshot.workspaceTreeOptions.length > 0) {
          key.preventDefault()
          const total = snapshot.workspaceTreeOptions.length
          const current = Math.max(0, snapshot.workspaceTreeSelectedIndex)
          const next = (current - 1 + total) % total
          selectWorkspaceTreeIndex(next, false)
        }
        return
      }

      if (key.name === "down") {
        if (snapshot.workspaceTreeOptions.length > 0) {
          key.preventDefault()
          const total = snapshot.workspaceTreeOptions.length
          const current = Math.max(0, snapshot.workspaceTreeSelectedIndex)
          const next = (current + 1) % total
          selectWorkspaceTreeIndex(next, false)
        }
        return
      }

      if (key.name === "return" || key.name === "linefeed") {
        if (snapshot.workspaceTreeOptions.length > 0) {
          key.preventDefault()
          selectWorkspaceTreeIndex(snapshot.workspaceTreeSelectedIndex, true)
        }
        return
      }
    }

    if (!snapshot.rightSidebarCollapsed && !changesSectionCollapsed && changesPanelHasFocus) {
      if (key.name === "up") {
        if (snapshot.diffRows.length > 0) {
          key.preventDefault()
          const total = snapshot.diffRows.length
          const current = Math.max(0, snapshot.diffSelectedIndex)
          const next = (current - 1 + total) % total
          app.selectDiffRow(next, false)
        }
        return
      }

      if (key.name === "down") {
        if (snapshot.diffRows.length > 0) {
          key.preventDefault()
          const total = snapshot.diffRows.length
          const current = Math.max(0, snapshot.diffSelectedIndex)
          const next = (current + 1) % total
          app.selectDiffRow(next, false)
        }
        return
      }

      if (key.name === "return" || key.name === "linefeed") {
        key.preventDefault()
        app.openDiffReview()
        return
      }
    }

    if (snapshot.diffModalVisible && key.name === "escape") {
      key.preventDefault()
      app.closeDiffReview()
      return
    }

    if (snapshot.diffModalVisible && focusTarget !== "input") {
      if (key.name === "m") {
        key.preventDefault()
        app.toggleDiffViewMode()
        return
      }

      if (key.name === "n") {
        key.preventDefault()
        app.cycleDiffFile(1)
        return
      }

      if (key.name === "p") {
        key.preventDefault()
        app.cycleDiffFile(-1)
        return
      }

      if (key.name === "q") {
        key.preventDefault()
        app.closeDiffReview()
        return
      }
    }

    if (key.ctrl && key.name === "3") {
      key.preventDefault()
      setFocusTarget("input")
      return
    }

    if (key.ctrl && key.name === "left") {
      key.preventDefault()
      app.toggleLeftSidebar()
      return
    }

    if (key.ctrl && key.name === "right") {
      key.preventDefault()
      app.toggleRightSidebar()
      return
    }

    if (key.name === "tab") {
      key.preventDefault()
      const tabTargets: FocusTarget[] = workspaceSelectionMode ? ["workspace"] : ["input"]

      if (!snapshot.leftSidebarCollapsed && !workspaceTreeCollapsed) {
        tabTargets.push("workspace")
      }

      if (!snapshot.rightSidebarCollapsed && !changesSectionCollapsed) {
        tabTargets.push("changes")
      }

      if (tabTargets.length === 1) {
        setFocusTarget(tabTargets[0] ?? "input")
        return
      }

      setFocusTarget((prev) => {
        const index = tabTargets.indexOf(prev)
        if (index === -1) {
          return tabTargets[0] ?? "input"
        }
        return tabTargets[(index + 1) % tabTargets.length] ?? "input"
      })
      return
    }

    if (key.name === "f5") {
      key.preventDefault()
      void app.refreshEverythingFromDisk()
      return
    }

    if (key.ctrl && key.name === "l") {
      key.preventDefault()
      app.clearCurrentLogs()
      return
    }

    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      void app.shutdown()
    }
  })

  return (
    <box
      id="pc-root"
      width="100%"
      height="100%"
      shouldFill
      style={{
        flexDirection: "column",
      }}
    >
      <box
        id="pc-body"
        shouldFill
        onMouseMove={(event) => {
          if (!resizeState) return
          event.preventDefault()
          dragResize(resizeState.edge, event.x)
        }}
        onMouseDrag={(event) => {
          if (!resizeState) return
          event.preventDefault()
          dragResize(resizeState.edge, event.x)
        }}
        onMouseUp={() => {
          if (resizeState) {
            setResizeState(null)
          }
        }}
        onMouseDragEnd={() => {
          if (resizeState) {
            setResizeState(null)
          }
        }}
        style={{
          flexDirection: "row",
          flexGrow: 1,
          flexShrink: 1,
        }}
      >
        {leftVisible && (
          <box
            id="pc-sidebar"
            width={leftColumnWidth}
            backgroundColor="#11151f"
            shouldFill
            style={{
              flexDirection: "column",
              paddingLeft: 1,
              paddingRight: 1,
            }}
          >
            <box
              id="pc-workspace-tree-section"
              style={{
                flexDirection: "column",
                flexGrow: workspaceTreeCollapsed ? 0 : 1,
                flexShrink: 0,
              }}
            >
              <box
                id="pc-workspace-tree-header"
                height={1}
                backgroundColor={workspaceTreeCollapsed ? "#1a2332" : "#182031"}
                onMouseDown={() => {
                  setWorkspaceTreeCollapsed((prev) => !prev)
                }}
                style={{
                  flexShrink: 0,
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                <text
                  id="pc-workspace-tree-header-text"
                  content={workspaceTreeHeader}
                  fg="#bfdbfe"
                  wrapMode="none"
                  selectable={false}
                />
              </box>

              {!workspaceTreeCollapsed && (
                <box
                  id="pc-workspace-tree-body"
                  shouldFill
                  style={{
                    marginTop: 1,
                    flexGrow: 1,
                  }}
                >
                  <scrollbox
                    id="pc-workspace-tree-scroll"
                    border={false}
                    scrollY
                    scrollX={false}
                    shouldFill
                    style={{
                      flexGrow: 1,
                    }}
                    rootOptions={{
                      backgroundColor: "transparent",
                    }}
                    wrapperOptions={{
                      backgroundColor: "transparent",
                    }}
                    viewportOptions={{
                      backgroundColor: "transparent",
                    }}
                    contentOptions={{
                      backgroundColor: "transparent",
                    }}
                  >
                    {snapshot.workspaceTreeOptions.map((option, index) => {
                      const selected = index === snapshot.workspaceTreeSelectedIndex
                      const value = String(option.value ?? "")
                      const isRepoRow = value.startsWith(TREE_REPO_PREFIX)
                      const meta = !isRepoRow ? parseWorkspaceTreeRowMeta(option.description) : null
                      const plusText = meta ? `+${meta.added}` : "+0"
                      const minusText = meta ? `-${meta.removed}` : "-0"
                      const statusText = meta ? formatWorkspaceRuntimeLabel(meta.status, meta.busy) : "stopped"
                      const statusColor = workspaceStatusColor(statusText)
                      const activityText = meta ? formatWorkspaceActivityAge(meta.activityAt) : "-"

                      return (
                        <box
                          key={value}
                          id={`pc-workspace-tree-row-${index}`}
                          height={isRepoRow ? 1 : 2}
                          backgroundColor={selected ? "#1f2937" : "transparent"}
                          onMouseDown={(event) => {
                            event.preventDefault()
                            setWorkspaceTreeCollapsed(false)
                            const parsed = parseWorkspaceTreeValue(option.value)
                            setFocusTarget(parsed?.type === "workspace" ? "input" : "workspace")
                            app.selectWorkspaceTreeOption(option, true)
                          }}
                          style={{
                            flexDirection: "column",
                            flexShrink: 0,
                            marginBottom: isRepoRow ? 0 : 1,
                          }}
                        >
                          {isRepoRow ? (
                            <text
                              id={`pc-workspace-tree-row-text-${index}`}
                              content={option.name}
                              fg={selected ? "#e2e8f0" : "#dbeafe"}
                              wrapMode="none"
                              style={{
                                flexGrow: 1,
                                flexShrink: 1,
                              }}
                            />
                          ) : (
                            <>
                              <box
                                id={`pc-workspace-tree-row-top-${index}`}
                                height={1}
                                style={{
                                  flexDirection: "row",
                                  alignItems: "center",
                                }}
                              >
                                <text
                                  id={`pc-workspace-tree-row-name-${index}`}
                                  content={option.name}
                                  fg={selected ? "#e2e8f0" : "#cbd5e1"}
                                  wrapMode="none"
                                  style={{
                                    flexGrow: 1,
                                    flexShrink: 1,
                                  }}
                                />
                                <text
                                  id={`pc-workspace-tree-row-activity-${index}`}
                                  content={activityText}
                                  fg="#94a3b8"
                                  wrapMode="none"
                                  selectable={false}
                                  style={{
                                    flexShrink: 0,
                                    marginLeft: 1,
                                  }}
                                />
                              </box>

                              <box
                                id={`pc-workspace-tree-row-bottom-${index}`}
                                height={1}
                                style={{
                                  flexDirection: "row",
                                  alignItems: "center",
                                }}
                              >
                                <text
                                  id={`pc-workspace-tree-row-status-${index}`}
                                  content={statusText}
                                  fg={statusColor}
                                  wrapMode="none"
                                  selectable={false}
                                  style={{
                                    flexGrow: 1,
                                    flexShrink: 1,
                                  }}
                                />
                                <text
                                  id={`pc-workspace-tree-row-plus-${index}`}
                                  content={plusText}
                                  fg="#86efac"
                                  wrapMode="none"
                                  selectable={false}
                                  style={{
                                    flexShrink: 0,
                                    marginRight: 1,
                                  }}
                                />
                                <text
                                  id={`pc-workspace-tree-row-minus-${index}`}
                                  content={minusText}
                                  fg="#fca5a5"
                                  wrapMode="none"
                                  selectable={false}
                                  style={{
                                    flexShrink: 0,
                                  }}
                                />
                              </box>
                            </>
                          )}
                        </box>
                      )
                    })}
                  </scrollbox>
                </box>
              )}
            </box>

            <box
              id="pc-workspace-footer"
              style={{
                flexDirection: "column",
                marginTop: 1,
                flexShrink: 0,
              }}
            >
              {workspaceSelectionMode && (
                <box
                  id="pc-create-workspace-btn"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    setCreateWorkspaceModalVisible(true)
                  }}
                  style={{
                    flexDirection: "row",
                    marginBottom: 1,
                  }}
                >
                  <text content="[+ Create workspace]" fg="#86efac" wrapMode="none" selectable={false} />
                </box>
              )}

              <text id="pc-workspace-version" content={`Piductor ${APP_VERSION}`} fg="#94a3b8" wrapMode="none" />
              <text
                id="pc-workspace-archive-tip"
                content="/workspace archived · /workspace restore <id|name>"
                fg="#64748b"
                wrapMode="none"
              />
            </box>
          </box>
        )}

        {leftVisible && (
          <box
            id="pc-left-resizer"
            width={1}
            shouldFill
            backgroundColor={leftResizerActive ? "#60a5fa" : "#273142"}
            onMouseDown={(event) => {
              event.preventDefault()
              startResize("left", event.x)
            }}
            onMouseDrag={(event) => {
              event.preventDefault()
              dragResize("left", event.x)
            }}
            onMouseDragEnd={() => {
              setResizeState(null)
            }}
            onMouseUp={() => {
              setResizeState(null)
            }}
          />
        )}

        <box
          id="pc-center"
          key={workspaceSelectionMode ? "pc-center-lobby" : "pc-center-active"}
          shouldFill
          backgroundColor="#100f13"
          style={{
            flexDirection: "column",
            flexGrow: 2,
            paddingLeft: workspaceSelectionMode ? 2 : 0,
            paddingRight: workspaceSelectionMode ? 2 : 0,
          }}
        >
          {workspaceSelectionMode ? (
            <box
              key="pc-lobby-center"
              id="pc-lobby-center"
              shouldFill
              style={{
                flexDirection: "column",
                flexGrow: 1,
                flexShrink: 1,
              }}
            >
              <box
                id="pc-lobby-center-content"
                position="absolute"
                left="50%"
                top="50%"
                width={lobbyContentWidth}
                height={lobbyContentHeight}
                marginLeft={-Math.floor(lobbyContentWidth / 2) - lobbyHorizontalNudge}
                marginTop={-Math.floor(lobbyContentHeight / 2)}
                style={{
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                {lobbyAscii.map((line, index) => (
                  <text
                    key={`pc-lobby-ascii-${index}`}
                    content={line}
                    fg={index < 2 ? "#93c5fd" : "#dbeafe"}
                    wrapMode="none"
                  />
                ))}
                <text content={lobbySubtitle} fg="#94a3b8" wrapMode="none" style={{ marginTop: 1 }} />
              </box>
            </box>
          ) : (
            <box
              key="pc-active-center"
              id="pc-active-center"
              shouldFill
              style={{
                flexDirection: "column",
              }}
            >
          <box
            id="pc-conversation-box"
            backgroundColor="#100f13"
            shouldFill
            style={{
              flexDirection: "column",
              flexGrow: 1,
              marginBottom: 1,
              paddingLeft: 1,
              paddingRight: 1,
            }}
          >
            <box
              id="pc-conversation-header"
              height={1}
              backgroundColor="#182031"
              style={{
                flexShrink: 0,
                flexDirection: "row",
                alignItems: "center",
                marginBottom: 1,
              }}
            >
              <text
                id="pc-conversation-tabs"
                content={conversationHeaderText}
                fg="#bfdbfe"
                wrapMode="none"
                selectable={false}
              />
            </box>

            <scrollbox
              id="pc-conversation-scroll"
              border={false}
              scrollY
              scrollX={false}
              stickyScroll
              stickyStart="bottom"
              shouldFill
              style={{
                flexGrow: 1,
              }}
              rootOptions={{
                backgroundColor: "transparent",
              }}
              wrapperOptions={{
                backgroundColor: "transparent",
              }}
              viewportOptions={{
                backgroundColor: "transparent",
              }}
              contentOptions={{
                backgroundColor: "transparent",
              }}
            >
              <markdown
                id="pc-conversation-markdown"
                content={centerMarkdown}
                syntaxStyle={conversationSyntaxStyle}
                conceal
                width="100%"
              />

              {(snapshot.thinkingActive || snapshot.thinkingPreview.length > 0) && (
                <text
                  id="pc-thinking-indicator"
                  content={thinkingIndicatorText}
                  fg={snapshot.thinkingActive ? "#93c5fd" : "#64748b"}
                  wrapMode="word"
                  style={{
                    marginTop: 1,
                    flexShrink: 0,
                  }}
                />
              )}
            </scrollbox>
          </box>

          <box
            id="pc-input-box"
            height={6 + commandSuggestionHeight}
            backgroundColor="#151922"
            shouldFill
            onMouseDown={() => {
              setFocusTarget("input")
            }}
            style={{
              flexShrink: 0,
              paddingLeft: 1,
              paddingRight: 1,
              paddingTop: 1,
            }}
          >
            {commandAutocompleteVisible && commandSuggestions.length > 0 && (
              <box
                id="pc-command-autocomplete"
                width="100%"
                height={commandSuggestionHeight}
                backgroundColor="#0b1220"
                border
                borderColor="#334155"
                style={{
                  flexDirection: "column",
                  flexShrink: 0,
                  marginBottom: 1,
                  paddingLeft: 1,
                  paddingRight: 1,
                }}
              >
                {commandSuggestions.slice(0, 6).map((entry, index) => {
                  const selected = index === commandSuggestionIndex
                  const line = formatCommandSuggestionLine(entry.command, entry.description, commandSuggestionLineWidth)
                  return (
                    <box
                      key={`pc-cmd-suggestion-${entry.command}`}
                      width="100%"
                      height={1}
                      backgroundColor={selected ? "#1e293b" : "transparent"}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        applyCommandSuggestion(entry.command)
                      }}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      <text content={line} fg={selected ? "#e2e8f0" : "#93c5fd"} wrapMode="none" />
                    </box>
                  )
                })}
              </box>
            )}

            <text
              id="pc-compose-hint"
              content={`${hasLoadingToken ? `${composerSpinner} ` : ""}Composer · /help · /mode prompt|steer|follow_up`}
              fg={hasLoadingToken ? "#93c5fd" : "#9ca3af"}
              style={{
                flexShrink: 0,
              }}
            />

            <textarea
              id="pc-input"
              ref={composerRef}
              focused={focusTarget === "input"}
              onMouseDown={() => {
                setFocusTarget("input")
              }}
              placeholder="Ask the selected Pi workspace to do something…"
              onSubmit={() => {
                const submitted = composerRef.current?.plainText ?? ""
                draftStateRef.current = clearDraftForWorkspace(draftStateRef.current, snapshot.selectedWorkspaceId)
                composerRef.current?.clear()
                setComposerText("")
                void app.submitInput(submitted)
              }}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "linefeed", action: "submit" },
                { name: "return", shift: true, action: "newline" },
                { name: "linefeed", shift: true, action: "newline" },
                { name: "j", ctrl: true, action: "newline" },
              ]}
              textColor="#f9fafb"
              focusedTextColor="#ffffff"
              placeholderColor="#6b7280"
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
              cursorColor="#f9fafb"
              wrapMode="word"
              height={3}
              width="100%"
            />
          </box>
            </box>
          )}
        </box>

        {rightVisible && (
          <box
            id="pc-right-resizer"
            width={1}
            shouldFill
            backgroundColor={rightResizerActive ? "#60a5fa" : "#273142"}
            onMouseDown={(event) => {
              event.preventDefault()
              startResize("right", event.x)
            }}
            onMouseDrag={(event) => {
              event.preventDefault()
              dragResize("right", event.x)
            }}
            onMouseDragEnd={() => {
              setResizeState(null)
            }}
            onMouseUp={() => {
              setResizeState(null)
            }}
          />
        )}

        {rightVisible && (
          <box
            id="pc-right"
            width={rightColumnWidth}
            backgroundColor="#111013"
            shouldFill
            style={{
              flexDirection: "column",
              paddingLeft: 1,
              paddingRight: 1,
            }}
          >
            <box
              id="pc-status-section"
              style={{
                flexDirection: "column",
                flexShrink: 0,
                marginBottom: 1,
              }}
            >
              <box
                id="pc-status-header"
                height={1}
                backgroundColor={statusSectionCollapsed ? "#1a2332" : "#182031"}
                onMouseDown={() => {
                  setStatusSectionCollapsed((prev) => !prev)
                }}
                style={{
                  flexShrink: 0,
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                <text
                  id="pc-status-header-text"
                  content={statusSectionHeader}
                  fg="#bfdbfe"
                  wrapMode="none"
                  selectable={false}
                />
              </box>

              {!statusSectionCollapsed && (
                <box
                  id="pc-status-rows"
                  style={{
                    flexDirection: "column",
                    marginTop: 1,
                  }}
                >
                  {statusRows.map((row, index) => (
                    <box
                      key={`${row.label}-${index}`}
                      id={`pc-status-row-${index}`}
                      height={1}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      <text
                        id={`pc-status-label-${index}`}
                        content={row.label ? `${row.label.padEnd(10)} ` : ""}
                        fg="#93c5fd"
                        wrapMode="none"
                        selectable={false}
                        style={{
                          flexShrink: 0,
                        }}
                      />
                      <text
                        id={`pc-status-value-${index}`}
                        content={row.value}
                        fg="#d1d5db"
                        wrapMode="none"
                        style={{
                          flexGrow: 1,
                          flexShrink: 1,
                        }}
                      />
                    </box>
                  ))}
                </box>
              )}
            </box>

            <box
              id="pc-diff-section"
              shouldFill={!changesSectionCollapsed}
              style={{
                flexDirection: "column",
                flexGrow: changesSectionCollapsed ? 0 : 1,
                flexShrink: changesSectionCollapsed ? 0 : 1,
                marginBottom: 1,
              }}
            >
              <box
                id="pc-diff-header"
                height={1}
                backgroundColor={changesSectionCollapsed ? "#1a2332" : "#182031"}
                onMouseDown={() => {
                  setChangesSectionCollapsed((prev) => !prev)
                }}
                style={{
                  flexShrink: 0,
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                <text
                  id="pc-diff-header-text"
                  content={changesSectionHeader}
                  fg="#bfdbfe"
                  wrapMode="none"
                  selectable={false}
                />
              </box>

              {!changesSectionCollapsed && (
                <box
                  id="pc-diff-body"
                  shouldFill
                  style={{
                    flexGrow: 1,
                    marginTop: 1,
                  }}
                >
                  {snapshot.diffRows.length === 0 ? (
                    <text
                      id="pc-diff-text"
                      content={snapshot.diffText}
                      fg="#d1d5db"
                      wrapMode="none"
                      style={{
                        flexGrow: 1,
                      }}
                    />
                  ) : (
                    <scrollbox
                      id="pc-diff-scroll"
                      border={false}
                      scrollY
                      scrollX={false}
                      shouldFill
                      style={{
                        flexGrow: 1,
                      }}
                      rootOptions={{
                        backgroundColor: "transparent",
                      }}
                      wrapperOptions={{
                        backgroundColor: "transparent",
                      }}
                      viewportOptions={{
                        backgroundColor: "transparent",
                      }}
                      contentOptions={{
                        backgroundColor: "transparent",
                      }}
                    >
                      {snapshot.diffRows.map((row, index) => {
                        const selected = index === snapshot.diffSelectedIndex
                        return (
                        <box
                          key={`${row.path}-${index}`}
                          id={`pc-diff-row-${index}`}
                          height={1}
                          backgroundColor={selected ? "#1f2937" : "transparent"}
                          onMouseDown={(event) => {
                            event.preventDefault()
                            setChangesSectionCollapsed(false)
                            setFocusTarget("changes")
                            app.selectDiffRow(index, true)
                          }}
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            flexShrink: 0,
                          }}
                        >
                          <text
                            id={`pc-diff-plus-${index}`}
                            content={row.plus}
                            fg="#86efac"
                            wrapMode="none"
                            selectable={false}
                            style={{
                              flexShrink: 0,
                              marginRight: 1,
                            }}
                          />
                          <text
                            id={`pc-diff-minus-${index}`}
                            content={row.minus}
                            fg="#fca5a5"
                            wrapMode="none"
                            selectable={false}
                            style={{
                              flexShrink: 0,
                              marginRight: 1,
                            }}
                          />
                          <text
                            id={`pc-diff-path-${index}`}
                            content={row.path}
                            fg={selected ? "#e2e8f0" : "#d1d5db"}
                            wrapMode="none"
                            style={{
                              flexGrow: 1,
                              flexShrink: 0,
                            }}
                          />
                        </box>
                        )
                      })}

                      {snapshot.diffText ? (
                        <text
                          id="pc-diff-extra"
                          content={snapshot.diffText}
                          fg="#94a3b8"
                          wrapMode="none"
                          style={{
                            marginTop: 1,
                            flexShrink: 0,
                          }}
                        />
                      ) : null}
                    </scrollbox>
                  )}
                </box>
              )}
            </box>

            <box
              id="pc-terminal-section"
              height={terminalSectionCollapsed ? 1 : 10}
              style={{
                flexDirection: "column",
                flexShrink: 0,
              }}
            >
              <box
                id="pc-terminal-header"
                height={1}
                backgroundColor={terminalSectionCollapsed ? "#1a2332" : "#182031"}
                onMouseDown={() => {
                  setTerminalSectionCollapsed((prev) => !prev)
                }}
                style={{
                  flexShrink: 0,
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                <text
                  id="pc-terminal-header-text"
                  content={terminalSectionHeader}
                  fg="#bfdbfe"
                  wrapMode="none"
                  selectable={false}
                />
              </box>

              {!terminalSectionCollapsed && (
                <text
                  id="pc-terminal-text"
                  content={snapshot.terminalText}
                  fg="#a7f3d0"
                  wrapMode="none"
                  style={{
                    flexGrow: 1,
                    marginTop: 1,
                  }}
                />
              )}
            </box>
          </box>
        )}
      </box>

      {createWorkspaceModalVisible && (
        <box
          id="pc-create-workspace-modal-backdrop"
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          backgroundColor="#090d15"
          onMouseDown={(event) => {
            event.preventDefault()
            setCreateWorkspaceModalVisible(false)
          }}
          style={{
            zIndex: 95,
          }}
        >
          <box
            id="pc-create-workspace-modal"
            position="absolute"
            left="50%"
            top="50%"
            width={72}
            height={11}
            marginLeft={-36}
            marginTop={-5}
            border
            borderStyle="double"
            borderColor="#60a5fa"
            backgroundColor="#0f172a"
            title="Create workspace"
            titleAlignment="center"
            onMouseDown={(event) => {
              event.preventDefault()
            }}
            style={{
              flexDirection: "column",
              paddingLeft: 1,
              paddingRight: 1,
              paddingTop: 1,
              paddingBottom: 1,
            }}
          >
            <text content="Local repo path" fg="#bfdbfe" wrapMode="none" selectable={false} />
            <textarea
              id="pc-create-workspace-path"
              ref={createPathRef}
              focused={createWorkspaceModalVisible}
              placeholder="~/Projects/my-repo"
              onSubmit={() => {
                void submitCreateWorkspaceFromModal()
              }}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "linefeed", action: "submit" },
              ]}
              textColor="#f9fafb"
              focusedTextColor="#ffffff"
              placeholderColor="#6b7280"
              backgroundColor="#111827"
              focusedBackgroundColor="#0b1220"
              cursorColor="#f9fafb"
              wrapMode="none"
              height={3}
              width="100%"
              style={{
                marginTop: 1,
                flexShrink: 0,
              }}
            />

            <box
              id="pc-create-workspace-modal-actions"
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginTop: 1,
                flexShrink: 0,
              }}
            >
              <box
                id="pc-create-workspace-modal-ok"
                onMouseDown={(event) => {
                  event.preventDefault()
                  void submitCreateWorkspaceFromModal()
                }}
              >
                <text content="[OK]" fg="#86efac" wrapMode="none" selectable={false} />
              </box>

              <text content=" " fg="#94a3b8" wrapMode="none" selectable={false} />

              <box
                id="pc-create-workspace-modal-cancel"
                onMouseDown={(event) => {
                  event.preventDefault()
                  setCreateWorkspaceModalVisible(false)
                }}
              >
                <text content="[Cancel]" fg="#fca5a5" wrapMode="none" selectable={false} />
              </box>

              <text
                content="  Enter local repo path · Esc to cancel"
                fg="#64748b"
                wrapMode="none"
                selectable={false}
              />
            </box>
          </box>
        </box>
      )}

      {snapshot.commandModalVisible && (
        <box
          id="pc-command-modal-backdrop"
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          backgroundColor="#090d15"
          onMouseDown={(event) => {
            event.preventDefault()
            app.closeCommandModal()
          }}
          style={{
            zIndex: 92,
          }}
        >
          <box
            id="pc-command-modal"
            position="absolute"
            left="50%"
            top="50%"
            width={commandModalWidth}
            height={commandModalHeight}
            marginLeft={-Math.floor(commandModalWidth / 2)}
            marginTop={-Math.floor(commandModalHeight / 2)}
            border
            borderStyle="double"
            borderColor="#60a5fa"
            backgroundColor="#0f172a"
            title={`${snapshot.commandModalTitle} · Commands`}
            titleAlignment="center"
            onMouseDown={(event) => {
              event.preventDefault()
            }}
            style={{
              flexDirection: "column",
              paddingLeft: 1,
              paddingRight: 1,
              paddingTop: 1,
              paddingBottom: 1,
            }}
          >
            <box
              id="pc-command-modal-header"
              height={1}
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              <text
                content="Search and run commands from the composer with `/...`"
                fg="#94a3b8"
                wrapMode="none"
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                }}
              />

              <box
                id="pc-command-modal-close"
                onMouseDown={(event) => {
                  event.preventDefault()
                  app.closeCommandModal()
                }}
              >
                <text content="[Close]" fg="#fca5a5" wrapMode="none" selectable={false} />
              </box>
            </box>

            <scrollbox
              id="pc-command-modal-scroll"
              border={false}
              scrollY
              scrollX={false}
              shouldFill
              style={{
                flexGrow: 1,
                marginTop: 1,
              }}
            >
              <markdown content={snapshot.commandModalMarkdown} syntaxStyle={conversationSyntaxStyle} conceal width="100%" />
            </scrollbox>

            <text
              content="Esc or [Close]"
              fg="#64748b"
              wrapMode="none"
              selectable={false}
              style={{
                marginTop: 1,
                flexShrink: 0,
              }}
            />
          </box>
        </box>
      )}

      {snapshot.diffModalVisible && (
        <box
          id="pc-diff-modal-backdrop"
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          backgroundColor="#090d15"
          onMouseDown={(event) => {
            event.preventDefault()
            app.closeDiffReview()
          }}
          style={{
            zIndex: 90,
          }}
        >
          <box
            id="pc-diff-modal"
            position="absolute"
            left="50%"
            top="50%"
            width={diffModalWidth}
            height={diffModalHeight}
            marginLeft={-Math.floor(diffModalWidth / 2)}
            marginTop={-Math.floor(diffModalHeight / 2)}
            border
            borderStyle="double"
            borderColor="#60a5fa"
            backgroundColor="#0f172a"
            title={`Review branch changes · ${snapshot.diffViewMode}`}
            titleAlignment="center"
            onMouseDown={(event) => {
              event.preventDefault()
            }}
            style={{
              flexDirection: "column",
              paddingLeft: 1,
              paddingRight: 1,
              paddingTop: 1,
              paddingBottom: 1,
            }}
          >
            <box
              id="pc-diff-modal-header"
              height={1}
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              <text
                id="pc-diff-modal-title"
                content={snapshot.diffReviewTitle}
                fg="#dbeafe"
                wrapMode="none"
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                }}
              />

              <box
                id="pc-diff-modal-mode-btn"
                onMouseDown={(event) => {
                  event.preventDefault()
                  app.toggleDiffViewMode()
                }}
              >
                <text content={`[Mode: ${snapshot.diffViewMode}]`} fg="#93c5fd" wrapMode="none" selectable={false} />
              </box>

              <text content=" " fg="#93c5fd" wrapMode="none" selectable={false} />

              <box
                id="pc-diff-modal-close-btn"
                onMouseDown={(event) => {
                  event.preventDefault()
                  app.closeDiffReview()
                }}
              >
                <text content="[Close]" fg="#fca5a5" wrapMode="none" selectable={false} />
              </box>
            </box>

            {snapshot.diffReviewDiff.trim().length > 0 ? (
              <diff
                id="pc-diff-modal-view"
                diff={snapshot.diffReviewDiff}
                view={snapshot.diffViewMode}
                filetype={snapshot.diffReviewFiletype}
                showLineNumbers
                wrapMode="none"
                lineNumberFg="#64748b"
                lineNumberBg="#0b1220"
                addedBg="#123320"
                removedBg="#3d1823"
                contextBg="#0b1220"
                addedSignColor="#86efac"
                removedSignColor="#fca5a5"
                addedLineNumberBg="#123320"
                removedLineNumberBg="#3d1823"
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                  marginTop: 1,
                  marginBottom: 1,
                }}
              />
            ) : (
              <text
                id="pc-diff-modal-empty"
                content="No changed files to review."
                fg="#cbd5e1"
                wrapMode="word"
                style={{
                  flexGrow: 1,
                  marginTop: 1,
                }}
              />
            )}

            <box
              id="pc-diff-modal-footer"
              height={1}
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              <box
                id="pc-diff-modal-prev-file"
                onMouseDown={(event) => {
                  event.preventDefault()
                  app.cycleDiffFile(-1)
                }}
              >
                <text content="[◀ File]" fg="#93c5fd" wrapMode="none" selectable={false} />
              </box>

              <text content=" " fg="#93c5fd" wrapMode="none" selectable={false} />

              <box
                id="pc-diff-modal-next-file"
                onMouseDown={(event) => {
                  event.preventDefault()
                  app.cycleDiffFile(1)
                }}
              >
                <text content="[File ▶]" fg="#93c5fd" wrapMode="none" selectable={false} />
              </box>

              <text
                content={`  ${snapshot.diffHunkCount} hunk${snapshot.diffHunkCount === 1 ? "" : "s"} in file`}
                fg="#94a3b8"
                wrapMode="none"
                selectable={false}
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                }}
              />

              <text content="Esc or [Close]" fg="#64748b" wrapMode="none" selectable={false} />
            </box>
          </box>
        </box>
      )}
    </box>
  )
}
