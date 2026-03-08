import { describe, expect, it } from "vitest"
import { parseWorkspaceNewArgs, suggestWorkspaceNameFromBranch, workspaceNewUsage } from "../src/workspace-new"

describe("workspaceNewUsage", () => {
  it("mentions branch-based creation", () => {
    expect(workspaceNewUsage()).toContain("--branch")
  })
})

describe("suggestWorkspaceNameFromBranch", () => {
  it("normalizes branch refs to a slug", () => {
    expect(suggestWorkspaceNameFromBranch("refs/heads/feature/add-auth")).toBe("feature-add-auth")
    expect(suggestWorkspaceNameFromBranch("origin/fix/login")).toBe("fix-login")
  })
})

describe("parseWorkspaceNewArgs", () => {
  it("parses classic name + optional baseRef syntax", () => {
    expect(parseWorkspaceNewArgs(["feature-a"]))
      .toEqual({ workspaceName: "feature-a", baseRef: "HEAD", fromBranch: false, requestedBranch: null })

    expect(parseWorkspaceNewArgs(["feature-a", "main"]))
      .toEqual({ workspaceName: "feature-a", baseRef: "main", fromBranch: false, requestedBranch: null })
  })

  it("parses branch-first syntax and defaults workspace name from branch", () => {
    expect(parseWorkspaceNewArgs(["--branch", "feature/new-nav"]))
      .toEqual({
        workspaceName: "feature-new-nav",
        baseRef: "feature/new-nav",
        fromBranch: true,
        requestedBranch: "feature/new-nav",
      })
  })

  it("supports explicit name with branch syntax", () => {
    expect(parseWorkspaceNewArgs(["--branch", "main", "release-prep"]))
      .toEqual({
        workspaceName: "release-prep",
        baseRef: "main",
        fromBranch: true,
        requestedBranch: "main",
      })
  })

  it("returns null for invalid forms", () => {
    expect(parseWorkspaceNewArgs([])).toBeNull()
    expect(parseWorkspaceNewArgs(["--branch"])).toBeNull()
    expect(parseWorkspaceNewArgs(["--branch", "main", "name", "extra"]))
      .toBeNull()
    expect(parseWorkspaceNewArgs(["--unknown", "x"])).toBeNull()
  })
})
