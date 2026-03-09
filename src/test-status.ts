export type TestRunState = {
  status: "running" | "pass" | "fail"
  at: string
  code: number | null
  signal: string | null
}

export function nextTestRunStarted(nowIso: string): TestRunState {
  return {
    status: "running",
    at: nowIso,
    code: null,
    signal: null,
  }
}

export function nextTestRunFinished(code: number | null, signal: string | null, nowIso: string): TestRunState {
  return {
    status: code === 0 ? "pass" : "fail",
    at: nowIso,
    code,
    signal,
  }
}

export function formatTestRunStatus(state: TestRunState | null): string {
  if (!state) {
    return "not run"
  }

  if (state.status === "running") {
    return "running"
  }

  const detail = state.code === null ? `signal=${state.signal ?? "none"}` : `code=${state.code}`
  return `${state.status} (${detail})`
}
