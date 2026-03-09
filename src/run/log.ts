export type RunLogSource = "meta" | "cmd" | "out" | "err" | "exit"

export function formatRunLogLine(runId: number, source: RunLogSource, message: string): string {
  return `[run#${runId}/${source}] ${message}`
}

export function formatRunExitSummary(code: number | null, signal: string | null): string {
  return `exited code=${code ?? "null"} signal=${signal ?? "none"}`
}
