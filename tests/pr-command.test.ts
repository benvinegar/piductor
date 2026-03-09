import { describe, expect, it } from "vitest"
import {
  classifyPrCheckState,
  extractFirstUrl,
  parsePrCreateArgs,
  parsePrMergeArgs,
  parsePrViewJson,
  prCreateUsage,
  prMergeUsage,
  prUsage,
  summarizePrChecks,
} from "../src/vcs/pr-command"

describe("parsePrCreateArgs", () => {
  it("accepts empty args", () => {
    expect(parsePrCreateArgs([])).toEqual({ dryRun: false })
  })

  it("accepts --dry-run", () => {
    expect(parsePrCreateArgs(["--dry-run"])).toEqual({ dryRun: true })
  })

  it("rejects unknown args", () => {
    expect(parsePrCreateArgs(["--title", "x"])).toBeNull()
  })
})

describe("parsePrMergeArgs", () => {
  it("defaults to merge mode", () => {
    expect(parsePrMergeArgs([])).toEqual({ dryRun: false, method: "merge", deleteBranch: false })
  })

  it("supports merge flags", () => {
    expect(parsePrMergeArgs(["--squash", "--delete-branch", "--dry-run"])).toEqual({
      dryRun: true,
      method: "squash",
      deleteBranch: true,
    })
  })

  it("rejects unknown args", () => {
    expect(parsePrMergeArgs(["--auto"])).toBeNull()
  })
})

describe("parsePrViewJson", () => {
  it("parses gh pr view payload", () => {
    const parsed = parsePrViewJson(
      JSON.stringify({
        number: 42,
        url: "https://github.com/org/repo/pull/42",
        state: "OPEN",
        isDraft: false,
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        statusCheckRollup: [
          { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
          { context: "lint", state: "PENDING" },
        ],
      }),
    )

    expect(parsed?.number).toBe(42)
    expect(parsed?.checks).toHaveLength(2)
    expect(parsed?.checks[0]?.status).toBe("pass")
    expect(parsed?.checks[1]?.status).toBe("pending")
  })

  it("returns null for invalid JSON", () => {
    expect(parsePrViewJson("not-json")).toBeNull()
  })
})

describe("classifyPrCheckState", () => {
  it("classifies pass/fail/pending", () => {
    expect(classifyPrCheckState("SUCCESS")).toBe("pass")
    expect(classifyPrCheckState("FAILURE")).toBe("fail")
    expect(classifyPrCheckState("IN_PROGRESS")).toBe("pending")
  })
})

describe("summarizePrChecks", () => {
  it("summarizes check totals", () => {
    const summary = summarizePrChecks([
      { name: "a", status: "pass", rawState: "SUCCESS", description: null, url: null },
      { name: "b", status: "pending", rawState: "PENDING", description: null, url: null },
      { name: "c", status: "fail", rawState: "FAILURE", description: null, url: null },
    ])

    expect(summary.pass).toBe(1)
    expect(summary.pending).toBe(1)
    expect(summary.fail).toBe(1)
    expect(summary.label).toContain("1 pass")
    expect(summary.label).toContain("1 fail")
    expect(summary.label).toContain("1 pending")
  })
})

describe("extractFirstUrl", () => {
  it("extracts URL from text", () => {
    expect(extractFirstUrl("created: https://github.com/benvinegar/piductor/pull/1")).toBe(
      "https://github.com/benvinegar/piductor/pull/1",
    )
  })

  it("returns null when missing", () => {
    expect(extractFirstUrl("no links here")).toBeNull()
  })
})

describe("usage text", () => {
  it("documents create + merge usage", () => {
    expect(prCreateUsage()).toContain("--dry-run")
    expect(prMergeUsage()).toContain("--squash")
    expect(prUsage()).toContain("/pr checks")
    expect(prUsage()).toContain("/pr merge")
  })
})
