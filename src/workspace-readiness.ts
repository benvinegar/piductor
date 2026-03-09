import type { TestRunState } from "./test-status"

export type WorkspaceReadiness = {
  ready: boolean
  reason: string
}

export function evaluateWorkspaceReadiness(input: {
  runCount: number
  changedCount: number
  testState: TestRunState | null
  diffFingerprint: string
  reviewedDiffFingerprint: string | null
}): WorkspaceReadiness {
  if (input.runCount > 0) {
    return { ready: false, reason: "run in progress" }
  }

  if (input.changedCount === 0) {
    return { ready: false, reason: "no changes" }
  }

  if (!input.testState) {
    return { ready: false, reason: "tests not run" }
  }

  if (input.testState.status === "running") {
    return { ready: false, reason: "tests running" }
  }

  if (input.testState.status === "fail") {
    return { ready: false, reason: "tests failing" }
  }

  if (input.diffFingerprint && input.reviewedDiffFingerprint !== input.diffFingerprint) {
    return { ready: false, reason: "diff not reviewed" }
  }

  return { ready: true, reason: "tests pass + diff reviewed" }
}

export function formatWorkspaceReadinessLabel(readiness: WorkspaceReadiness): string {
  if (readiness.ready) {
    return "ready"
  }

  return `not ready · ${readiness.reason}`
}
