import type { MergeChecklistItemRecord } from "../core/types"
import type { TestRunState } from "../run/test-status"

export type MergeChecklistItem = {
  key: string
  label: string
  required: boolean
  completed: boolean
  source: "auto" | "manual"
}

export type MergeChecklistEvaluation = {
  items: MergeChecklistItem[]
  pendingRequired: MergeChecklistItem[]
  blocked: boolean
}

export function createChecklistItemKey(label: string, existingKeys: Iterable<string> = []): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"

  const existing = new Set(Array.from(existingKeys).map((value) => value.trim().toLowerCase()))
  if (!existing.has(base)) {
    return base
  }

  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${base}-${index}`
    if (!existing.has(candidate)) {
      return candidate
    }
  }

  return `${base}-${Date.now().toString(36).slice(-4)}`
}

export function evaluateMergeChecklist(input: {
  runCount: number
  changedCount: number
  testState: TestRunState | null
  diffFingerprint: string
  reviewedDiffFingerprint: string | null
  turnInFlight: boolean
  manualItems: MergeChecklistItemRecord[]
}): MergeChecklistEvaluation {
  const hasChanges = input.changedCount > 0
  const runIdle = input.runCount === 0
  const testsPass = input.testState?.status === "pass"
  const diffReviewed = hasChanges
    ? Boolean(input.diffFingerprint) && input.reviewedDiffFingerprint === input.diffFingerprint
    : true
  const agentIdle = !input.turnInFlight

  const autoItems: MergeChecklistItem[] = [
    { key: "changes-present", label: "workspace has changes", required: true, completed: hasChanges, source: "auto" },
    { key: "run-idle", label: "run processes idle", required: true, completed: runIdle, source: "auto" },
    { key: "tests-pass", label: "tests passing", required: true, completed: testsPass, source: "auto" },
    { key: "diff-reviewed", label: "diff reviewed", required: true, completed: diffReviewed, source: "auto" },
    { key: "agent-idle", label: "agent turn idle", required: true, completed: agentIdle, source: "auto" },
  ]

  const manualItems: MergeChecklistItem[] = input.manualItems.map((item) => ({
    key: item.itemKey,
    label: item.label,
    required: item.required,
    completed: item.completed,
    source: "manual",
  }))

  const items = [...autoItems, ...manualItems]
  const pendingRequired = items.filter((item) => item.required && !item.completed)

  return {
    items,
    pendingRequired,
    blocked: pendingRequired.length > 0,
  }
}

export function mergeChecklistSummaryLabel(evaluation: MergeChecklistEvaluation): string {
  if (!evaluation.blocked) {
    return "clear"
  }

  return `blocked · ${evaluation.pendingRequired.length} pending`
}

export function toMergeChecklistMarkdown(workspaceLabel: string, evaluation: MergeChecklistEvaluation): string {
  const lines = [`## Merge checklist · ${workspaceLabel}`, ""]

  const required = evaluation.items.filter((item) => item.required)
  const optional = evaluation.items.filter((item) => !item.required)

  lines.push("### Required")
  if (required.length === 0) {
    lines.push("- _(none)_")
  } else {
    for (const item of required) {
      const mark = item.completed ? "x" : " "
      const source = item.source === "manual" ? "manual" : "auto"
      lines.push(`- [${mark}] ${item.label}  _(key: ${item.key} · ${source})_`)
    }
  }

  if (optional.length > 0) {
    lines.push("")
    lines.push("### Optional")
    for (const item of optional) {
      const mark = item.completed ? "x" : " "
      lines.push(`- [${mark}] ${item.label}  _(key: ${item.key} · manual)_`)
    }
  }

  lines.push("")
  lines.push(`Status: **${mergeChecklistSummaryLabel(evaluation)}**`)
  lines.push("")
  lines.push("Commands:")
  lines.push("- `/checklist add <label>`")
  lines.push("- `/checklist done <key|label>`")
  lines.push("- `/checklist undone <key|label>`")
  lines.push("- `/checklist remove <key|label>`")
  lines.push("- `/checklist clear`")

  return lines.join("\n")
}

export function findChecklistItemByNeedle(items: MergeChecklistItem[], needle: string): MergeChecklistItem | null {
  const normalized = needle.trim().toLowerCase()
  if (!normalized) return null

  return (
    items.find((item) => item.key.toLowerCase() === normalized) ||
    items.find((item) => item.label.toLowerCase() === normalized) ||
    items.find((item) => item.label.toLowerCase().includes(normalized)) ||
    null
  )
}
