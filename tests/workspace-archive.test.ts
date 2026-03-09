import { describe, expect, it } from "vitest"
import { parseWorkspaceArchiveArgs, workspaceArchiveUsage } from "../src/workspace/archive"

describe("parseWorkspaceArchiveArgs", () => {
  it("supports default archive", () => {
    expect(parseWorkspaceArchiveArgs([])).toEqual({ force: false })
  })

  it("supports --force", () => {
    expect(parseWorkspaceArchiveArgs(["--force"])).toEqual({ force: true })
  })

  it("rejects unknown flags", () => {
    expect(parseWorkspaceArchiveArgs(["--dry-run"])).toBeNull()
  })
})

describe("workspaceArchiveUsage", () => {
  it("mentions --force", () => {
    expect(workspaceArchiveUsage()).toContain("--force")
  })
})
