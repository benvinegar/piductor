import { existsSync, readFileSync } from "node:fs"
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
import type { AppConfig, RepoRecord, SendMode, WorkspaceRecord, WorkspaceRuntimeStateRecord } from "../core/types"
import {
  addWorktreeForBranch,
  cloneRepo,
  createWorktree,
  ensureRepoFromLocalPath,
  findWorktreeByBranch,
  findWorktreeByPath,
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
  workspaceTreeValue,
} from "../workspace/tree"
import { parseWorkspaceArchiveArgs, workspaceArchiveUsage } from "../workspace/archive"
import { parseWorkspaceNewArgs, suggestWorkspaceNameFromBranch, workspaceNewUsage } from "../workspace/new"
import {
  extractFirstUrl,
  parsePrCreateArgs,
  parsePrMergeArgs,
  parsePrViewJson,
  prCreateUsage,
  prMergeUsage,
  prUsage,
  summarizePrChecks,
  toPrStatusMarkdown,
  type ParsedPrMergeArgs,
  type PrViewRecord,
} from "../vcs/pr-command"
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
import {
  DEFAULT_THEME_KEY,
  getThemeByKey,
  listThemes,
  resolveThemeKey,
  type ThemeKey,
  type UiThemeDefinition,
} from "./themes"
import { compactThinkingPreview } from "./thinking-preview"
import { sanitizePiStderrLine, shouldSurfacePiStderr } from "../network/pi-stderr"
import { parseAgentCommand, resolveRestartModel } from "../agent/control"
import { planAgentReconnect } from "../agent/reconnect"
import { killProcessByPid } from "../agent/process-kill"
import { UiFlushScheduler } from "./flush-scheduler"
import { consumeBufferedLines } from "../run/stream-buffer"
import {
  DEFAULT_CONVERSATION,
  toConversationBlocks as renderConversationBlocks,
  toConversationMarkdown as renderConversationMarkdown,
  type ConversationBlock,
} from "./conversation-render"
import { summarizeToolCall, summarizeToolError } from "./agent-activity"
import { replaySessionMessagesToLogLines } from "./session-replay"
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

function workspaceStatusColor(status: string, theme: UiThemeDefinition): string {
  switch (status) {
    case "active":
      return theme.colors.statusActive
    case "busy":
      return theme.colors.statusBusy
    case "error":
      return theme.colors.statusError
    default:
      return theme.colors.statusIdle
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

type ModelOption = {
  key: string
  provider: string
  modelId: string
  name: string
  description: string
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
  themeKey: ThemeKey
  sendMode: SendMode
  planBuildMode: "plan" | "build"
  modelLabel: string
  leftSidebarCollapsed: boolean
  rightSidebarCollapsed: boolean
  agentBusy: boolean
  thinkingActive: boolean
  thinkingPreview: string
  headerText: string
  statusText: string
  conversationTabsText: string
  conversationBlocks: ConversationBlock[]
  conversationMarkdown: string
  commandModalVisible: boolean
  commandModalTitle: string
  commandModalMarkdown: string
  themeModalVisible: boolean
  themeModalSelectedIndex: number
  modelModalVisible: boolean
  modelModalSelectedIndex: number
  modelOptions: ModelOption[]
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

function toModelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`
}

function parseModelKey(value: string | null | undefined): { provider: string; modelId: string } | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null
  }

  const provider = trimmed.slice(0, slash).trim()
  const modelId = trimmed.slice(slash + 1).trim()
  if (!provider || !modelId) {
    return null
  }

  return { provider, modelId }
}

function toModelOption(raw: any): ModelOption | null {
  const provider = typeof raw?.provider === "string" ? raw.provider.trim() : ""
  const modelId = typeof raw?.id === "string" ? raw.id.trim() : ""
  if (!provider || !modelId) {
    return null
  }

  const nameRaw = typeof raw?.name === "string" ? raw.name.trim() : ""
  const name = nameRaw.length > 0 ? nameRaw : modelId
  const key = toModelKey(provider, modelId)
  const contextWindow = typeof raw?.contextWindow === "number" ? raw.contextWindow : null
  const description = contextWindow ? `${provider} · ${contextWindow.toLocaleString()} ctx` : provider

  return {
    key,
    provider,
    modelId,
    name,
    description,
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : ""
    return code === "EPERM"
  }
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
  private readonly runtimeStateByWorkspace = new Map<number, WorkspaceRuntimeStateRecord>()
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
  private conversationBlocks: ConversationBlock[] = []
  private conversationMarkdown = DEFAULT_CONVERSATION
  private commandModalVisible = false
  private commandModalTitle = ""
  private commandModalMarkdown = ""
  private themeModalVisible = false
  private themeModalSelectedIndex = 0
  private modelModalVisible = false
  private modelModalSelectedIndex = 0
  private modelOptions: ModelOption[] = []
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
  private readonly prViewByWorkspace = new Map<number, PrViewRecord>()
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
    themeKey: DEFAULT_THEME_KEY,
    sendMode: this.sendModeState.defaultMode,
    planBuildMode: "plan",
    modelLabel: "<model>",
    leftSidebarCollapsed: false,
    rightSidebarCollapsed: false,
    agentBusy: false,
    thinkingActive: false,
    thinkingPreview: "",
    headerText: this.headerText,
    statusText: this.statusText,
    conversationTabsText: this.conversationTabsText,
    conversationBlocks: [],
    conversationMarkdown: this.conversationMarkdown,
    commandModalVisible: this.commandModalVisible,
    commandModalTitle: this.commandModalTitle,
    commandModalMarkdown: this.commandModalMarkdown,
    themeModalVisible: this.themeModalVisible,
    themeModalSelectedIndex: this.themeModalSelectedIndex,
    modelModalVisible: this.modelModalVisible,
    modelModalSelectedIndex: this.modelModalSelectedIndex,
    modelOptions: [],
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
  private themeKey: ThemeKey = DEFAULT_THEME_KEY
  private lastPersistedRepoId: number | null = null
  private lastPersistedWorkspaceId: number | null = null
  private lastPersistedThemeKey: ThemeKey = DEFAULT_THEME_KEY
  private lastPersistedCollapsedRepoSignature = ""

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

    renderer.setBackgroundColor(getThemeByKey(DEFAULT_THEME_KEY).colors.appBackground)

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
    const activeSendMode = this.getActiveSendMode()

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
      themeKey: this.themeKey,
      sendMode: activeSendMode,
      planBuildMode: activeSendMode === "prompt" ? "plan" : "build",
      modelLabel: this.getSelectedModelLabel(),
      leftSidebarCollapsed: this.leftSidebarCollapsed,
      rightSidebarCollapsed: this.rightSidebarCollapsed,
      agentBusy: this.agentBusy,
      thinkingActive,
      thinkingPreview,
      headerText: this.headerText,
      statusText: this.statusText,
      conversationTabsText: this.conversationTabsText,
      conversationBlocks: this.conversationBlocks.map((block) => ({ ...block })),
      conversationMarkdown: this.conversationMarkdown,
      commandModalVisible: this.commandModalVisible,
      commandModalTitle: this.commandModalTitle,
      commandModalMarkdown: this.commandModalMarkdown,
      themeModalVisible: this.themeModalVisible,
      themeModalSelectedIndex: this.themeModalSelectedIndex,
      modelModalVisible: this.modelModalVisible,
      modelModalSelectedIndex: this.modelModalSelectedIndex,
      modelOptions: this.modelOptions.map((option) => ({ ...option })),
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

    this.persistAppStateIfChanged()

    for (const listener of this.listeners) {
      listener()
    }
  }

  private async bootstrap() {
    this.appendGlobalLog("Welcome to Piductor (terminal prototype).")
    this.appendGlobalLog("Type /help to see commands.")

    await this.autoAddCurrentRepoIfPossible()
    this.loadWorkspaceRuntimeState()
    this.hydrateLogsFromPersistedSessions()
    this.reloadRepos()
    this.reloadWorkspaces()
    this.restoreSelectionFromAppState()
    await this.reconcilePersistedAgents()
    this.refreshStatusPanel()
    this.refreshDiffPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  }

  private applyTheme() {
    const theme = getThemeByKey(this.themeKey)
    this.renderer.setBackgroundColor(theme.colors.appBackground)
  }

  private setTheme(themeKey: ThemeKey, options: { log?: boolean } = {}) {
    if (this.themeKey === themeKey) {
      if (options.log) {
        const current = getThemeByKey(themeKey)
        this.appendGlobalLog(`Theme unchanged: ${current.name} (${current.key})`)
      }
      return
    }

    this.themeKey = themeKey
    this.applyTheme()

    if (options.log !== false) {
      const current = getThemeByKey(themeKey)
      this.appendGlobalLog(`Theme set to ${current.name} (${current.key})`)
    }
  }

  private collapsedRepoSignature(ids: number[] | null): string {
    if (ids === null) {
      return "<default>"
    }

    return [...new Set(ids)]
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b)
      .join(",")
  }

  private getCollapsedRepoIdsForPersistence(): number[] {
    return this.repos
      .map((repo) => repo.id)
      .filter((repoId) => !this.expandedRepoIds.has(repoId))
      .sort((a, b) => a - b)
  }

  private applyExpandedRepoPreference(collapsedRepoIds: number[] | null) {
    const collapsed = collapsedRepoIds ? new Set(collapsedRepoIds) : null
    this.expandedRepoIds.clear()

    for (const repo of this.repos) {
      if (!collapsed || !collapsed.has(repo.id)) {
        this.expandedRepoIds.add(repo.id)
      }
    }
  }

  private persistAppStateIfChanged() {
    const collapsedRepoIds = this.getCollapsedRepoIdsForPersistence()
    const collapsedRepoSignature = this.collapsedRepoSignature(collapsedRepoIds)

    if (
      this.selectedRepoId === this.lastPersistedRepoId &&
      this.selectedWorkspaceId === this.lastPersistedWorkspaceId &&
      this.themeKey === this.lastPersistedThemeKey &&
      collapsedRepoSignature === this.lastPersistedCollapsedRepoSignature
    ) {
      return
    }

    this.store.setAppState({
      selectedRepoId: this.selectedRepoId,
      selectedWorkspaceId: this.selectedWorkspaceId,
      themeKey: this.themeKey,
      collapsedRepoIds,
    })

    this.lastPersistedRepoId = this.selectedRepoId
    this.lastPersistedWorkspaceId = this.selectedWorkspaceId
    this.lastPersistedThemeKey = this.themeKey
    this.lastPersistedCollapsedRepoSignature = collapsedRepoSignature
  }

  private restoreSelectionFromAppState() {
    const state = this.store.getAppState()
    if (!state) {
      this.applyTheme()
      this.applyExpandedRepoPreference(null)
      this.selectedWorkspaceId = null
      this.rebuildWorkspaceTreeOptions(this.workspaceTreeValueForSelection())
      return
    }

    const restoredThemeKey = resolveThemeKey(state.themeKey)
    if (restoredThemeKey) {
      this.themeKey = restoredThemeKey
    }
    this.applyTheme()

    this.lastPersistedRepoId = state.selectedRepoId
    this.lastPersistedWorkspaceId = null
    this.lastPersistedThemeKey = this.themeKey
    this.lastPersistedCollapsedRepoSignature = this.collapsedRepoSignature(state.collapsedRepoIds)

    this.applyExpandedRepoPreference(state.collapsedRepoIds)

    const hasPreferredRepo =
      state.selectedRepoId !== null && this.repos.some((repo) => repo.id === state.selectedRepoId)

    if (hasPreferredRepo) {
      this.selectedRepoId = state.selectedRepoId
      this.reloadRepos(state.selectedRepoId)
    }

    this.reloadWorkspaces(null)
    this.selectedWorkspaceId = null
    this.rebuildWorkspaceTreeOptions(this.workspaceTreeValueForSelection())
  }

  private hydrateLogsFromPersistedSessions() {
    for (const runtime of this.runtimeStateByWorkspace.values()) {
      if (!runtime.sessionFile || !existsSync(runtime.sessionFile)) {
        continue
      }

      try {
        const text = readFileSync(runtime.sessionFile, "utf8")
        const restored = replaySessionMessagesToLogLines(text, this.config.maxLogLines)
        if (restored.length > 0) {
          this.logsByStream.set(runtime.workspaceId, restored)
        }
      } catch {
        // Ignore session replay failures and continue startup.
      }
    }
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

  public toggleRepoExpanded(repoId: number) {
    if (this.expandedRepoIds.has(repoId)) {
      this.expandedRepoIds.delete(repoId)
    } else {
      this.expandedRepoIds.add(repoId)
    }

    this.rebuildWorkspaceTreeOptions(this.workspaceTreeValueForSelection())
    this.emitSnapshot()
  }

  public async createWorkspaceForRepo(repoId: number): Promise<boolean> {
    const repo = this.store.getRepoById(repoId)
    if (!repo) {
      this.appendGlobalLog(`Project not found: ${repoId}`)
      this.refreshAllAndEmit()
      return false
    }

    try {
      const baseRef = getDefaultBranchName(repo.rootPath)
      const workspaceName = this.nextWorkspaceName(repo.id, suggestWorkspaceNameFromBranch(baseRef))
      const created = createWorktree({
        repoRoot: repo.rootPath,
        workspacesDir: this.config.workspacesDir,
        workspaceName,
        baseRef,
      })

      const workspace = this.store.createWorkspace(repo.id, workspaceName, created.branch, created.worktreePath)
      this.expandedRepoIds.add(repo.id)
      this.appendWorkspaceLog(
        workspace.id,
        `Workspace created at ${workspace.worktreePath} on branch ${workspace.branch} (base ${baseRef})`,
      )

      if (this.config.scripts.setup) {
        void this.runConfiguredScript(workspace.id, "setup")
      }

      this.reloadRepos(this.selectedRepoId)
      this.reloadWorkspaces(this.selectedWorkspaceId)
      this.rebuildWorkspaceTreeOptions(this.workspaceTreeValueForSelection())
      this.refreshStatusPanel()
      this.refreshDiffPanel()
      this.refreshLogsPanel()
      this.refreshTerminalPanel()
      this.emitSnapshot()
      return true
    } catch (error) {
      this.appendGlobalLog(`Failed to create workspace for project ${repo.name}: ${safeErr(error)}`)
      this.refreshAllAndEmit()
      return false
    }
  }

  public async archiveWorkspaceById(workspaceId: number, forceArchive = false): Promise<boolean> {
    const workspace = this.store.getWorkspaceById(workspaceId)
    if (!workspace || workspace.status !== "active") {
      this.appendGlobalLog(`Workspace not found: ${workspaceId}`)
      this.refreshAllAndEmit()
      return false
    }

    const repo = this.store.getRepoById(workspace.repoId)
    if (!repo) {
      this.appendGlobalLog("Workspace repo missing.")
      this.refreshAllAndEmit()
      return false
    }

    let changedCount = 0
    try {
      changedCount = getChangedFiles(workspace.worktreePath).length
    } catch {
      changedCount = 0
    }

    if (changedCount > 0 && !forceArchive) {
      this.appendWorkspaceLog(
        workspace.id,
        `[workspace] archive blocked: ${changedCount} uncommitted change(s). Re-run with /workspace archive --force.`,
      )
      this.refreshAllAndEmit()
      return false
    }

    const runningCount = this.runProcessCount(workspace.id)
    if (runningCount > 0) {
      this.appendWorkspaceLog(workspace.id, `[workspace] stopping ${runningCount} run process(es) before archive.`)
      await this.stopRunProcess(workspace.id, "workspace archive")
    }

    await this.stopAgent(workspace.id, { force: forceArchive, reason: "archive" })

    if (this.config.scripts.archive) {
      await this.runConfiguredScript(workspace.id, "archive")
    }

    try {
      removeWorktree({ repoRoot: repo.rootPath, worktreePath: workspace.worktreePath, force: forceArchive })
    } catch (error) {
      this.appendWorkspaceLog(
        workspace.id,
        `[workspace] failed to archive worktree${forceArchive ? " (forced)" : ""}: ${safeErr(error)}`,
      )
      this.refreshAllAndEmit()
      return false
    }

    this.prViewByWorkspace.delete(workspace.id)
    this.store.clearMergeChecklistItems(workspace.id)
    this.store.setWorkspaceArchived(workspace.id, true)

    if (this.selectedWorkspaceId === workspace.id) {
      this.selectedWorkspaceId = null
    }

    this.appendGlobalLog(`Archived workspace: ${workspace.name}`)
    this.reloadWorkspaces(this.selectedWorkspaceId)
    this.rebuildWorkspaceTreeOptions(this.workspaceTreeValueForSelection())
    this.refreshStatusPanel()
    this.refreshDiffPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
    return true
  }

  public async createWorkspaceFromPath(inputPath: string): Promise<boolean> {
    const raw = inputPath.trim()
    if (!raw) {
      this.appendGlobalLog("Project path is required.")
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
      this.appendGlobalLog(`Invalid project path: ${resolved}`)
      this.appendGlobalLog(`ERROR: ${safeErr(error)}`)
      this.refreshAllAndEmit()
      return false
    }

    try {
      const repo = this.store.upsertRepo(repoName, repoRoot)
      this.selectedRepoId = repo.id
      this.expandedRepoIds.add(repo.id)
      this.reloadRepos(repo.id)

      let workspace = this.store.listWorkspaces(repo.id).sort((a, b) => a.id - b.id)[0] ?? null

      if (!workspace) {
        const baseRef = getDefaultBranchName(repo.rootPath)
        const workspaceName = this.nextWorkspaceName(repo.id, suggestWorkspaceNameFromBranch(baseRef))
        const created = createWorktree({
          repoRoot: repo.rootPath,
          workspacesDir: this.config.workspacesDir,
          workspaceName,
          baseRef,
        })

        workspace = this.store.createWorkspace(repo.id, workspaceName, created.branch, created.worktreePath)
        this.appendWorkspaceLog(
          workspace.id,
          `Workspace created at ${workspace.worktreePath} on branch ${workspace.branch} (base ${baseRef})`,
        )

        if (this.config.scripts.setup) {
          void this.runConfiguredScript(workspace.id, "setup")
        }
      }

      this.selectedWorkspaceId = null
      this.reloadWorkspaces(null)
      this.rebuildWorkspaceTreeOptions(repoTreeValue(repo.id))
      this.appendGlobalLog(`Opened project: ${repo.name} (${repo.rootPath})`)

      this.refreshAllAndEmit()
      return true
    } catch (error) {
      this.appendGlobalLog(`Failed to open project from path: ${resolved}`)
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
          this.expandedRepoIds.add(repo.id)
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

          const parsedArchive = parseWorkspaceArchiveArgs(args.slice(1))
          if (!parsedArchive) {
            this.appendGlobalLog(workspaceArchiveUsage())
            return
          }

          await this.archiveWorkspaceById(workspace.id, parsedArchive.force)
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

          const existingForBranch = findWorktreeByBranch(repo.rootPath, workspace.branch)
          if (existingForBranch && existingForBranch.path !== workspace.worktreePath) {
            this.appendGlobalLog(
              `Cannot restore: branch ${workspace.branch} is already checked out at ${existingForBranch.path}`,
            )
            return
          }

          const existingAtPath = findWorktreeByPath(repo.rootPath, workspace.worktreePath)
          if (existingAtPath) {
            if (existingAtPath.branch && existingAtPath.branch !== workspace.branch) {
              this.appendGlobalLog(
                `Cannot restore: ${workspace.worktreePath} is attached to branch ${existingAtPath.branch} (expected ${workspace.branch}).`,
              )
              return
            }

            this.store.setWorkspaceArchived(workspace.id, false)
            this.selectedRepoId = workspace.repoId
            this.selectedWorkspaceId = workspace.id
            this.reloadRepos(workspace.repoId)
            this.reloadWorkspaces(workspace.id)
            this.appendGlobalLog(`Restored workspace using existing worktree: ${workspace.name}`)
            return
          }

          if (existsSync(workspace.worktreePath)) {
            this.appendGlobalLog(`Cannot restore: path already exists (${workspace.worktreePath})`)
            return
          }

          try {
            addWorktreeForBranch({
              repoRoot: repo.rootPath,
              worktreePath: workspace.worktreePath,
              branch: workspace.branch,
            })
          } catch (error) {
            this.appendGlobalLog(`Failed to restore workspace ${workspace.name}: ${safeErr(error)}`)
            return
          }

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

        this.appendGlobalLog("Usage: /workspace new|branches|archive [--force]|archived|restore|select ...")
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
        const sub = (args[0] || "create").toLowerCase()

        const workspace = this.getSelectedWorkspace()
        if (!workspace) {
          this.appendGlobalLog("No workspace selected.")
          return
        }

        if (!["create", "status", "checks", "merge"].includes(sub)) {
          this.appendGlobalLog(prUsage())
          return
        }

        if (!this.ensureGithubAuth(workspace)) {
          return
        }

        if (sub === "create") {
          const parsed = parsePrCreateArgs(args.slice(1))
          if (!parsed) {
            this.appendGlobalLog(prCreateUsage())
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

          const createdPr = this.fetchWorkspacePrView(workspace, { logWhenMissing: false })
          if (createdPr) {
            this.openWorkspacePrModal(workspace, "Pull request", createdPr)
          }
          return
        }

        if (sub === "status" || sub === "checks") {
          const pr = this.fetchWorkspacePrView(workspace)
          if (!pr) {
            return
          }

          this.openWorkspacePrModal(workspace, sub === "status" ? "Pull request" : "PR checks", pr)
          const checks = summarizePrChecks(pr.checks)
          this.appendWorkspaceLog(
            workspace.id,
            `[pr] #${pr.number ?? "?"} ${pr.state ?? "<unknown>"}${pr.isDraft ? " (draft)" : ""} · checks ${checks.label}`,
          )
          return
        }

        const mergeArgs = parsePrMergeArgs(args.slice(1))
        if (!mergeArgs) {
          this.appendGlobalLog(prMergeUsage())
          return
        }

        await this.handlePrMerge(workspace, mergeArgs)
        return
      }

      case "theme": {
        if (args.length > 0) {
          this.appendGlobalLog("Usage: /theme")
          this.appendGlobalLog("Use the picker (↑/↓, Enter) to choose a theme.")
          return
        }

        this.openThemeModal()
        return
      }

      case "model": {
        if (args.length > 0) {
          this.appendGlobalLog("Usage: /model")
          this.appendGlobalLog("Use the picker (↑/↓, Enter) to choose a model.")
          return
        }

        await this.openModelModal()
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

  private ensureGithubAuth(workspace: WorkspaceRecord): boolean {
    const auth = this.runCommand("gh", ["auth", "status"], workspace.worktreePath)
    if (auth.status === 0) {
      return true
    }

    this.appendWorkspaceLog(workspace.id, "GitHub auth unavailable. Run `gh auth login` first.")
    if (auth.stderr) this.appendWorkspaceLog(workspace.id, auth.stderr)
    return false
  }

  private fetchWorkspacePrView(
    workspace: WorkspaceRecord,
    options: { logWhenMissing?: boolean } = {},
  ): PrViewRecord | null {
    const result = this.runCommand(
      "gh",
      [
        "pr",
        "view",
        workspace.branch,
        "--json",
        "number,url,title,state,isDraft,mergeStateStatus,reviewDecision,headRefName,baseRefName,statusCheckRollup",
      ],
      workspace.worktreePath,
    )

    if (result.status !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n")
      const missing = /no pull requests found/i.test(detail)

      if (missing) {
        this.prViewByWorkspace.delete(workspace.id)
        if (options.logWhenMissing !== false) {
          this.appendWorkspaceLog(workspace.id, `[pr] no pull request found for branch ${workspace.branch}.`)
        }
        return null
      }

      this.appendWorkspaceLog(workspace.id, `[pr] failed to query pull request:\n${detail || "unknown error"}`)
      return null
    }

    const parsed = parsePrViewJson(result.stdout)
    if (!parsed) {
      this.appendWorkspaceLog(workspace.id, "[pr] failed to parse `gh pr view` output.")
      return null
    }

    this.prViewByWorkspace.set(workspace.id, parsed)
    return parsed
  }

  private openWorkspacePrModal(workspace: WorkspaceRecord, title: string, view: PrViewRecord) {
    const markdown = toPrStatusMarkdown(workspace.name, view)
    this.openCommandModal(title, markdown)
  }

  private async handlePrMerge(workspace: WorkspaceRecord, mergeArgs: ParsedPrMergeArgs) {
    if (!mergeArgs.dryRun) {
      this.refreshDiffPanel()
      const mergeChecklist = this.evaluateWorkspaceMergeChecklist(workspace).evaluation
      if (mergeChecklist.blocked) {
        this.appendWorkspaceLog(
          workspace.id,
          `[pr] merge blocked by checklist (${mergeChecklist.pendingRequired.length} pending).`,
        )
        for (const item of mergeChecklist.pendingRequired) {
          this.appendWorkspaceLog(workspace.id, `  - [ ] ${item.label} (${item.key})`)
        }
        this.openWorkspaceChecklistModal(workspace)
        return
      }
    }

    const pr = this.fetchWorkspacePrView(workspace)
    if (!pr) {
      return
    }

    const mergeCommand = ["pr", "merge", "--yes", `--${mergeArgs.method}`]
    if (mergeArgs.deleteBranch) {
      mergeCommand.push("--delete-branch")
    }

    const target = pr.url ?? workspace.branch
    mergeCommand.push(target)

    if (mergeArgs.dryRun) {
      this.appendWorkspaceLog(workspace.id, `[pr] dry run: gh ${mergeCommand.join(" ")}`)
      return
    }

    this.appendWorkspaceLog(workspace.id, `[pr] merging #${pr.number ?? "?"} via ${mergeArgs.method} ...`)
    const merged = this.runCommand("gh", mergeCommand, workspace.worktreePath)
    const output = [merged.stdout, merged.stderr].filter(Boolean).join("\n")

    if (merged.status !== 0) {
      this.appendWorkspaceLog(workspace.id, `[pr] merge failed:\n${output || "unknown error"}`)
      return
    }

    this.appendWorkspaceLog(workspace.id, `[pr] merged #${pr.number ?? "?"}.`)
    if (output) {
      this.appendWorkspaceLog(workspace.id, output)
    }

    const refreshed = this.fetchWorkspacePrView(workspace, { logWhenMissing: false })
    if (refreshed) {
      this.openWorkspacePrModal(workspace, "Pull request", refreshed)
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
    const runtime = this.getWorkspaceRuntimeState(workspace.id)
    this.setWorkspaceRuntimeState(workspace.id, {
      sendMode,
      userMessages: runtime.userMessages + 1,
    })

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

    const persisted = this.store.getAgent(workspaceId)
    if (persisted?.pid && isPidAlive(persisted.pid)) {
      this.appendWorkspaceLog(
        workspaceId,
        `Agent pid ${persisted.pid} is already running but unmanaged. Use /agent kill before /agent start.`,
      )
      this.store.setAgentState({
        workspaceId,
        status: "error",
        pid: persisted.pid,
        model: persisted.model,
        sessionId: persisted.sessionId,
        lastError: "stale agent process detected",
      })
      this.refreshStatusPanel()
      this.emitSnapshot()
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

      const runtime = this.getWorkspaceRuntimeState(workspaceId)
      const resumeSessionFile = runtime.sessionFile
      if (resumeSessionFile && existsSync(resumeSessionFile)) {
        try {
          await agent.switchSession(resumeSessionFile)
          this.appendWorkspaceLog(workspaceId, `[agent] resumed session from ${resumeSessionFile}`)
        } catch (error) {
          this.appendWorkspaceLog(workspaceId, `[agent] failed to resume session: ${safeErr(error)}`)
        }
      }

      await agent.setSessionName(workspace.name)

      const state = await agent.getState()
      const sessionFile =
        typeof state?.sessionFile === "string" && state.sessionFile.trim().length > 0 ? state.sessionFile.trim() : null

      this.store.setAgentState({
        workspaceId,
        status: "running",
        pid: agent.pid,
        model: model ?? null,
        sessionId: state?.sessionId ?? null,
      })

      this.setWorkspaceRuntimeState(workspaceId, {
        sessionFile,
      })

      this.appendWorkspaceLog(workspaceId, `[agent] started (pid=${agent.pid ?? "?"}).`)
      void this.refreshWorkspaceSessionStats(workspaceId)
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

      case "tool_execution_start": {
        const summary = summarizeToolCall(event.toolName, event.args)
        this.appendWorkspaceLog(workspaceId, `[tool] ${summary}`)
        break
      }

      case "tool_execution_end": {
        if (event.isError) {
          const failure = summarizeToolError(event.toolName, event.result)
          this.appendWorkspaceLog(workspaceId, `[tool:error] ${failure}`)
        }

        const runtime = this.getWorkspaceRuntimeState(workspaceId)
        this.setWorkspaceRuntimeState(workspaceId, {
          toolCallCount: runtime.toolCallCount + 1,
        })
        this.refreshDiffPanel()
        break
      }

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

      case "turn_end": {
        this.agentTurnsInFlight.delete(workspaceId)
        this.flushThinkingPartial(workspaceId)
        this.flushAssistantPartial(workspaceId)

        const runtime = this.getWorkspaceRuntimeState(workspaceId)
        this.setWorkspaceRuntimeState(workspaceId, {
          turnCount: runtime.turnCount + 1,
          assistantMessages: runtime.assistantMessages + 1,
          lastTurnAt: new Date().toISOString(),
        })

        void this.refreshWorkspaceSessionStats(workspaceId)
        break
      }

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

  private async refreshWorkspaceSessionStats(workspaceId: number) {
    const agent = this.agentByWorkspace.get(workspaceId)
    if (!agent) {
      return
    }

    try {
      const stats = await agent.getSessionStats()
      const runtime = this.getWorkspaceRuntimeState(workspaceId)

      const userMessages =
        typeof stats?.userMessages === "number" && Number.isFinite(stats.userMessages)
          ? stats.userMessages
          : runtime.userMessages
      const assistantMessages =
        typeof stats?.assistantMessages === "number" && Number.isFinite(stats.assistantMessages)
          ? stats.assistantMessages
          : runtime.assistantMessages
      const sessionToolCalls =
        typeof stats?.toolCalls === "number" && Number.isFinite(stats.toolCalls)
          ? stats.toolCalls
          : runtime.sessionToolCalls

      const tokensTotalRaw = Number(stats?.tokens?.total)
      const costTotalRaw = Number(stats?.cost)
      const sessionFile = typeof stats?.sessionFile === "string" && stats.sessionFile.trim().length > 0 ? stats.sessionFile.trim() : runtime.sessionFile

      this.setWorkspaceRuntimeState(workspaceId, {
        userMessages,
        assistantMessages,
        sessionToolCalls,
        sessionFile,
        tokensTotal: Number.isFinite(tokensTotalRaw) ? tokensTotalRaw : runtime.tokensTotal,
        costTotal: Number.isFinite(costTotalRaw) ? costTotalRaw : runtime.costTotal,
      })
    } catch {
      // Ignore stats polling failures; core agent flow should continue.
    }
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
    const consumed = consumeBufferedLines(current, delta, MAX_STREAM_REMAINDER_CHARS)

    let previewSource = consumed.remainder

    for (const line of consumed.lines) {
      if (line.trim().length > 0) {
        previewSource = line
      }
    }

    this.thinkingPartialByWorkspace.set(workspaceId, consumed.remainder)

    const preview = compactThinkingPreview(previewSource)
    if (preview.length > 0) {
      this.lastThinkingPreviewByWorkspace.set(workspaceId, preview)
    }
  }

  private flushThinkingPartial(workspaceId: number, persist = true) {
    const partial = this.thinkingPartialByWorkspace.get(workspaceId) ?? ""

    if (persist && partial.trim().length > 0) {
      const preview = compactThinkingPreview(partial)
      if (preview.length > 0) {
        this.lastThinkingPreviewByWorkspace.set(workspaceId, preview)
      }
    }

    if (!persist) {
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

  private async reconcilePersistedAgents() {
    const persistedAgents = this.store.listAgents()
    if (persistedAgents.length === 0) {
      return
    }

    for (const persisted of persistedAgents) {
      const workspace = this.store.getWorkspaceById(persisted.workspaceId)
      const workspaceStatus = workspace?.status ?? null
      const pidAlive = typeof persisted.pid === "number" ? isPidAlive(persisted.pid) : false
      const action = planAgentReconnect({
        workspaceStatus,
        agent: persisted,
        pidAlive,
      })

      if (action.type === "skip") {
        continue
      }

      if (action.type === "mark_stopped") {
        this.store.setAgentState({
          workspaceId: persisted.workspaceId,
          status: "stopped",
          pid: null,
          model: persisted.model,
          sessionId: persisted.sessionId,
          lastError: action.reason,
        })
        if (workspace) {
          this.appendWorkspaceLog(workspace.id, `[agent] reconnect: ${action.reason}`)
        }
        continue
      }

      if (action.type === "mark_orphaned") {
        this.store.setAgentState({
          workspaceId: persisted.workspaceId,
          status: "error",
          pid: persisted.pid,
          model: persisted.model,
          sessionId: persisted.sessionId,
          lastError: action.reason,
        })
        if (workspace) {
          this.appendWorkspaceLog(workspace.id, `[agent] reconnect: ${action.reason}`)
        }
        continue
      }

      if (!workspace) {
        continue
      }

      this.appendWorkspaceLog(workspace.id, `[agent] reconnect: ${action.reason}`)
      await this.startAgent(workspace.id, persisted.model ?? this.config.defaultModel)
      this.appendWorkspaceLog(workspace.id, "[agent] reconnect: session restored")
    }
  }

  private async autoAddCurrentRepoIfPossible() {
    if (this.store.listRepos().length > 0) return

    try {
      const { repoRoot, repoName } = ensureRepoFromLocalPath(process.cwd())
      const repo = this.store.upsertRepo(repoName, repoRoot)
      this.selectedRepoId = repo.id
      this.appendGlobalLog(`Auto-added current repo: ${repoName}`)
    } catch {
      this.appendGlobalLog("No git repo detected in current directory. Open one from the lobby or use /repo add ...")
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

  public openThemeModal() {
    const themes = listThemes()
    const selected = themes.findIndex((theme) => theme.key === this.themeKey)
    this.themeModalSelectedIndex = selected >= 0 ? selected : 0
    this.themeModalVisible = true
    this.emitSnapshot()
  }

  public closeThemeModal() {
    if (!this.themeModalVisible) return
    this.themeModalVisible = false
    this.emitSnapshot()
  }

  public moveThemeModalSelection(delta: number) {
    if (!this.themeModalVisible) return
    const themes = listThemes()
    if (themes.length === 0) return

    const total = themes.length
    const current = Math.max(0, Math.min(this.themeModalSelectedIndex, total - 1))
    this.themeModalSelectedIndex = (current + delta + total) % total
    this.emitSnapshot()
  }

  public applyThemeModalSelection() {
    if (!this.themeModalVisible) return
    const themes = listThemes()
    const selected = themes[this.themeModalSelectedIndex]
    if (!selected) return

    this.setTheme(selected.key)
    this.themeModalVisible = false
    this.emitSnapshot()
  }

  public setThemeModalSelection(index: number, applyImmediately = false) {
    const themes = listThemes()
    if (themes.length === 0) return

    const clamped = Math.max(0, Math.min(index, themes.length - 1))
    this.themeModalSelectedIndex = clamped

    if (applyImmediately) {
      const selected = themes[clamped]
      if (selected) {
        this.setTheme(selected.key)
      }
      this.themeModalVisible = false
    }

    this.emitSnapshot()
  }

  private async resolveModelOptionsForWorkspace(workspace: WorkspaceRecord): Promise<ModelOption[]> {
    const deduped = new Map<string, ModelOption>()

    const add = (option: ModelOption | null) => {
      if (!option) return
      if (!deduped.has(option.key)) {
        deduped.set(option.key, option)
      }
    }

    const current = this.store.getAgent(workspace.id)
    const currentModel = current?.model ?? this.config.defaultModel ?? null

    const loadFromAgent = async (agent: PiRpcProcess) => {
      const modelsRaw = await agent.getAvailableModels()
      for (const raw of modelsRaw) {
        add(toModelOption(raw))
      }

      try {
        const state = await agent.getState()
        add(toModelOption(state?.model))
      } catch {
        // Ignore state fetch failure; model list is already populated.
      }
    }

    const runningAgent = this.agentByWorkspace.get(workspace.id)
    if (runningAgent) {
      try {
        await loadFromAgent(runningAgent)
      } catch {
        // Ignore model catalog fetch failures and fall back to known model labels.
      }
    } else {
      const probe = new PiRpcProcess({
        piCommand: this.config.piCommand,
        cwd: workspace.worktreePath,
        model: currentModel ?? undefined,
      })

      try {
        await probe.start()
        await loadFromAgent(probe)
      } catch {
        // Ignore probe failures and fall back to known model labels.
      } finally {
        try {
          await probe.stop()
        } catch {
          await probe.kill().catch(() => undefined)
        }
      }
    }

    const parsedCurrent = parseModelKey(currentModel)
    if (parsedCurrent) {
      add({
        key: toModelKey(parsedCurrent.provider, parsedCurrent.modelId),
        provider: parsedCurrent.provider,
        modelId: parsedCurrent.modelId,
        name: parsedCurrent.modelId,
        description: `${parsedCurrent.provider} · preferred`,
      })
    }

    return [...deduped.values()]
  }

  private async applyModelOptionSelection(option: ModelOption): Promise<void> {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) {
      this.appendGlobalLog("No workspace selected.")
      return
    }

    const modelKey = toModelKey(option.provider, option.modelId)
    const runningAgent = this.agentByWorkspace.get(workspace.id)
    const current = this.store.getAgent(workspace.id)

    if (!runningAgent) {
      this.store.setAgentState({
        workspaceId: workspace.id,
        status: current?.status ?? "stopped",
        pid: null,
        model: modelKey,
        sessionId: current?.sessionId ?? null,
        lastError: current?.lastError ?? null,
      })
      this.appendWorkspaceLog(workspace.id, `[model] set preferred model to ${modelKey} (applies on next /agent start)`)
      return
    }

    try {
      const next = await runningAgent.setModel(option.provider, option.modelId)
      const nextProvider = typeof next?.provider === "string" && next.provider.trim().length > 0 ? next.provider.trim() : option.provider
      const nextModelId = typeof next?.id === "string" && next.id.trim().length > 0 ? next.id.trim() : option.modelId
      const resolved = toModelKey(nextProvider, nextModelId)

      this.store.setAgentState({
        workspaceId: workspace.id,
        status: current?.status ?? "running",
        pid: runningAgent.pid ?? current?.pid ?? null,
        model: resolved,
        sessionId: current?.sessionId ?? null,
        lastError: null,
      })
      this.appendWorkspaceLog(workspace.id, `[model] switched to ${resolved}`)
    } catch (error) {
      this.appendWorkspaceLog(workspace.id, `[model] failed to switch model: ${safeErr(error)}`)
    }
  }

  public async openModelModal() {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) {
      this.appendGlobalLog("No workspace selected.")
      return
    }

    const options = await this.resolveModelOptionsForWorkspace(workspace)
    if (options.length === 0) {
      this.appendWorkspaceLog(workspace.id, "[model] no models available from provider catalog.")
      return
    }

    this.modelOptions = options
    const currentModel = this.store.getAgent(workspace.id)?.model ?? this.config.defaultModel ?? null
    const parsedCurrent = parseModelKey(currentModel)
    const currentKey = parsedCurrent ? toModelKey(parsedCurrent.provider, parsedCurrent.modelId) : currentModel

    const selected = currentKey ? options.findIndex((option) => option.key === currentKey) : -1
    this.modelModalSelectedIndex = selected >= 0 ? selected : 0
    this.modelModalVisible = true
    this.emitSnapshot()
  }

  public closeModelModal() {
    if (!this.modelModalVisible) return
    this.modelModalVisible = false
    this.emitSnapshot()
  }

  public moveModelModalSelection(delta: number) {
    if (!this.modelModalVisible) return
    if (this.modelOptions.length === 0) return

    const total = this.modelOptions.length
    const current = Math.max(0, Math.min(this.modelModalSelectedIndex, total - 1))
    this.modelModalSelectedIndex = (current + delta + total) % total
    this.emitSnapshot()
  }

  public async applyModelModalSelection() {
    if (!this.modelModalVisible) return
    const selected = this.modelOptions[this.modelModalSelectedIndex]
    if (!selected) return

    await this.applyModelOptionSelection(selected)
    this.modelModalVisible = false
    this.refreshStatusPanel()
    this.emitSnapshot()
  }

  public async setModelModalSelection(index: number, applyImmediately = false) {
    if (this.modelOptions.length === 0) return

    const clamped = Math.max(0, Math.min(index, this.modelOptions.length - 1))
    this.modelModalSelectedIndex = clamped

    if (applyImmediately) {
      const selected = this.modelOptions[clamped]
      if (selected) {
        await this.applyModelOptionSelection(selected)
      }
      this.modelModalVisible = false
      this.refreshStatusPanel()
    }

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

  private loadWorkspaceRuntimeState() {
    this.runtimeStateByWorkspace.clear()

    for (const record of this.store.listWorkspaceRuntimeStates()) {
      this.runtimeStateByWorkspace.set(record.workspaceId, record)
      if (record.sendMode) {
        this.sendModeState = setWorkspaceSendMode(this.sendModeState, record.workspaceId, record.sendMode)
      }
    }
  }

  private getWorkspaceRuntimeState(workspaceId: number): WorkspaceRuntimeStateRecord {
    const existing = this.runtimeStateByWorkspace.get(workspaceId)
    if (existing) {
      return existing
    }

    const fresh: WorkspaceRuntimeStateRecord = {
      workspaceId,
      sendMode: null,
      sessionFile: null,
      turnCount: 0,
      toolCallCount: 0,
      lastTurnAt: null,
      userMessages: 0,
      assistantMessages: 0,
      sessionToolCalls: 0,
      tokensTotal: 0,
      costTotal: 0,
      updatedAt: new Date().toISOString(),
    }

    this.runtimeStateByWorkspace.set(workspaceId, fresh)
    return fresh
  }

  private setWorkspaceRuntimeState(workspaceId: number, patch: Partial<WorkspaceRuntimeStateRecord>) {
    const current = this.getWorkspaceRuntimeState(workspaceId)
    const next: WorkspaceRuntimeStateRecord = {
      ...current,
      ...patch,
      workspaceId,
      updatedAt: new Date().toISOString(),
    }

    this.runtimeStateByWorkspace.set(workspaceId, next)
    this.store.upsertWorkspaceRuntimeState({
      workspaceId,
      sendMode: next.sendMode,
      sessionFile: next.sessionFile,
      turnCount: next.turnCount,
      toolCallCount: next.toolCallCount,
      lastTurnAt: next.lastTurnAt,
      userMessages: next.userMessages,
      assistantMessages: next.assistantMessages,
      sessionToolCalls: next.sessionToolCalls,
      tokensTotal: next.tokensTotal,
      costTotal: next.costTotal,
    })
  }

  private getSendModeForWorkspace(workspaceId: number | null): SendMode {
    return getWorkspaceSendMode(this.sendModeState, workspaceId)
  }

  private getActiveSendMode(): SendMode {
    return this.getSendModeForWorkspace(this.selectedWorkspaceId)
  }

  private getSelectedModelLabel(): string {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) {
      return this.config.defaultModel ?? "<model not set>"
    }

    const agent = this.store.getAgent(workspace.id)
    return agent?.model ?? this.config.defaultModel ?? "<model not set>"
  }

  public togglePlanBuildModeForCurrentSelection() {
    const current = this.getActiveSendMode()
    const next: SendMode = current === "prompt" ? "follow_up" : "prompt"
    this.setSendModeForCurrentSelection(next)
    this.refreshStatusPanel()
    this.emitSnapshot()
  }

  private setSendModeForCurrentSelection(mode: SendMode) {
    this.sendModeState = setWorkspaceSendMode(this.sendModeState, this.selectedWorkspaceId, mode)

    if (this.selectedWorkspaceId) {
      this.setWorkspaceRuntimeState(this.selectedWorkspaceId, { sendMode: mode })
    }
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
    const prView = workspace ? this.prViewByWorkspace.get(workspace.id) ?? null : null
    const prChecksLabel = prView ? summarizePrChecks(prView.checks).label : "unknown"
    const prLabel = prView
      ? `#${prView.number ?? "?"} ${prView.state ?? "<unknown>"}${prView.isDraft ? " (draft)" : ""} · ${prChecksLabel}`
      : "<none>"
    const runtime = workspace ? this.getWorkspaceRuntimeState(workspace.id) : null
    const runtimeStatsLabel = runtime ? `turns ${runtime.turnCount} · tools ${runtime.toolCallCount}` : "<none>"
    const runtimeSessionLabel = runtime
      ? `user ${runtime.userMessages} · assistant ${runtime.assistantMessages} · tool calls ${runtime.sessionToolCalls}`
      : "<none>"
    const runtimeUsageLabel = runtime
      ? `${runtime.tokensTotal.toLocaleString()} tokens · $${runtime.costTotal.toFixed(4)}`
      : "<none>"
    const lastTurnLabel = runtime?.lastTurnAt ?? "<none>"

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
      `pr         ${prLabel}`,
      `run        ${runState} · mode=${this.runMode}`,
      `tests      ${testStatus}`,
      `readiness  ${readinessLabel}`,
      `merge      ${mergeLabel}`,
      `stats      ${runtimeStatsLabel}`,
      `session    ${runtimeSessionLabel}`,
      `usage      ${runtimeUsageLabel}`,
      `last_turn  ${lastTurnLabel}`,
      `changes    ${changedCount} files`,
    ]

    this.statusText = statusLines.join("\n")
    this.conversationTabsText = workspace ? workspace.branch : "No workspace selected"
    this.footerText = `repos=${this.repos.length} workspaces=${this.workspaces.length} · theme=${this.themeKey} · data=${this.config.dataDir} · pi=${this.config.piCommand}`
  }

  private toConversationBlocks(lines: string[]): ConversationBlock[] {
    return renderConversationBlocks(lines)
  }

  private toConversationMarkdown(lines: string[]): string {
    return renderConversationMarkdown(lines)
  }

  private refreshLogsPanel() {
    const selectedWorkspace = this.getSelectedWorkspace()
    const streamId = selectedWorkspace?.id ?? GLOBAL_LOG_STREAM_ID
    const lines = this.logsByStream.get(streamId) ?? []
    this.conversationBlocks = this.toConversationBlocks(lines)
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
  const [hoveredWorkspaceId, setHoveredWorkspaceId] = useState<number | null>(null)
  const [composerText, setComposerText] = useState("")
  const [commandSuggestionIndex, setCommandSuggestionIndex] = useState(0)
  const [loadingFrameIndex, setLoadingFrameIndex] = useState(0)
  const theme = useMemo(() => getThemeByKey(snapshot.themeKey), [snapshot.themeKey])
  const colors = theme.colors

  const conversationSyntaxStyle = useMemo(
    () =>
      SyntaxStyle.fromStyles({
        keyword: { fg: parseColor(colors.accent), bold: true },
        string: { fg: parseColor(colors.success) },
        comment: { fg: parseColor(colors.textMuted), italic: true },
        number: { fg: parseColor(colors.error) },
        function: { fg: parseColor(colors.accentStrong) },
        type: { fg: parseColor(colors.warning) },
        operator: { fg: parseColor(colors.warning) },
        variable: { fg: parseColor(colors.textPrimary) },
        property: { fg: parseColor(colors.accentSoft) },
        "markup.heading": { fg: parseColor(colors.textSecondary), bold: true },
        "markup.heading.1": { fg: parseColor(colors.textPrimary), bold: true },
        "markup.heading.2": { fg: parseColor(colors.textSecondary), bold: true },
        "markup.bold": { fg: parseColor(colors.textPrimary), bold: true },
        "markup.strong": { fg: parseColor(colors.textPrimary), bold: true },
        "markup.italic": { fg: parseColor(colors.textSecondary), italic: true },
        "markup.list": { fg: parseColor(colors.textMuted) },
        "markup.quote": { fg: parseColor(colors.textMuted), italic: true },
        "markup.raw": { fg: parseColor(colors.accent), bg: parseColor(colors.markdownCodeBackground) },
        "markup.raw.block": { fg: parseColor(colors.accent), bg: parseColor(colors.markdownCodeBackground) },
        "markup.raw.inline": { fg: parseColor(colors.accent), bg: parseColor(colors.markdownCodeBackground) },
        "markup.link": { fg: parseColor(colors.link), underline: true },
        "markup.link.label": { fg: parseColor(colors.link), underline: true },
        "markup.link.url": { fg: parseColor(colors.link), underline: true },
        default: { fg: parseColor(colors.textPrimary) },
      }),
    [colors],
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
  const themeModalWidth = clamp(Math.floor(terminalWidth * 0.52), 54, Math.max(54, terminalWidth - 8))
  const themeModalHeight = clamp(Math.floor(terminalHeight * 0.58), 12, Math.max(12, terminalHeight - 6))
  const modelModalWidth = clamp(Math.floor(terminalWidth * 0.58), 58, Math.max(58, terminalWidth - 8))
  const modelModalHeight = clamp(Math.floor(terminalHeight * 0.62), 14, Math.max(14, terminalHeight - 6))
  const diffModalWidth = clamp(Math.floor(terminalWidth * 0.9), 72, Math.max(72, terminalWidth - 4))
  const diffModalHeight = clamp(Math.floor(terminalHeight * 0.85), 16, Math.max(16, terminalHeight - 3))
  const headerActions = "/help · /mode · /model · /theme · /ui"
  const headerWidth = Math.max(12, centerColumnWidth - 2)
  const minGap = 3
  const maxTitleWidth = Math.max(4, headerWidth - headerActions.length - minGap)
  const centerTitle = snapshot.conversationTabsText
  const truncatedTitle =
    centerTitle.length > maxTitleWidth ? `${centerTitle.slice(0, Math.max(0, maxTitleWidth - 1))}…` : centerTitle
  const fillerLen = Math.max(1, headerWidth - truncatedTitle.length - headerActions.length - 2)
  const conversationHeaderText = `${truncatedTitle} ${"─".repeat(fillerLen)} ${headerActions}`
  const lobbySubtitle = "Select a workspace to continue"
  const lobbyOpenProjectLabel = "Open project"
  const lobbyAsciiWidth = lobbyAscii.reduce((max, line) => Math.max(max, line.length), 0)
  const lobbyButtonWidth = lobbyOpenProjectLabel.length + 6
  const lobbyContentWidth = Math.max(lobbyAsciiWidth, lobbySubtitle.length, lobbyButtonWidth)
  const lobbyContentHeight = lobbyAscii.length + 7
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
    : ""
  const centerMarkdown = snapshot.conversationMarkdown
  const conversationBlocks = snapshot.conversationBlocks
  const composerFirstLine = composerText.split(/\r?\n/, 1)[0] ?? ""
  const hasSlashCommandPrefix = composerFirstLine.trimStart().startsWith("/")
  const commandQuery = hasSlashCommandPrefix ? composerFirstLine.trimStart().slice(1) : ""
  const commandSuggestions = findCommandSuggestions(commandQuery)
  const themeOptions = listThemes()
  const selectedModelOption = snapshot.modelOptions[snapshot.modelModalSelectedIndex] ?? null
  const modelOptionCount = snapshot.modelOptions.length
  const modelVisibleCount = Math.max(4, Math.floor((modelModalHeight - 8) / 3))
  const modelWindowStart =
    modelOptionCount <= modelVisibleCount
      ? 0
      : Math.max(
          0,
          Math.min(
            modelOptionCount - modelVisibleCount,
            snapshot.modelModalSelectedIndex - Math.floor(modelVisibleCount / 2),
          ),
        )
  const visibleModelOptions = snapshot.modelOptions.slice(modelWindowStart, modelWindowStart + modelVisibleCount)
  const hiddenModelOptionsAbove = modelWindowStart
  const hiddenModelOptionsBelow = Math.max(0, modelOptionCount - (modelWindowStart + visibleModelOptions.length))
  const commandAutocompleteVisible =
    focusTarget === "input" &&
    !workspaceSelectionMode &&
    !createWorkspaceModalVisible &&
    !snapshot.themeModalVisible &&
    !snapshot.modelModalVisible &&
    !snapshot.commandModalVisible &&
    hasSlashCommandPrefix
  const selectedCommandSuggestion = commandSuggestions[commandSuggestionIndex] ?? commandSuggestions[0] ?? null
  const commandSuggestionRows = commandAutocompleteVisible ? Math.min(commandSuggestions.length, 6) : 0
  const commandSuggestionHeight = commandAutocompleteVisible ? commandSuggestionRows + 2 : 0
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

  useEffect(() => {
    if (hoveredWorkspaceId === null) {
      return
    }

    const stillVisible = snapshot.workspaceTreeOptions.some((option) => {
      const parsed = parseWorkspaceTreeValue(option.value)
      return parsed?.type === "workspace" && parsed.workspaceId === hoveredWorkspaceId
    })

    if (!stillVisible) {
      setHoveredWorkspaceId(null)
    }
  }, [hoveredWorkspaceId, snapshot.workspaceTreeOptions])

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
    setFocusTarget("workspace")
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

    if (snapshot.themeModalVisible && key.name === "escape") {
      key.preventDefault()
      app.closeThemeModal()
      return
    }

    if (snapshot.themeModalVisible) {
      if (key.name === "up") {
        key.preventDefault()
        app.moveThemeModalSelection(-1)
        return
      }

      if (key.name === "down") {
        key.preventDefault()
        app.moveThemeModalSelection(1)
        return
      }

      if (key.name === "return" || key.name === "linefeed") {
        key.preventDefault()
        app.applyThemeModalSelection()
        return
      }

      return
    }

    if (snapshot.modelModalVisible && key.name === "escape") {
      key.preventDefault()
      app.closeModelModal()
      return
    }

    if (snapshot.modelModalVisible) {
      if (key.name === "up") {
        key.preventDefault()
        app.moveModelModalSelection(-1)
        return
      }

      if (key.name === "down") {
        key.preventDefault()
        app.moveModelModalSelection(1)
        return
      }

      if (key.name === "return" || key.name === "linefeed") {
        key.preventDefault()
        void app.applyModelModalSelection()
        return
      }

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
      if (!key.shift && focusTarget === "input" && !workspaceSelectionMode && !commandAutocompleteVisible) {
        key.preventDefault()
        app.togglePlanBuildModeForCurrentSelection()
        return
      }

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
            backgroundColor={colors.sidebarBackground}
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
                backgroundColor={
                  workspaceTreeCollapsed ? colors.sectionHeaderCollapsedBackground : colors.sectionHeaderBackground
                }
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
                  fg={colors.sectionHeaderText}
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
                      backgroundColor: colors.sidebarBackground,
                    }}
                    wrapperOptions={{
                      backgroundColor: colors.sidebarBackground,
                    }}
                    viewportOptions={{
                      backgroundColor: colors.sidebarBackground,
                    }}
                    contentOptions={{
                      backgroundColor: colors.sidebarBackground,
                    }}
                  >
                    {snapshot.workspaceTreeOptions.map((option, index) => {
                      const value = String(option.value ?? "")
                      const parsed = parseWorkspaceTreeValue(option.value)
                      if (!parsed) {
                        return null
                      }

                      const treeSelected = index === snapshot.workspaceTreeSelectedIndex
                      const isRepoRow = parsed.type === "repo"

                      if (isRepoRow) {
                        const caret = option.name.startsWith("▾") ? "▾" : "▸"
                        const projectLabel = option.name.replace(/^[▾▸]\s*/, "")

                        return (
                          <box
                            key={value}
                            id={`pc-workspace-tree-row-${index}`}
                            height={1}
                            backgroundColor={treeSelected ? colors.markdownCodeBackground : "transparent"}
                            onMouseMove={() => {
                              if (hoveredWorkspaceId !== null) {
                                setHoveredWorkspaceId(null)
                              }
                            }}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              flexShrink: 0,
                              marginBottom: 1,
                            }}
                          >
                            <box
                              id={`pc-workspace-tree-repo-toggle-${index}`}
                              onMouseDown={(event) => {
                                event.preventDefault()
                                setWorkspaceTreeCollapsed(false)
                                setFocusTarget("workspace")
                                app.toggleRepoExpanded(parsed.repoId)
                              }}
                              style={{
                                flexShrink: 0,
                              }}
                            >
                              <text
                                id={`pc-workspace-tree-row-caret-${index}`}
                                content={caret}
                                fg={colors.accentStrong}
                                wrapMode="none"
                                selectable={false}
                              />
                            </box>

                            <text
                              id={`pc-workspace-tree-row-project-name-${index}`}
                              content={` ${projectLabel}`}
                              fg={colors.accentStrong}
                              wrapMode="none"
                              selectable={false}
                              style={{
                                flexGrow: 1,
                                flexShrink: 1,
                              }}
                            />

                            <box
                              id={`pc-workspace-tree-repo-add-${index}`}
                              onMouseDown={(event) => {
                                event.preventDefault()
                                setWorkspaceTreeCollapsed(false)
                                setFocusTarget("workspace")
                                void app.createWorkspaceForRepo(parsed.repoId)
                              }}
                              style={{
                                flexShrink: 0,
                              }}
                            >
                              <text content="[+]" fg={colors.success} wrapMode="none" selectable={false} />
                            </box>
                          </box>
                        )
                      }

                      const meta = parseWorkspaceTreeRowMeta(option.description)
                      const plusText = `+${meta.added}`
                      const minusText = `-${meta.removed}`
                      const runtimeLabel = formatWorkspaceRuntimeLabel(meta.status, meta.busy)
                      const statusText = runtimeLabel === "stopped" ? "idle" : runtimeLabel
                      const statusColor = workspaceStatusColor(runtimeLabel, theme)
                      const activityText = formatWorkspaceActivityAge(meta.activityAt)
                      const workspaceActive = parsed.workspaceId === snapshot.selectedWorkspaceId
                      const workspaceBg = workspaceActive
                        ? colors.selectedBackground
                        : treeSelected
                          ? colors.markdownCodeBackground
                          : colors.inputBackground
                      const workspaceFg = workspaceActive || treeSelected ? colors.selectedText : colors.textSecondary
                      const workspaceHovered = hoveredWorkspaceId === parsed.workspaceId

                      return (
                        <box
                          key={value}
                          id={`pc-workspace-tree-row-${index}`}
                          height={2}
                          backgroundColor={workspaceBg}
                          onMouseMove={() => {
                            if (hoveredWorkspaceId !== parsed.workspaceId) {
                              setHoveredWorkspaceId(parsed.workspaceId)
                            }
                          }}
                          onMouseDown={(event) => {
                            event.preventDefault()
                            setWorkspaceTreeCollapsed(false)
                            setFocusTarget("input")
                            app.selectWorkspaceTreeOption(option, false)
                          }}
                          style={{
                            flexDirection: "column",
                            flexShrink: 0,
                            marginBottom: 1,
                            paddingLeft: 2,
                            paddingRight: 1,
                          }}
                        >
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
                              fg={workspaceFg}
                              wrapMode="none"
                              style={{
                                flexGrow: 1,
                                flexShrink: 1,
                              }}
                            />
                            {workspaceHovered ? (
                              <box
                                id={`pc-workspace-tree-row-archive-${index}`}
                                onMouseDown={(event) => {
                                  event.preventDefault()
                                  void app.archiveWorkspaceById(parsed.workspaceId, false)
                                }}
                                style={{
                                  flexShrink: 0,
                                  marginLeft: 1,
                                }}
                              >
                                <text content="[-]" fg={colors.error} wrapMode="none" selectable={false} />
                              </box>
                            ) : (
                              <text
                                id={`pc-workspace-tree-row-activity-${index}`}
                                content={activityText}
                                fg={colors.textMuted}
                                wrapMode="none"
                                selectable={false}
                                style={{
                                  flexShrink: 0,
                                  marginLeft: 1,
                                }}
                              />
                            )}
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
                              id={`pc-workspace-tree-row-status-dot-${index}`}
                              content="· "
                              fg={colors.textMuted}
                              wrapMode="none"
                              selectable={false}
                              style={{
                                flexShrink: 0,
                              }}
                            />
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
                            {!workspaceHovered ? (
                              <text
                                id={`pc-workspace-tree-row-diff-${index}`}
                                content={`${plusText}/${minusText}`}
                                fg={colors.textMuted}
                                wrapMode="none"
                                selectable={false}
                                style={{
                                  flexShrink: 0,
                                }}
                              />
                            ) : null}
                          </box>
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
              <text id="pc-workspace-version" content={`Piductor ${APP_VERSION}`} fg={colors.textMuted} wrapMode="none" />
              <text
                id="pc-workspace-archive-tip"
                content="/workspace archived · /workspace restore <id|name>"
                fg={colors.textSubtle}
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
            backgroundColor={leftResizerActive ? colors.accentSoft : colors.commandPaletteBorder}
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
          backgroundColor={colors.centerBackground}
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
                    fg={index < 2 ? colors.accent : colors.accentStrong}
                    wrapMode="none"
                  />
                ))}
                <text content={lobbySubtitle} fg={colors.textMuted} wrapMode="none" style={{ marginTop: 1 }} />

                <box
                  id="pc-lobby-open-project-btn"
                  width={lobbyButtonWidth}
                  height={3}
                  border
                  borderStyle="single"
                  borderColor={colors.modalBorder}
                  backgroundColor={colors.commandPaletteBackground}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    setCreateWorkspaceModalVisible(true)
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    marginTop: 2,
                    paddingLeft: 1,
                    paddingRight: 1,
                    flexShrink: 0,
                  }}
                >
                  <text content={lobbyOpenProjectLabel} fg={colors.accentStrong} wrapMode="none" selectable={false} />
                </box>
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
            backgroundColor={colors.centerBackground}
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
              backgroundColor={colors.sectionHeaderBackground}
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
                fg={colors.sectionHeaderText}
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
              {conversationBlocks.length === 0 ? (
                <box
                  id="pc-conversation-empty"
                  width="100%"
                  style={{
                    flexDirection: "column",
                    flexShrink: 0,
                    paddingLeft: 1,
                    paddingRight: 1,
                  }}
                >
                  <markdown
                    id="pc-conversation-markdown-empty"
                    content={centerMarkdown}
                    syntaxStyle={conversationSyntaxStyle}
                    conceal
                  />
                </box>
              ) : (
                conversationBlocks.map((block, index) => {
                  const isLast = index === conversationBlocks.length - 1

                  if (block.kind === "user") {
                    return (
                      <box
                        key={`pc-conversation-user-${index}`}
                        width="100%"
                        backgroundColor={colors.userRowBackground}
                        style={{
                          flexDirection: "column",
                          flexShrink: 0,
                          marginBottom: isLast ? 0 : 1,
                          marginRight: 1,
                          paddingTop: 1,
                          paddingBottom: 1,
                          paddingLeft: 1,
                          paddingRight: 1,
                        }}
                      >
                        <text content={block.text} fg={colors.userRowText} wrapMode="word" />
                      </box>
                    )
                  }

                  if (block.kind === "activity") {
                    return (
                      <box
                        key={`pc-conversation-activity-${index}`}
                        width="100%"
                        style={{
                          flexDirection: "column",
                          flexShrink: 0,
                          marginBottom: isLast ? 0 : 1,
                          paddingLeft: 1,
                          paddingRight: 1,
                        }}
                      >
                        <text content={block.text} fg={colors.activityText} wrapMode="word" />
                      </box>
                    )
                  }

                  return (
                    <box
                      key={`pc-conversation-markdown-${index}`}
                      width="100%"
                      style={{
                        flexDirection: "column",
                        flexShrink: 0,
                        marginBottom: isLast ? 0 : 1,
                        paddingLeft: 1,
                        paddingRight: 1,
                      }}
                    >
                      <markdown content={block.markdown} syntaxStyle={conversationSyntaxStyle} conceal />
                    </box>
                  )
                })
              )}

              {snapshot.thinkingActive && (
                <text
                  id="pc-thinking-indicator"
                  content={thinkingIndicatorText}
                  fg={colors.accent}
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
            backgroundColor={colors.inputBackground}
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
                backgroundColor={colors.commandPaletteBackground}
                border
                borderColor={colors.commandPaletteBorder}
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
                      backgroundColor={selected ? colors.selectedBackground : "transparent"}
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
                      <text content={line} fg={selected ? colors.selectedText : colors.accent} wrapMode="none" />
                    </box>
                  )
                })}
              </box>
            )}

            <box
              id="pc-input-shell"
              width="100%"
              backgroundColor={colors.userRowBackground}
              onMouseDown={() => {
                setFocusTarget("input")
              }}
              style={{
                flexDirection: "column",
                flexShrink: 0,
                paddingLeft: 1,
                paddingRight: 1,
              }}
            >
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
                textColor={colors.inputText}
                focusedTextColor={colors.inputText}
                placeholderColor={colors.inputPlaceholder}
                backgroundColor="transparent"
                focusedBackgroundColor="transparent"
                cursorColor={colors.inputCursor}
                wrapMode="word"
                height={3}
              />

              <box
                id="pc-compose-footer"
                height={1}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  marginTop: 1,
                  flexShrink: 0,
                }}
              >
                <box
                  id="pc-compose-mode-toggle"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    app.togglePlanBuildModeForCurrentSelection()
                  }}
                >
                  <text
                    content={`[${snapshot.planBuildMode === "plan" ? "Plan" : "Build"} mode]`}
                    fg={colors.accent}
                    wrapMode="none"
                    selectable={false}
                  />
                </box>

                <text content="  " fg={colors.textMuted} wrapMode="none" selectable={false} />

                <text
                  content={`Model: ${snapshot.modelLabel}`}
                  fg={colors.textMuted}
                  wrapMode="none"
                  selectable={false}
                  style={{
                    flexGrow: 1,
                    flexShrink: 1,
                  }}
                />
              </box>
            </box>
          </box>
            </box>
          )}
        </box>

        {rightVisible && (
          <box
            id="pc-right-resizer"
            width={1}
            shouldFill
            backgroundColor={rightResizerActive ? colors.accentSoft : colors.commandPaletteBorder}
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
            backgroundColor={colors.rightBackground}
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
                backgroundColor={
                  statusSectionCollapsed ? colors.sectionHeaderCollapsedBackground : colors.sectionHeaderBackground
                }
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
                  fg={colors.sectionHeaderText}
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
                        fg={colors.accent}
                        wrapMode="none"
                        selectable={false}
                        style={{
                          flexShrink: 0,
                        }}
                      />
                      <text
                        id={`pc-status-value-${index}`}
                        content={row.value}
                        fg={colors.textSecondary}
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
                backgroundColor={
                  changesSectionCollapsed ? colors.sectionHeaderCollapsedBackground : colors.sectionHeaderBackground
                }
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
                  fg={colors.sectionHeaderText}
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
                      fg={colors.textSecondary}
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
                          backgroundColor={selected ? colors.selectedBackground : "transparent"}
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
                            fg={colors.success}
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
                            fg={colors.error}
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
                            fg={selected ? colors.selectedText : colors.textSecondary}
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
                          fg={colors.textMuted}
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
                backgroundColor={
                  terminalSectionCollapsed ? colors.sectionHeaderCollapsedBackground : colors.sectionHeaderBackground
                }
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
                  fg={colors.sectionHeaderText}
                  wrapMode="none"
                  selectable={false}
                />
              </box>

              {!terminalSectionCollapsed && (
                <text
                  id="pc-terminal-text"
                  content={snapshot.terminalText}
                  fg={colors.success}
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
          backgroundColor={colors.modalOverlayBackground}
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
            borderColor={colors.modalBorder}
            backgroundColor={colors.modalBackground}
            title="Open project"
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
            <text content="Local project path" fg={colors.sectionHeaderText} wrapMode="none" selectable={false} />
            <textarea
              id="pc-create-workspace-path"
              ref={createPathRef}
              focused={createWorkspaceModalVisible}
              placeholder="~/Projects/my-project"
              onSubmit={() => {
                void submitCreateWorkspaceFromModal()
              }}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "linefeed", action: "submit" },
              ]}
              textColor={colors.inputText}
              focusedTextColor={colors.inputText}
              placeholderColor={colors.inputPlaceholder}
              backgroundColor={colors.markdownCodeBackground}
              focusedBackgroundColor={colors.commandPaletteBackground}
              cursorColor={colors.inputCursor}
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
                <text content="[Open]" fg={colors.success} wrapMode="none" selectable={false} />
              </box>

              <text content=" " fg={colors.textMuted} wrapMode="none" selectable={false} />

              <box
                id="pc-create-workspace-modal-cancel"
                onMouseDown={(event) => {
                  event.preventDefault()
                  setCreateWorkspaceModalVisible(false)
                }}
              >
                <text content="[Cancel]" fg={colors.error} wrapMode="none" selectable={false} />
              </box>

              <text
                content="  Enter project path · Esc to cancel"
                fg={colors.textSubtle}
                wrapMode="none"
                selectable={false}
              />
            </box>
          </box>
        </box>
      )}

      {snapshot.themeModalVisible && (
        <box
          id="pc-theme-modal-backdrop"
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          backgroundColor={colors.modalOverlayBackground}
          onMouseDown={(event) => {
            event.preventDefault()
            app.closeThemeModal()
          }}
          style={{
            zIndex: 93,
          }}
        >
          <box
            id="pc-theme-modal"
            position="absolute"
            left="50%"
            top="50%"
            width={themeModalWidth}
            height={themeModalHeight}
            marginLeft={-Math.floor(themeModalWidth / 2)}
            marginTop={-Math.floor(themeModalHeight / 2)}
            border
            borderStyle="double"
            borderColor={colors.modalBorder}
            backgroundColor={colors.modalBackground}
            title={`Theme · ${theme.name}`}
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
            <text
              content="Use ↑/↓ to select, Enter to apply, Esc to close"
              fg={colors.textMuted}
              wrapMode="none"
              style={{
                flexShrink: 0,
              }}
            />

            <scrollbox
              id="pc-theme-modal-scroll"
              border={false}
              scrollY
              scrollX={false}
              shouldFill
              style={{
                flexGrow: 1,
                marginTop: 1,
              }}
            >
              {themeOptions.map((option, index) => {
                const selected = index === snapshot.themeModalSelectedIndex
                const active = option.key === snapshot.themeKey
                const label = `${selected ? "›" : " "} ${option.name} (${option.key})${active ? " · current" : ""}`

                return (
                  <box
                    key={`pc-theme-option-${option.key}`}
                    width="100%"
                    height={2}
                    backgroundColor={selected ? colors.selectedBackground : "transparent"}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      app.setThemeModalSelection(index, true)
                    }}
                    style={{
                      flexDirection: "column",
                      flexShrink: 0,
                      marginBottom: index === themeOptions.length - 1 ? 0 : 1,
                    }}
                  >
                    <text content={label} fg={selected ? colors.selectedText : colors.textPrimary} wrapMode="none" />
                    <text content={`  ${option.description}`} fg={colors.textMuted} wrapMode="none" />
                  </box>
                )
              })}
            </scrollbox>

            <text content="Enter applies selected theme" fg={colors.textSubtle} wrapMode="none" selectable={false} />
          </box>
        </box>
      )}

      {snapshot.modelModalVisible && (
        <box
          id="pc-model-modal-backdrop"
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          backgroundColor={colors.modalOverlayBackground}
          onMouseDown={(event) => {
            event.preventDefault()
            app.closeModelModal()
          }}
          style={{
            zIndex: 92,
          }}
        >
          <box
            id="pc-model-modal"
            position="absolute"
            left="50%"
            top="50%"
            width={modelModalWidth}
            height={modelModalHeight}
            marginLeft={-Math.floor(modelModalWidth / 2)}
            marginTop={-Math.floor(modelModalHeight / 2)}
            border
            borderStyle="double"
            borderColor={colors.modalBorder}
            backgroundColor={colors.modalBackground}
            title={`Model · ${selectedModelOption?.name ?? "Select"}`}
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
            <text
              content="Use ↑/↓ to select, Enter to apply, Esc to close"
              fg={colors.textMuted}
              wrapMode="none"
              style={{
                flexShrink: 0,
              }}
            />

            <scrollbox
              id="pc-model-modal-scroll"
              border={false}
              scrollY
              scrollX={false}
              shouldFill
              style={{
                flexGrow: 1,
                marginTop: 1,
              }}
            >
              {hiddenModelOptionsAbove > 0 ? (
                <text
                  content={`↑ ${hiddenModelOptionsAbove} more models`}
                  fg={colors.textSubtle}
                  wrapMode="none"
                  style={{
                    flexShrink: 0,
                    marginBottom: 1,
                  }}
                />
              ) : null}

              {visibleModelOptions.map((option, visibleIndex) => {
                const index = modelWindowStart + visibleIndex
                const selected = index === snapshot.modelModalSelectedIndex
                const active = option.key === snapshot.modelLabel
                const label = `${selected ? "›" : " "} ${option.name}${active ? " · current" : ""}`
                const metadata = `  ${option.provider}/${option.modelId}${option.description ? ` · ${option.description}` : ""}`

                return (
                  <box
                    key={`pc-model-option-${option.key}`}
                    width="100%"
                    height={2}
                    backgroundColor={selected ? colors.selectedBackground : "transparent"}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      void app.setModelModalSelection(index, true)
                    }}
                    style={{
                      flexDirection: "column",
                      flexShrink: 0,
                      marginBottom:
                        visibleIndex === visibleModelOptions.length - 1 && hiddenModelOptionsBelow === 0 ? 0 : 1,
                    }}
                  >
                    <text content={label} fg={selected ? colors.selectedText : colors.textPrimary} wrapMode="none" />
                    <text content={metadata} fg={colors.textMuted} wrapMode="none" />
                  </box>
                )
              })}

              {hiddenModelOptionsBelow > 0 ? (
                <text
                  content={`↓ ${hiddenModelOptionsBelow} more models`}
                  fg={colors.textSubtle}
                  wrapMode="none"
                  style={{
                    flexShrink: 0,
                  }}
                />
              ) : null}
            </scrollbox>

            <text
              content={`Enter applies selected model${modelOptionCount > 0 ? ` · ${snapshot.modelModalSelectedIndex + 1}/${modelOptionCount}` : ""}`}
              fg={colors.textSubtle}
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

      {snapshot.commandModalVisible && (
        <box
          id="pc-command-modal-backdrop"
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          backgroundColor={colors.modalOverlayBackground}
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
            borderColor={colors.modalBorder}
            backgroundColor={colors.modalBackground}
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
                fg={colors.textMuted}
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
                <text content="[Close]" fg={colors.error} wrapMode="none" selectable={false} />
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
              fg={colors.textSubtle}
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
          backgroundColor={colors.modalOverlayBackground}
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
            borderColor={colors.modalBorder}
            backgroundColor={colors.modalBackground}
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
                fg={colors.accentStrong}
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
                <text
                  content={`[Mode: ${snapshot.diffViewMode}]`}
                  fg={colors.accent}
                  wrapMode="none"
                  selectable={false}
                />
              </box>

              <text content=" " fg={colors.accent} wrapMode="none" selectable={false} />

              <box
                id="pc-diff-modal-close-btn"
                onMouseDown={(event) => {
                  event.preventDefault()
                  app.closeDiffReview()
                }}
              >
                <text content="[Close]" fg={colors.error} wrapMode="none" selectable={false} />
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
                lineNumberFg={colors.diffLineNumberFg}
                lineNumberBg={colors.diffLineNumberBg}
                addedBg={colors.diffAddedBg}
                removedBg={colors.diffRemovedBg}
                contextBg={colors.diffContextBg}
                addedSignColor={colors.diffAddedSign}
                removedSignColor={colors.diffRemovedSign}
                addedLineNumberBg={colors.diffAddedLineNumberBg}
                removedLineNumberBg={colors.diffRemovedLineNumberBg}
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
                fg={colors.textSecondary}
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
                <text content="[◀ File]" fg={colors.accent} wrapMode="none" selectable={false} />
              </box>

              <text content=" " fg={colors.accent} wrapMode="none" selectable={false} />

              <box
                id="pc-diff-modal-next-file"
                onMouseDown={(event) => {
                  event.preventDefault()
                  app.cycleDiffFile(1)
                }}
              >
                <text content="[File ▶]" fg={colors.accent} wrapMode="none" selectable={false} />
              </box>

              <text
                content={`  ${snapshot.diffHunkCount} hunk${snapshot.diffHunkCount === 1 ? "" : "s"} in file`}
                fg={colors.textMuted}
                wrapMode="none"
                selectable={false}
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                }}
              />

              <text content="Esc or [Close]" fg={colors.textSubtle} wrapMode="none" selectable={false} />
            </box>
          </box>
        </box>
      )}
    </box>
  )
}
