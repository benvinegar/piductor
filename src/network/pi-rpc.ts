import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

export interface RpcResponse {
  id?: string
  type: "response"
  command: string
  success: boolean
  data?: any
  error?: string
}

export interface RpcEvent {
  type: string
  [key: string]: any
}

export interface PiRpcProcessOptions {
  piCommand: string
  cwd: string
  model?: string
}

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PiRpcProcess {
  private readonly options: PiRpcProcessOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Set<(event: RpcEvent) => void>()
  private stderrListeners = new Set<(line: string) => void>()
  private lineBuffer = ""
  private stderrBuffer = ""
  private nextRequestId = 1

  status: "stopped" | "starting" | "running" | "error" = "stopped"

  constructor(options: PiRpcProcessOptions) {
    this.options = options
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener)
    return () => this.stderrListeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.child) return

    const args = ["--mode", "rpc"]
    if (this.options.model) {
      args.push("--model", this.options.model)
    }

    this.status = "starting"
    this.child = spawn(this.options.piCommand, args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })

    this.child.stdout.setEncoding("utf8")
    this.child.stderr.setEncoding("utf8")

    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk))
    this.child.stderr.on("data", (chunk: string) => this.handleStderr(chunk))

    this.child.on("error", (error) => {
      this.status = "error"
      this.emitEvent({ type: "process_error", error: String(error) })
      this.rejectAllPending(new Error(String(error)))
    })

    this.child.on("close", (code, signal) => {
      this.status = code === 0 ? "stopped" : "error"
      this.emitEvent({ type: "process_exit", code, signal })
      this.rejectAllPending(new Error(`Pi process exited (code=${code}, signal=${signal ?? "none"})`))
      this.child = null
    })

    this.status = "running"
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.status = "stopped"
      return
    }

    try {
      await this.sendCommand({ type: "abort" }, 2_000)
    } catch {
      // no-op, process may already be shutting down
    }

    const child = this.child
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // ignore
        }
        finish()
      }, 1_000)

      child.once("close", () => {
        clearTimeout(timer)
        finish()
      })

      try {
        child.kill("SIGTERM")
      } catch {
        clearTimeout(timer)
        finish()
      }
    })

    this.child = null
    this.status = "stopped"
  }

  async kill(): Promise<void> {
    if (!this.child) {
      this.status = "stopped"
      return
    }

    const child = this.child
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }

      const timer = setTimeout(() => {
        finish()
      }, 500)

      child.once("close", () => {
        clearTimeout(timer)
        finish()
      })

      try {
        child.kill("SIGKILL")
      } catch {
        clearTimeout(timer)
        finish()
      }
    })

    this.child = null
    this.status = "stopped"
  }

  async prompt(message: string): Promise<void> {
    await this.sendExpectSuccess({ type: "prompt", message })
  }

  async steer(message: string): Promise<void> {
    await this.sendExpectSuccess({ type: "steer", message })
  }

  async followUp(message: string): Promise<void> {
    await this.sendExpectSuccess({ type: "follow_up", message })
  }

  async abort(): Promise<void> {
    await this.sendExpectSuccess({ type: "abort" })
  }

  async getState(): Promise<any> {
    const response = await this.sendExpectSuccess({ type: "get_state" })
    return response.data
  }

  async getSessionStats(): Promise<any> {
    const response = await this.sendExpectSuccess({ type: "get_session_stats" })
    return response.data
  }

  async getMessages(): Promise<any[]> {
    const response = await this.sendExpectSuccess({ type: "get_messages" })
    return Array.isArray(response.data?.messages) ? response.data.messages : []
  }

  async getLastAssistantText(): Promise<string | null> {
    const response = await this.sendExpectSuccess({ type: "get_last_assistant_text" })
    const text = response.data?.text
    return typeof text === "string" && text.trim().length > 0 ? text : null
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.sendExpectSuccess({ type: "switch_session", sessionPath })
  }

  async getAvailableModels(): Promise<any[]> {
    const response = await this.sendExpectSuccess({ type: "get_available_models" })
    return Array.isArray(response.data?.models) ? response.data.models : []
  }

  async setModel(provider: string, modelId: string): Promise<any> {
    const response = await this.sendExpectSuccess({ type: "set_model", provider, modelId })
    return response.data
  }

  async setSessionName(name: string): Promise<void> {
    await this.sendExpectSuccess({ type: "set_session_name", name })
  }

  respondExtensionUiCancel(requestId: string): void {
    if (!this.child || this.status === "stopped") return

    const payload = {
      type: "extension_ui_response",
      id: requestId,
      cancelled: true,
    }

    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch {
      // ignore write failures during shutdown
    }
  }

  private emitEvent(event: RpcEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private emitStderr(line: string) {
    for (const listener of this.stderrListeners) {
      listener(line)
    }
  }

  private handleStdout(chunk: string) {
    this.lineBuffer += chunk

    while (true) {
      const newlineIndex = this.lineBuffer.indexOf("\n")
      if (newlineIndex === -1) break

      const line = this.lineBuffer.slice(0, newlineIndex).trim()
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1)
      if (!line) continue

      this.handleLine(line)
    }
  }

  private handleStderr(chunk: string) {
    this.stderrBuffer += chunk

    while (true) {
      const newlineIndex = this.stderrBuffer.indexOf("\n")
      if (newlineIndex === -1) break

      const line = this.stderrBuffer.slice(0, newlineIndex).trimEnd()
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1)
      if (line) this.emitStderr(line)
    }
  }

  private handleLine(line: string) {
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      this.emitEvent({ type: "parse_error", raw: line })
      return
    }

    if (parsed.type === "response") {
      const response = parsed as RpcResponse
      if (!response.id) return

      const pending = this.pending.get(response.id)
      if (!pending) return

      clearTimeout(pending.timer)
      this.pending.delete(response.id)
      pending.resolve(response)
      return
    }

    this.emitEvent(parsed)
  }

  private rejectAllPending(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`${error.message} (request ${id})`))
    }
    this.pending.clear()
  }

  private async sendExpectSuccess(command: Record<string, any>, timeoutMs = 15_000): Promise<RpcResponse> {
    const response = await this.sendCommand(command, timeoutMs)
    if (!response.success) {
      throw new Error(response.error || `RPC command failed: ${response.command}`)
    }
    return response
  }

  private sendCommand(command: Record<string, any>, timeoutMs = 15_000): Promise<RpcResponse> {
    if (!this.child || this.status === "stopped") {
      return Promise.reject(new Error("Pi RPC process is not running"))
    }

    const id = `req-${this.nextRequestId++}`
    const payload = { ...command, id }

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC command timed out: ${command.type}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      try {
        this.child!.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(String(error)))
      }
    })
  }
}
