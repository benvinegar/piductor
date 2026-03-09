type KillFn = (pid: number, signal?: NodeJS.Signals | number) => void

interface KillProcessByPidOptions {
  platform?: NodeJS.Platform
  killFn?: KillFn
  signal?: NodeJS.Signals
}

function isMissingProcessError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ESRCH")
}

export function killProcessByPid(pid: number, options: KillProcessByPidOptions = {}): "killed" | "missing" | "failed" {
  const platform = options.platform ?? process.platform
  const killFn = options.killFn ?? process.kill
  const signal = options.signal ?? "SIGKILL"

  if (platform !== "win32") {
    try {
      killFn(-pid, signal)
      return "killed"
    } catch (error) {
      if (!isMissingProcessError(error)) {
        // non-ESRCH failures may happen when group kill isn't supported; fall through to direct pid kill
      }
    }
  }

  try {
    killFn(pid, signal)
    return "killed"
  } catch (error) {
    if (isMissingProcessError(error)) {
      return "missing"
    }
    return "failed"
  }
}
