import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  createCliRenderer,
  parseColor,
  SyntaxStyle,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core"
import { createRoot, useKeyboard, type Root } from "@opentui/react"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { Store } from "./db"
import { PiRpcProcess } from "./pi-rpc"
import type { AppConfig, RepoRecord, SendMode, WorkspaceRecord } from "./types"
import {
  cloneRepo,
  createWorktree,
  ensureRepoFromLocalPath,
  getChangedFiles,
  getChangedFileStats,
  removeWorktree,
  slugify,
} from "./git"

const GLOBAL_LOG_STREAM_ID = 0

type FocusTarget = "repo" | "workspace" | "input"

export interface AppSnapshot {
  repos: RepoRecord[]
  workspaces: WorkspaceRecord[]
  repoOptions: SelectOption[]
  workspaceOptions: SelectOption[]
  repoSelectedIndex: number
  workspaceSelectedIndex: number
  selectedRepoId: number | null
  selectedWorkspaceId: number | null
  sendMode: SendMode
  leftSidebarCollapsed: boolean
  rightSidebarCollapsed: boolean
  headerText: string
  statusText: string
  conversationTabsText: string
  conversationMarkdown: string
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

const DEFAULT_CONVERSATION = "_No conversation yet. Start an agent and send a prompt._"

export class PiConductorApp {
  private readonly renderer: CliRenderer
  private readonly root: Root
  private readonly config: AppConfig
  private readonly store: Store

  private repos: RepoRecord[] = []
  private workspaces: WorkspaceRecord[] = []

  private repoOptions: SelectOption[] = []
  private workspaceOptions: SelectOption[] = []
  private repoSelectedIndex = 0
  private workspaceSelectedIndex = 0

  private selectedRepoId: number | null = null
  private selectedWorkspaceId: number | null = null
  private sendMode: SendMode = "prompt"

  private readonly agentByWorkspace = new Map<number, PiRpcProcess>()
  private readonly logsByStream = new Map<number, string[]>()
  private readonly runLogsByWorkspace = new Map<number, string[]>()
  private readonly assistantPartialByWorkspace = new Map<number, string>()
  private readonly thinkingPartialByWorkspace = new Map<number, string>()
  private readonly runProcessByWorkspace = new Map<number, ChildProcessWithoutNullStreams>()

  private leftSidebarCollapsed = false
  private rightSidebarCollapsed = false
  private isShuttingDown = false

  private headerText = "Pi Conductor · loading..."
  private statusText = "repo       <none>"
  private conversationTabsText = " All changes · Review branch changes · Debugging"
  private conversationMarkdown = DEFAULT_CONVERSATION
  private diffText = "No workspace selected."
  private terminalText = "No workspace selected."
  private footerText = ""

  private snapshot: AppSnapshot = {
    repos: [],
    workspaces: [],
    repoOptions: [],
    workspaceOptions: [],
    repoSelectedIndex: 0,
    workspaceSelectedIndex: 0,
    selectedRepoId: null,
    selectedWorkspaceId: null,
    sendMode: "prompt",
    leftSidebarCollapsed: false,
    rightSidebarCollapsed: false,
    headerText: this.headerText,
    statusText: this.statusText,
    conversationTabsText: this.conversationTabsText,
    conversationMarkdown: this.conversationMarkdown,
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
    this.snapshot = {
      repos: [...this.repos],
      workspaces: [...this.workspaces],
      repoOptions: [...this.repoOptions],
      workspaceOptions: [...this.workspaceOptions],
      repoSelectedIndex: this.repoSelectedIndex,
      workspaceSelectedIndex: this.workspaceSelectedIndex,
      selectedRepoId: this.selectedRepoId,
      selectedWorkspaceId: this.selectedWorkspaceId,
      sendMode: this.sendMode,
      leftSidebarCollapsed: this.leftSidebarCollapsed,
      rightSidebarCollapsed: this.rightSidebarCollapsed,
      headerText: this.headerText,
      statusText: this.statusText,
      conversationTabsText: this.conversationTabsText,
      conversationMarkdown: this.conversationMarkdown,
      diffText: this.diffText,
      terminalText: this.terminalText,
      footerText: this.footerText,
    }

    for (const listener of this.listeners) {
      listener()
    }
  }

  private async bootstrap() {
    this.appendGlobalLog("Welcome to Pi Conductor (terminal prototype).")
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
    this.reloadWorkspaces()
    this.refreshStatusPanel()
    this.refreshDiffPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  }

  public selectWorkspaceOption(option: SelectOption | null) {
    if (!option) return
    this.selectedWorkspaceId = Number(option.value)
    this.refreshStatusPanel()
    this.refreshDiffPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
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
        this.appendGlobalLog("Commands:")
        this.appendGlobalLog("  /repo add <local-path|git-url> [name]")
        this.appendGlobalLog("  /repo select <id|name>")
        this.appendGlobalLog("  /workspace new <name> [baseRef]")
        this.appendGlobalLog("  /workspace archive")
        this.appendGlobalLog("  /workspace select <id|name>")
        this.appendGlobalLog("  /agent start [model]")
        this.appendGlobalLog("  /agent stop")
        this.appendGlobalLog("  /mode <prompt|steer|follow_up>")
        this.appendGlobalLog("  /run [command]  (or config scripts.run)")
        this.appendGlobalLog("  /run stop")
        this.appendGlobalLog("  /status")
        this.appendGlobalLog("  /diff")
        this.appendGlobalLog("  /ui left|right|toggle")
        this.appendGlobalLog("Plain text sends to selected agent in current mode.")
        this.appendGlobalLog("UI: click [+]/[-] in top bar to collapse sidebars (or ctrl+left / ctrl+right).")
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

          const requestedName = args[1]
          if (!requestedName) {
            this.appendGlobalLog("Usage: /workspace new <name> [baseRef]")
            return
          }

          const baseRef = args[2] || "HEAD"
          const workspaceName = slugify(requestedName)

          const created = createWorktree({
            repoRoot: repo.rootPath,
            workspacesDir: this.config.workspacesDir,
            workspaceName,
            baseRef,
          })

          const workspace = this.store.createWorkspace(this.selectedRepoId, workspaceName, created.branch, created.worktreePath)
          this.selectedWorkspaceId = workspace.id
          this.reloadWorkspaces(workspace.id)

          this.appendWorkspaceLog(
            workspace.id,
            `Workspace created at ${workspace.worktreePath} on branch ${workspace.branch}`,
          )

          if (this.config.scripts.setup) {
            this.appendWorkspaceLog(workspace.id, `Running setup script: ${this.config.scripts.setup}`)
            void this.startRunProcess(workspace.id, this.config.scripts.setup, "setup", true)
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

          await this.stopAgent(workspace.id)

          if (this.config.scripts.archive) {
            this.appendWorkspaceLog(workspace.id, `Running archive script: ${this.config.scripts.archive}`)
            await this.startRunProcess(workspace.id, this.config.scripts.archive, "archive", true)
          }

          removeWorktree({ repoRoot: repo.rootPath, worktreePath: workspace.worktreePath, force: true })
          this.store.setWorkspaceArchived(workspace.id, true)
          this.logsByStream.delete(workspace.id)
          this.runLogsByWorkspace.delete(workspace.id)
          this.assistantPartialByWorkspace.delete(workspace.id)
          this.thinkingPartialByWorkspace.delete(workspace.id)

          this.appendGlobalLog(`Archived workspace: ${workspace.name}`)
          this.reloadWorkspaces()
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

        this.appendGlobalLog("Usage: /workspace new|archive|select ...")
        return
      }

      case "agent": {
        const sub = args[0]
        if (sub === "start") {
          const workspace = this.getSelectedWorkspace()
          if (!workspace) {
            this.appendGlobalLog("No workspace selected.")
            return
          }
          await this.startAgent(workspace.id, args[1] || this.config.defaultModel)
          return
        }

        if (sub === "stop") {
          const workspace = this.getSelectedWorkspace()
          if (!workspace) {
            this.appendGlobalLog("No workspace selected.")
            return
          }
          await this.stopAgent(workspace.id)
          return
        }

        this.appendGlobalLog("Usage: /agent start [model] | /agent stop")
        return
      }

      case "mode": {
        const nextMode = args[0] as SendMode | undefined
        if (!nextMode || !["prompt", "steer", "follow_up"].includes(nextMode)) {
          this.appendGlobalLog("Usage: /mode <prompt|steer|follow_up>")
          return
        }

        this.sendMode = nextMode
        this.appendGlobalLog(`Send mode set to ${nextMode}`)
        return
      }

      case "run": {
        const workspace = this.getSelectedWorkspace()
        if (!workspace) {
          this.appendGlobalLog("No workspace selected.")
          return
        }

        if (args[0] === "stop") {
          const running = this.runProcessByWorkspace.get(workspace.id)
          if (!running) {
            this.appendWorkspaceLog(workspace.id, "No run process to stop.")
            this.appendRunLog(workspace.id, "No run process to stop.")
            this.refreshTerminalPanel()
            return
          }
          running.kill("SIGTERM")
          this.appendWorkspaceLog(workspace.id, "Requested run process stop.")
          this.appendRunLog(workspace.id, "Requested run process stop.")
          this.refreshTerminalPanel()
          return
        }

        const command = args.length > 0 ? args.join(" ") : this.config.scripts.run
        if (!command) {
          this.appendWorkspaceLog(workspace.id, "No run command specified. Set scripts.run or pass /run <command>.")
          return
        }

        await this.startRunProcess(workspace.id, command, "run", false)
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

      case "diff": {
        this.refreshDiffPanel()
        this.appendGlobalLog("Diff panel refreshed.")
        return
      }

      default:
        this.appendGlobalLog(`Unknown command: /${command}`)
    }
  }

  private async sendMessageToSelectedAgent(message: string) {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) {
      this.appendGlobalLog("No workspace selected.")
      return
    }

    const agent = this.agentByWorkspace.get(workspace.id)
    if (!agent) {
      this.appendWorkspaceLog(workspace.id, "Agent is not running. Use /agent start")
      return
    }

    this.appendWorkspaceLog(workspace.id, `[you/${this.sendMode}] ${message}`)

    if (this.sendMode === "prompt") {
      await agent.prompt(message)
    } else if (this.sendMode === "steer") {
      await agent.steer(message)
    } else {
      await agent.followUp(message)
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
      this.appendWorkspaceLog(workspaceId, `[pi:stderr] ${line}`)
      this.refreshLogsPanel()
      this.emitSnapshot()
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

      this.appendWorkspaceLog(workspaceId, `Agent started (pid=${agent.pid ?? "?"}).`)
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

  private async stopAgent(workspaceId: number) {
    const agent = this.agentByWorkspace.get(workspaceId)
    if (!agent) return

    try {
      await agent.stop()
    } catch (error) {
      this.appendWorkspaceLog(workspaceId, `Error while stopping agent: ${safeErr(error)}`)
    }

    this.agentByWorkspace.delete(workspaceId)
    this.store.setAgentState({
      workspaceId,
      status: "stopped",
      pid: null,
      model: null,
      sessionId: null,
    })
    this.appendWorkspaceLog(workspaceId, "Agent stopped.")
    this.reloadWorkspaces(this.selectedWorkspaceId)
    this.refreshStatusPanel()
    this.refreshLogsPanel()
    this.emitSnapshot()
  }

  private async startRunProcess(workspaceId: number, command: string, label: string, waitForExit: boolean) {
    const workspace = this.store.getWorkspaceById(workspaceId)
    if (!workspace) {
      this.appendGlobalLog(`Workspace ${workspaceId} not found for ${label} script.`)
      return
    }

    if (this.config.scripts.runMode === "nonconcurrent") {
      const existing = this.runProcessByWorkspace.get(workspaceId)
      if (existing) {
        existing.kill("SIGTERM")
        this.runProcessByWorkspace.delete(workspaceId)
      }
    }

    const child = spawn("bash", ["-lc", command], {
      cwd: workspace.worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")

    this.runProcessByWorkspace.set(workspaceId, child)
    this.appendWorkspaceLog(workspaceId, `[${label}] started`)
    this.appendRunLog(workspaceId, `$ ${command}`)
    this.refreshTerminalPanel()
    this.refreshStatusPanel()
    this.emitSnapshot()

    const attach = (stream: NodeJS.ReadableStream, prefix: string) => {
      let buffer = ""
      stream.on("data", (chunk: any) => {
        buffer += String(chunk)
        while (true) {
          const i = buffer.indexOf("\n")
          if (i === -1) break
          const line = buffer.slice(0, i).trimEnd()
          buffer = buffer.slice(i + 1)
          if (line) {
            this.appendRunLog(workspaceId, `[${label}/${prefix}] ${line}`)
            if (this.selectedWorkspaceId === workspaceId) {
              this.refreshTerminalPanel()
              this.emitSnapshot()
            }
          }
        }
      })
    }

    attach(child.stdout, "out")
    attach(child.stderr, "err")

    const exitPromise = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        if (this.runProcessByWorkspace.get(workspaceId) === child) {
          this.runProcessByWorkspace.delete(workspaceId)
        }
        this.appendWorkspaceLog(
          workspaceId,
          `[${label}] exited code=${code ?? "null"} signal=${signal ?? "none"}`,
        )
        this.appendRunLog(workspaceId, `[${label}] exited code=${code ?? "null"} signal=${signal ?? "none"}`)
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
        this.appendWorkspaceLog(workspaceId, "[agent] started turn")
        break

      case "agent_end":
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
      case "turn_end":
        this.flushThinkingPartial(workspaceId)
        this.flushAssistantPartial(workspaceId)
        break

      case "extension_ui_request": {
        const agent = this.agentByWorkspace.get(workspaceId)
        if (agent && typeof event.id === "string") {
          agent.respondExtensionUiCancel(event.id)
        }
        this.appendWorkspaceLog(workspaceId, "[system] Agent requested interactive extension input; auto-cancelled.")
        break
      }
    }

    this.reloadWorkspaces(this.selectedWorkspaceId)
    this.refreshStatusPanel()
    this.refreshLogsPanel()
    this.refreshTerminalPanel()
    this.emitSnapshot()
  }

  private appendAssistantStream(workspaceId: number, delta: string) {
    const current = this.assistantPartialByWorkspace.get(workspaceId) ?? ""
    const combined = current + delta
    const parts = combined.split(/\r?\n/)

    for (let i = 0; i < parts.length - 1; i++) {
      const line = parts[i]
      if (line.length > 0) {
        this.appendWorkspaceLog(workspaceId, line)
      }
    }

    const remainder = parts[parts.length - 1] ?? ""
    this.assistantPartialByWorkspace.set(workspaceId, remainder)
  }

  private appendThinkingStream(workspaceId: number, delta: string) {
    const current = this.thinkingPartialByWorkspace.get(workspaceId) ?? ""
    const combined = current + delta
    const parts = combined.split(/\r?\n/)

    for (let i = 0; i < parts.length - 1; i++) {
      const line = parts[i]
      if (line.length > 0) {
        this.appendWorkspaceLog(workspaceId, `[thinking] ${line}`)
      }
    }

    const remainder = parts[parts.length - 1] ?? ""
    this.thinkingPartialByWorkspace.set(workspaceId, remainder)
  }

  private flushThinkingPartial(workspaceId: number) {
    const partial = this.thinkingPartialByWorkspace.get(workspaceId)
    if (partial && partial.trim().length > 0) {
      this.appendWorkspaceLog(workspaceId, `[thinking] ${partial}`)
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

  private reloadRepos(preferredRepoId?: number | null) {
    this.repos = this.store.listRepos()

    if (this.repos.length === 0) {
      this.selectedRepoId = null
      this.repoOptions = []
      this.repoSelectedIndex = 0
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
  }

  private reloadWorkspaces(preferredWorkspaceId?: number | null) {
    if (!this.selectedRepoId) {
      this.workspaces = []
      this.selectedWorkspaceId = null
      this.workspaceOptions = []
      this.workspaceSelectedIndex = 0
      return
    }

    this.workspaces = this.store.listWorkspaces(this.selectedRepoId)

    if (this.workspaces.length === 0) {
      this.selectedWorkspaceId = null
      this.workspaceOptions = []
      this.workspaceSelectedIndex = 0
      return
    }

    const keep = preferredWorkspaceId ?? this.selectedWorkspaceId
    const selected = keep ? this.workspaces.find((workspace) => workspace.id === keep) : null
    this.selectedWorkspaceId = selected ? selected.id : this.workspaces[0].id

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

    this.workspaceSelectedIndex = Math.max(
      0,
      this.workspaceOptions.findIndex((option) => Number(option.value) === this.selectedWorkspaceId),
    )
  }

  private getSelectedWorkspace(): WorkspaceRecord | null {
    if (!this.selectedWorkspaceId) return null
    return this.store.getWorkspaceById(this.selectedWorkspaceId)
  }

  private appendGlobalLog(message: string) {
    this.appendLog(GLOBAL_LOG_STREAM_ID, message)
  }

  private appendWorkspaceLog(workspaceId: number, message: string) {
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

    let changedCount = 0
    if (workspace) {
      try {
        changedCount = getChangedFiles(workspace.worktreePath).length
      } catch {
        changedCount = 0
      }
    }

    const runState = workspace && this.runProcessByWorkspace.has(workspace.id) ? "running" : "idle"
    const mergeState =
      changedCount > 0 && runState === "idle" ? "Ready to merge" : changedCount > 0 ? "Changes pending" : "No changes yet"

    this.headerText = workspace
      ? `${repo?.name ?? "repo"}/${workspace.name} · ${workspace.branch} · mode=${this.sendMode} · ${mergeState}`
      : `Pi Conductor · select a repo/workspace · mode=${this.sendMode}`

    const statusLines = [
      `repo       ${repo ? `${repo.name} (#${repo.id})` : "<none>"}`,
      `workspace  ${workspace ? `${workspace.name} (#${workspace.id})` : "<none>"}`,
      `branch     ${workspace?.branch ?? "<none>"}`,
      `agent      ${agent?.status ?? "stopped"}${agent?.pid ? ` (pid ${agent.pid})` : ""}`,
      `run        ${runState}`,
      `changes    ${changedCount} files · ${mergeState}`,
    ]

    this.statusText = statusLines.join("\n")
    this.conversationTabsText = workspace
      ? ` All changes · ${workspace.name} · ${workspace.branch}`
      : " All changes · Review branch changes · Debugging"
    this.footerText = `repos=${this.repos.length} workspaces=${this.workspaces.length} · data=${this.config.dataDir} · pi=${this.config.piCommand}`
  }

  private stripTimestamp(line: string): string {
    return line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "")
  }

  private toConversationMarkdown(lines: string[]): string {
    if (lines.length === 0) {
      return DEFAULT_CONVERSATION
    }

    const rendered: string[] = []
    let pendingAssistant: string[] = []

    const flushAssistant = () => {
      if (pendingAssistant.length === 0) return
      rendered.push(`### Pi\n\n${pendingAssistant.join("\n")}`)
      pendingAssistant = []
    }

    const recent = lines.slice(-300)
    for (const rawLine of recent) {
      const line = this.stripTimestamp(rawLine)
      if (!line.trim()) continue

      if (line.startsWith("[you/")) {
        flushAssistant()
        const content = line.replace(/^\[you\/[\w_\-]+\]\s*/, "")
        rendered.push(`### You\n\n${content}`)
        continue
      }

      if (line.startsWith("[thinking]")) {
        flushAssistant()
        const content = line.replace(/^\[thinking\]\s*/, "")
        rendered.push(`> 💭 **Thinking**\n>\n> ${content}`)
        continue
      }

      if (line.startsWith("[tool]")) {
        flushAssistant()
        const content = line.replace(/^\[tool\]\s*/, "")
        rendered.push(`- ⚙️ ${content}`)
        continue
      }

      if (line.startsWith("[agent]")) {
        continue
      }

      if (line.startsWith("[pi:stderr]")) {
        flushAssistant()
        const content = line.replace(/^\[pi:stderr\]\s*/, "")
        rendered.push(`> ⚠️ ${content}`)
        continue
      }

      if (line.startsWith("ERROR:")) {
        flushAssistant()
        rendered.push(`> ❌ ${line}`)
        continue
      }

      if (line.startsWith("[system]")) {
        flushAssistant()
        const content = line.replace(/^\[system\]\s*/, "")
        rendered.push(`> ℹ️ ${content}`)
        continue
      }

      if (line.startsWith("[extension-ui]")) {
        flushAssistant()
        rendered.push(`> ℹ️ Agent requested extension UI input.`)
        continue
      }

      pendingAssistant.push(line)
    }

    flushAssistant()

    return rendered.join("\n\n") || DEFAULT_CONVERSATION
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

  private refreshDiffPanel() {
    const workspace = this.getSelectedWorkspace()
    if (!workspace) {
      this.diffText = "No workspace selected."
      return
    }

    try {
      const stats = getChangedFileStats(workspace.worktreePath)
      if (stats.length === 0) {
        this.diffText = "Working tree clean."
        return
      }

      const lines = stats.slice(0, 120).map((entry) => {
        const plus = entry.added === null ? "--" : `+${entry.added}`
        const minus = entry.removed === null ? "--" : `-${entry.removed}`
        return `${plus.padStart(5)} ${minus.padStart(5)}  ${entry.path}`
      })

      const extra = stats.length > lines.length ? `\n... ${stats.length - lines.length} more files` : ""
      this.diffText = `Changes ${stats.length}\n\n${lines.join("\n")}${extra}`
    } catch (error) {
      this.diffText = `Failed to read changes: ${safeErr(error)}`
    }
  }

  async shutdown() {
    if (this.isShuttingDown) return
    this.isShuttingDown = true

    this.appendGlobalLog("Shutting down...")
    this.refreshLogsPanel()
    this.emitSnapshot()

    for (const [workspaceId, process] of this.runProcessByWorkspace.entries()) {
      process.kill("SIGTERM")
      this.runProcessByWorkspace.delete(workspaceId)
    }

    for (const [workspaceId] of this.agentByWorkspace.entries()) {
      await this.stopAgent(workspaceId)
    }

    this.store.close()
    this.root.unmount()
    this.renderer.destroy()
    process.exit(0)
  }
}

function PiConductorView({ app }: { app: PiConductorApp }) {
  const snapshot = useSyncExternalStore(app.subscribe, app.getSnapshot, app.getSnapshot)
  const [inputValue, setInputValue] = useState("")
  const [focusTarget, setFocusTarget] = useState<FocusTarget>("input")

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

  useEffect(() => {
    if (snapshot.leftSidebarCollapsed && (focusTarget === "repo" || focusTarget === "workspace")) {
      setFocusTarget("input")
    }
  }, [snapshot.leftSidebarCollapsed, focusTarget])

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "1") {
      key.preventDefault()
      if (snapshot.leftSidebarCollapsed) {
        app.toggleLeftSidebar()
      }
      setFocusTarget("repo")
      return
    }

    if (key.ctrl && key.name === "2") {
      key.preventDefault()
      if (snapshot.leftSidebarCollapsed) {
        app.toggleLeftSidebar()
      }
      setFocusTarget("workspace")
      return
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
      if (snapshot.leftSidebarCollapsed) {
        setFocusTarget("input")
        return
      }

      setFocusTarget((prev) => {
        if (prev === "input") return "repo"
        if (prev === "repo") return "workspace"
        return "input"
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

  const leftToggleLabel = snapshot.leftSidebarCollapsed ? "[+] Left" : "[-] Left"
  const rightToggleLabel = snapshot.rightSidebarCollapsed ? "Right [+]" : "Right [-]"

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
        id="pc-topbar"
        height={2}
        border
        borderStyle="single"
        borderColor="#2a3344"
        backgroundColor="#0f141d"
        style={{
          flexShrink: 0,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <box
          id="pc-left-toggle-btn"
          width={10}
          height={1}
          backgroundColor={snapshot.leftSidebarCollapsed ? "#2f3b52" : "#1d2840"}
          onMouseDown={() => {
            app.toggleLeftSidebar()
          }}
          style={{
            flexShrink: 0,
            marginRight: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <text id="pc-left-toggle" content={leftToggleLabel} fg="#bfdbfe" selectable={false} />
        </box>

        <text
          id="pc-header-text"
          content={snapshot.headerText}
          fg="#d1d5db"
          wrapMode="none"
          style={{
            flexGrow: 1,
            flexShrink: 1,
          }}
        />

        <box
          id="pc-right-toggle-btn"
          width={11}
          height={1}
          backgroundColor={snapshot.rightSidebarCollapsed ? "#2f3b52" : "#1d2840"}
          onMouseDown={() => {
            app.toggleRightSidebar()
          }}
          style={{
            flexShrink: 0,
            marginLeft: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <text id="pc-right-toggle" content={rightToggleLabel} fg="#bfdbfe" selectable={false} />
        </box>
      </box>

      <box
        id="pc-body"
        shouldFill
        style={{
          flexDirection: "row",
          flexGrow: 1,
          flexShrink: 1,
          marginTop: 1,
        }}
      >
        {!snapshot.leftSidebarCollapsed && (
          <box
            id="pc-sidebar"
            width={36}
            border
            borderStyle="single"
            borderColor="#2a3344"
            backgroundColor="#11151f"
            shouldFill
            style={{
              flexDirection: "column",
              marginRight: 1,
            }}
          >
            <text id="pc-nav-title" content=" Workspace Navigator" fg="#e5e7eb" style={{ flexShrink: 0 }} />

            <box
              id="pc-repo-box"
              title="Repositories"
              titleAlignment="left"
              border
              borderStyle="single"
              borderColor="#3a4459"
              focusedBorderColor="#60a5fa"
              height={10}
              shouldFill
              style={{
                marginTop: 1,
                marginBottom: 1,
                flexShrink: 0,
              }}
            >
              <select
                id="pc-repo-select"
                focused={focusTarget === "repo"}
                options={snapshot.repoOptions}
                selectedIndex={snapshot.repoSelectedIndex}
                height="100%"
                showDescription
                wrapSelection
                selectedBackgroundColor="#1d4ed8"
                selectedTextColor="#e2e8f0"
                textColor="#cbd5e1"
                descriptionColor="#64748b"
                selectedDescriptionColor="#93c5fd"
                showScrollIndicator
                onChange={(_, option) => {
                  app.selectRepoOption(option)
                }}
              />
            </box>

            <box
              id="pc-workspace-box"
              title="Workspaces"
              titleAlignment="left"
              border
              borderStyle="single"
              borderColor="#3a4459"
              focusedBorderColor="#34d399"
              shouldFill
              style={{
                flexGrow: 1,
              }}
            >
              <select
                id="pc-workspace-select"
                focused={focusTarget === "workspace"}
                options={snapshot.workspaceOptions}
                selectedIndex={snapshot.workspaceSelectedIndex}
                height="100%"
                showDescription
                wrapSelection
                selectedBackgroundColor="#065f46"
                selectedTextColor="#ecfeff"
                textColor="#cbd5e1"
                descriptionColor="#64748b"
                selectedDescriptionColor="#a7f3d0"
                showScrollIndicator
                onChange={(_, option) => {
                  app.selectWorkspaceOption(option)
                }}
              />
            </box>
          </box>
        )}

        <box
          id="pc-center"
          shouldFill
          style={{
            flexDirection: "column",
            flexGrow: 2,
            marginRight: snapshot.rightSidebarCollapsed ? 0 : 1,
          }}
        >
          <box
            id="pc-conversation-box"
            title="Conversation"
            titleAlignment="left"
            border
            borderStyle="single"
            borderColor="#2a3344"
            backgroundColor="#100f13"
            shouldFill
            style={{
              flexDirection: "column",
              flexGrow: 1,
              marginBottom: 1,
            }}
          >
            <text
              id="pc-conversation-tabs"
              content={snapshot.conversationTabsText}
              fg="#9ca3af"
              style={{
                flexShrink: 0,
                marginBottom: 1,
              }}
            />

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
                content={snapshot.conversationMarkdown}
                syntaxStyle={conversationSyntaxStyle}
                conceal
                width="100%"
              />
            </scrollbox>
          </box>

          <box
            id="pc-input-box"
            title="Composer"
            titleAlignment="left"
            border
            borderStyle="single"
            borderColor="#4b5563"
            focusedBorderColor="#f59e0b"
            height={5}
            backgroundColor="#151922"
            shouldFill
            style={{
              flexShrink: 0,
              paddingTop: 1,
            }}
          >
            <text
              id="pc-compose-hint"
              content=" /help · /mode prompt|steer|follow_up · plain text sends to selected workspace"
              fg="#9ca3af"
              style={{
                flexShrink: 0,
              }}
            />

            <input
              id="pc-input"
              focused={focusTarget === "input"}
              placeholder="Ask the selected Pi workspace to do something…"
              value={inputValue}
              onInput={(value) => {
                setInputValue(value)
              }}
              onSubmit={(value) => {
                const submitted = typeof value === "string" ? value : inputValue
                setInputValue("")
                void app.submitInput(submitted)
              }}
              textColor="#f9fafb"
              focusedTextColor="#ffffff"
              placeholderColor="#6b7280"
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
              cursorColor="#f9fafb"
              width="100%"
            />
          </box>
        </box>

        {!snapshot.rightSidebarCollapsed && (
          <box
            id="pc-right"
            width={52}
            border
            borderStyle="single"
            borderColor="#2a3344"
            backgroundColor="#111013"
            shouldFill
            style={{
              flexDirection: "column",
            }}
          >
            <box
              id="pc-status-box"
              title="Workspace Status"
              titleAlignment="left"
              border
              borderStyle="single"
              borderColor="#3a4459"
              height={8}
              shouldFill
              style={{
                marginBottom: 1,
                flexShrink: 0,
              }}
            >
              <text id="pc-status-text" content={snapshot.statusText} fg="#d1d5db" wrapMode="word" />
            </box>

            <box
              id="pc-diff-box"
              title="Changes"
              titleAlignment="left"
              border
              borderStyle="single"
              borderColor="#3a4459"
              shouldFill
              style={{
                flexGrow: 1,
                marginBottom: 1,
              }}
            >
              <text
                id="pc-diff-text"
                content={snapshot.diffText}
                fg="#d1d5db"
                wrapMode="none"
                style={{
                  flexGrow: 1,
                }}
              />
            </box>

            <box
              id="pc-terminal-box"
              title="Run Terminal"
              titleAlignment="left"
              border
              borderStyle="single"
              borderColor="#3a4459"
              height={10}
              shouldFill
              style={{
                flexShrink: 0,
              }}
            >
              <text
                id="pc-terminal-text"
                content={snapshot.terminalText}
                fg="#a7f3d0"
                wrapMode="none"
                style={{
                  flexGrow: 1,
                }}
              />
            </box>
          </box>
        )}
      </box>

      <box
        id="pc-footer"
        border={false}
        height={1}
        style={{
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        <text id="pc-footer-text" content={snapshot.footerText} fg="#94a3b8" wrapMode="none" />
      </box>
    </box>
  )
}
