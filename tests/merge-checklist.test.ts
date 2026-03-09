import { describe, expect, it } from "vitest"
import {
  createChecklistItemKey,
  evaluateMergeChecklist,
  findChecklistItemByNeedle,
  mergeChecklistSummaryLabel,
  toMergeChecklistMarkdown,
} from "../src/workspace/merge-checklist"
import type { MergeChecklistItemRecord } from "../src/core/types"

function manualItem(overrides: Partial<MergeChecklistItemRecord> = {}): MergeChecklistItemRecord {
  return {
    workspaceId: 1,
    itemKey: "docs-updated",
    label: "docs updated",
    required: true,
    completed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("createChecklistItemKey", () => {
  it("normalizes labels and deduplicates keys", () => {
    expect(createChecklistItemKey("Docs updated!")).toBe("docs-updated")
    expect(createChecklistItemKey("Docs updated!", ["docs-updated"])).toBe("docs-updated-2")
  })
})

describe("evaluateMergeChecklist", () => {
  it("blocks when required manual items are incomplete", () => {
    const evaluation = evaluateMergeChecklist({
      runCount: 0,
      changedCount: 3,
      testState: { status: "pass", startedAt: "x", finishedAt: "y", exitCode: 0 },
      diffFingerprint: "abc",
      reviewedDiffFingerprint: "abc",
      turnInFlight: false,
      manualItems: [manualItem()],
    })

    expect(evaluation.blocked).toBe(true)
    expect(evaluation.pendingRequired.some((item) => item.key === "docs-updated")).toBe(true)
    expect(mergeChecklistSummaryLabel(evaluation)).toBe("blocked · 1 pending")
  })

  it("passes when required items are complete", () => {
    const evaluation = evaluateMergeChecklist({
      runCount: 0,
      changedCount: 2,
      testState: { status: "pass", startedAt: "x", finishedAt: "y", exitCode: 0 },
      diffFingerprint: "abc",
      reviewedDiffFingerprint: "abc",
      turnInFlight: false,
      manualItems: [manualItem({ completed: true })],
    })

    expect(evaluation.blocked).toBe(false)
    expect(mergeChecklistSummaryLabel(evaluation)).toBe("clear")
  })

  it("fails auto checks when tests and diff are incomplete", () => {
    const evaluation = evaluateMergeChecklist({
      runCount: 1,
      changedCount: 2,
      testState: { status: "fail", startedAt: "x", finishedAt: "y", exitCode: 1 },
      diffFingerprint: "abc",
      reviewedDiffFingerprint: "def",
      turnInFlight: true,
      manualItems: [],
    })

    const pendingKeys = new Set(evaluation.pendingRequired.map((item) => item.key))
    expect(pendingKeys.has("run-idle")).toBe(true)
    expect(pendingKeys.has("tests-pass")).toBe(true)
    expect(pendingKeys.has("diff-reviewed")).toBe(true)
    expect(pendingKeys.has("agent-idle")).toBe(true)
  })
})

describe("findChecklistItemByNeedle", () => {
  it("finds by key and partial label", () => {
    const evaluation = evaluateMergeChecklist({
      runCount: 0,
      changedCount: 1,
      testState: { status: "pass", startedAt: "x", finishedAt: "y", exitCode: 0 },
      diffFingerprint: "abc",
      reviewedDiffFingerprint: "abc",
      turnInFlight: false,
      manualItems: [manualItem({ label: "docs updated", completed: true })],
    })

    expect(findChecklistItemByNeedle(evaluation.items, "docs-updated")?.label).toBe("docs updated")
    expect(findChecklistItemByNeedle(evaluation.items, "docs")?.label).toBe("docs updated")
  })
})

describe("toMergeChecklistMarkdown", () => {
  it("renders checklist and command hints", () => {
    const evaluation = evaluateMergeChecklist({
      runCount: 0,
      changedCount: 1,
      testState: { status: "pass", startedAt: "x", finishedAt: "y", exitCode: 0 },
      diffFingerprint: "abc",
      reviewedDiffFingerprint: "abc",
      turnInFlight: false,
      manualItems: [manualItem({ completed: true })],
    })

    const markdown = toMergeChecklistMarkdown("test-workspace", evaluation)
    expect(markdown).toContain("Merge checklist")
    expect(markdown).toContain("/checklist add")
    expect(markdown).toContain("Status: **clear**")
  })
})
