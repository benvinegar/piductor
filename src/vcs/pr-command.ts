export interface ParsedPrCreateArgs {
  dryRun: boolean
}

export type PrMergeMethod = "merge" | "squash" | "rebase"

export interface ParsedPrMergeArgs {
  dryRun: boolean
  method: PrMergeMethod
  deleteBranch: boolean
}

export type PrCheckStatus = "pass" | "fail" | "pending" | "skipped" | "unknown"

export interface PrCheckRollupRecord {
  name: string
  status: PrCheckStatus
  rawState: string
  description: string | null
  url: string | null
}

export interface PrViewRecord {
  number: number | null
  url: string | null
  title: string | null
  state: string | null
  isDraft: boolean
  mergeStateStatus: string | null
  reviewDecision: string | null
  headRefName: string | null
  baseRefName: string | null
  checks: PrCheckRollupRecord[]
}

export interface PrCheckSummary {
  pass: number
  fail: number
  pending: number
  skipped: number
  unknown: number
  label: string
}

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function parsePrCreateArgs(args: string[]): ParsedPrCreateArgs | null {
  let dryRun = false

  for (const token of args) {
    if (token === "--dry-run") {
      dryRun = true
      continue
    }

    return null
  }

  return { dryRun }
}

export function parsePrMergeArgs(args: string[]): ParsedPrMergeArgs | null {
  let dryRun = false
  let deleteBranch = false
  let method: PrMergeMethod = "merge"

  for (const token of args) {
    if (token === "--dry-run") {
      dryRun = true
      continue
    }

    if (token === "--delete-branch") {
      deleteBranch = true
      continue
    }

    if (token === "--merge") {
      method = "merge"
      continue
    }

    if (token === "--squash") {
      method = "squash"
      continue
    }

    if (token === "--rebase") {
      method = "rebase"
      continue
    }

    return null
  }

  return { dryRun, method, deleteBranch }
}

export function classifyPrCheckState(rawState: string): PrCheckStatus {
  const normalized = rawState.trim().toUpperCase()

  if (["SUCCESS", "NEUTRAL"].includes(normalized)) {
    return "pass"
  }

  if (["SKIPPED"].includes(normalized)) {
    return "skipped"
  }

  if (["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(normalized)) {
    return "fail"
  }

  if (["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING"].includes(normalized)) {
    return "pending"
  }

  return "unknown"
}

function parsePrCheckRecord(value: unknown): PrCheckRollupRecord {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const checkRunStatus = toOptionalString(row.status)
  const checkRunConclusion = toOptionalString(row.conclusion)
  const contextState = toOptionalString(row.state)

  const rawStateCandidate =
    checkRunConclusion ??
    (checkRunStatus && checkRunStatus.toUpperCase() !== "COMPLETED" ? checkRunStatus : null) ??
    contextState ??
    checkRunStatus ??
    "UNKNOWN"

  const name =
    toOptionalString(row.name) ??
    toOptionalString(row.context) ??
    toOptionalString(row.workflowName) ??
    "check"

  return {
    name,
    status: classifyPrCheckState(rawStateCandidate),
    rawState: rawStateCandidate,
    description: toOptionalString(row.description),
    url: toOptionalString(row.detailsUrl) ?? toOptionalString(row.targetUrl),
  }
}

export function parsePrViewJson(text: string): PrViewRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== "object") {
    return null
  }

  const row = parsed as Record<string, unknown>
  const rollup = Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup : []

  return {
    number: typeof row.number === "number" && Number.isFinite(row.number) ? row.number : null,
    url: toOptionalString(row.url),
    title: toOptionalString(row.title),
    state: toOptionalString(row.state),
    isDraft: row.isDraft === true,
    mergeStateStatus: toOptionalString(row.mergeStateStatus),
    reviewDecision: toOptionalString(row.reviewDecision),
    headRefName: toOptionalString(row.headRefName),
    baseRefName: toOptionalString(row.baseRefName),
    checks: rollup.map(parsePrCheckRecord),
  }
}

export function summarizePrChecks(checks: PrCheckRollupRecord[]): PrCheckSummary {
  const summary: PrCheckSummary = {
    pass: 0,
    fail: 0,
    pending: 0,
    skipped: 0,
    unknown: 0,
    label: "no checks",
  }

  if (checks.length === 0) {
    return summary
  }

  for (const check of checks) {
    switch (check.status) {
      case "pass":
        summary.pass += 1
        break
      case "fail":
        summary.fail += 1
        break
      case "pending":
        summary.pending += 1
        break
      case "skipped":
        summary.skipped += 1
        break
      default:
        summary.unknown += 1
        break
    }
  }

  const parts = [
    summary.pass > 0 ? `${summary.pass} pass` : "",
    summary.fail > 0 ? `${summary.fail} fail` : "",
    summary.pending > 0 ? `${summary.pending} pending` : "",
    summary.skipped > 0 ? `${summary.skipped} skipped` : "",
    summary.unknown > 0 ? `${summary.unknown} unknown` : "",
  ].filter(Boolean)

  summary.label = parts.length > 0 ? parts.join(" · ") : "no checks"
  return summary
}

export function toPrStatusMarkdown(workspaceLabel: string, view: PrViewRecord): string {
  const checkSummary = summarizePrChecks(view.checks)
  const lines = [`## Pull request · ${workspaceLabel}`, ""]

  lines.push(`- URL: ${view.url ?? "<unknown>"}`)
  lines.push(`- State: ${view.state ?? "<unknown>"}${view.isDraft ? " (draft)" : ""}`)
  lines.push(`- Merge state: ${view.mergeStateStatus ?? "<unknown>"}`)
  lines.push(`- Review decision: ${view.reviewDecision ?? "<none>"}`)
  lines.push(`- Branch: ${view.headRefName ?? "<unknown>"} -> ${view.baseRefName ?? "<unknown>"}`)
  lines.push(`- Checks: ${checkSummary.label}`)

  if (view.checks.length > 0) {
    lines.push("")
    lines.push("### Checks")

    for (const check of view.checks.slice(0, 24)) {
      const marker =
        check.status === "pass"
          ? "✅"
          : check.status === "fail"
            ? "❌"
            : check.status === "pending"
              ? "⏳"
              : check.status === "skipped"
                ? "⏭️"
                : "❔"

      const detail = [check.rawState, check.description].filter(Boolean).join(" · ")
      lines.push(`- ${marker} ${check.name}${detail ? ` — ${detail}` : ""}`)
    }

    if (view.checks.length > 24) {
      lines.push(`- ... ${view.checks.length - 24} more`) 
    }
  }

  return lines.join("\n")
}

export function prUsage() {
  return "Usage: /pr create [--dry-run] | /pr status | /pr checks | /pr merge [--merge|--squash|--rebase] [--delete-branch] [--dry-run]"
}

export function prCreateUsage() {
  return "Usage: /pr create [--dry-run]"
}

export function prMergeUsage() {
  return "Usage: /pr merge [--merge|--squash|--rebase] [--delete-branch] [--dry-run]"
}

export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/)
  return match ? match[0] : null
}
