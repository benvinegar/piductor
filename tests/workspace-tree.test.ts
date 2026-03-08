import { describe, expect, it } from "vitest"
import {
  formatWorkspaceTreeRowName,
  parseWorkspaceTreeValue,
  repoTreeValue,
  workspaceTreeValue,
} from "../src/workspace-tree"

describe("workspace-tree helpers", () => {
  it("builds repo and workspace tree values", () => {
    expect(repoTreeValue(2)).toBe("repo:2")
    expect(workspaceTreeValue(2, 17)).toBe("workspace:2:17")
  })

  it("parses repo and workspace tree values", () => {
    expect(parseWorkspaceTreeValue("repo:2")).toEqual({ type: "repo", repoId: 2 })
    expect(parseWorkspaceTreeValue("workspace:2:17")).toEqual({
      type: "workspace",
      repoId: 2,
      workspaceId: 17,
    })
  })

  it("rejects invalid tree values", () => {
    expect(parseWorkspaceTreeValue("repo:x")).toBeNull()
    expect(parseWorkspaceTreeValue("workspace:2")).toBeNull()
    expect(parseWorkspaceTreeValue("workspace:2:x")).toBeNull()
    expect(parseWorkspaceTreeValue("hello")).toBeNull()
  })

  it("formats repo/workspace row labels", () => {
    expect(
      formatWorkspaceTreeRowName({
        isRepo: true,
        expanded: true,
        repoId: 3,
        repoName: "baudbot-alpha",
      }),
    ).toBe("▾ 3 - baudbot-alpha")

    expect(
      formatWorkspaceTreeRowName({
        isRepo: false,
        repoId: 3,
        workspaceName: "feature-a",
        branch: "pc/feature-a",
        added: 12,
        removed: 4,
      }),
    ).toBe("  > feature-a · pc/feature-a [+12 -4]")
  })
})
