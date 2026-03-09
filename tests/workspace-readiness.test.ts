import { describe, expect, it } from "vitest"
import { evaluateWorkspaceReadiness, formatWorkspaceReadinessLabel } from "../src/workspace/readiness"

describe("evaluateWorkspaceReadiness", () => {
  it("blocks readiness while runs are active", () => {
    expect(
      evaluateWorkspaceReadiness({
        runCount: 1,
        changedCount: 2,
        testState: { status: "pass", at: "2026-03-09", code: 0, signal: null },
        diffFingerprint: "abc",
        reviewedDiffFingerprint: "abc",
      }),
    ).toEqual({ ready: false, reason: "run in progress" })
  })

  it("requires changes", () => {
    expect(
      evaluateWorkspaceReadiness({
        runCount: 0,
        changedCount: 0,
        testState: { status: "pass", at: "2026-03-09", code: 0, signal: null },
        diffFingerprint: "",
        reviewedDiffFingerprint: null,
      }),
    ).toEqual({ ready: false, reason: "no changes" })
  })

  it("requires tests to run and pass", () => {
    expect(
      evaluateWorkspaceReadiness({
        runCount: 0,
        changedCount: 2,
        testState: null,
        diffFingerprint: "abc",
        reviewedDiffFingerprint: "abc",
      }),
    ).toEqual({ ready: false, reason: "tests not run" })

    expect(
      evaluateWorkspaceReadiness({
        runCount: 0,
        changedCount: 2,
        testState: { status: "running", at: "2026-03-09", code: null, signal: null },
        diffFingerprint: "abc",
        reviewedDiffFingerprint: "abc",
      }),
    ).toEqual({ ready: false, reason: "tests running" })

    expect(
      evaluateWorkspaceReadiness({
        runCount: 0,
        changedCount: 2,
        testState: { status: "fail", at: "2026-03-09", code: 1, signal: null },
        diffFingerprint: "abc",
        reviewedDiffFingerprint: "abc",
      }),
    ).toEqual({ ready: false, reason: "tests failing" })
  })

  it("requires reviewed diff fingerprint when changes exist", () => {
    expect(
      evaluateWorkspaceReadiness({
        runCount: 0,
        changedCount: 2,
        testState: { status: "pass", at: "2026-03-09", code: 0, signal: null },
        diffFingerprint: "abc",
        reviewedDiffFingerprint: null,
      }),
    ).toEqual({ ready: false, reason: "diff not reviewed" })
  })

  it("returns ready once runs idle, tests pass, and diff reviewed", () => {
    expect(
      evaluateWorkspaceReadiness({
        runCount: 0,
        changedCount: 2,
        testState: { status: "pass", at: "2026-03-09", code: 0, signal: null },
        diffFingerprint: "abc",
        reviewedDiffFingerprint: "abc",
      }),
    ).toEqual({ ready: true, reason: "tests pass + diff reviewed" })
  })
})

describe("formatWorkspaceReadinessLabel", () => {
  it("formats ready/not-ready labels", () => {
    expect(formatWorkspaceReadinessLabel({ ready: true, reason: "tests pass + diff reviewed" })).toBe("ready")
    expect(formatWorkspaceReadinessLabel({ ready: false, reason: "tests failing" })).toBe("not ready · tests failing")
  })
})
