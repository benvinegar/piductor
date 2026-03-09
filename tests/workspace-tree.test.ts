import { describe, expect, it } from "vitest"
import {
  encodeWorkspaceTreeRowMeta,
  formatWorkspaceActivityAge,
  formatWorkspaceRuntimeLabel,
  formatWorkspaceTreeRowName,
  parseWorkspaceTreeRowMeta,
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
    ).toBe("feature-a")
  })

  it("encodes and parses workspace row metadata", () => {
    const encoded = encodeWorkspaceTreeRowMeta({
      added: 12,
      removed: 4,
      status: "running",
      busy: true,
      activityAt: "2026-03-08T23:45:00.000Z",
    })

    expect(parseWorkspaceTreeRowMeta(encoded)).toEqual({
      added: 12,
      removed: 4,
      status: "running",
      busy: true,
      activityAt: "2026-03-08T23:45:00.000Z",
    })

    expect(parseWorkspaceTreeRowMeta("not-json")).toEqual({
      added: 0,
      removed: 0,
      status: "stopped",
      busy: false,
      activityAt: null,
    })
  })

  it("formats runtime labels and relative activity age", () => {
    expect(formatWorkspaceRuntimeLabel("starting", false)).toBe("busy")
    expect(formatWorkspaceRuntimeLabel("running", true)).toBe("busy")
    expect(formatWorkspaceRuntimeLabel("running", false)).toBe("active")
    expect(formatWorkspaceRuntimeLabel("error", false)).toBe("error")
    expect(formatWorkspaceRuntimeLabel("stopped", false)).toBe("stopped")

    const now = Date.parse("2026-03-08T23:50:00.000Z")
    expect(formatWorkspaceActivityAge("2026-03-08T23:49:58.000Z", now)).toBe("now")
    expect(formatWorkspaceActivityAge("2026-03-08T23:49:20.000Z", now)).toBe("40s")
    expect(formatWorkspaceActivityAge("2026-03-08T23:30:00.000Z", now)).toBe("20m")
    expect(formatWorkspaceActivityAge("2026-03-08T20:50:00.000Z", now)).toBe("3h")
    expect(formatWorkspaceActivityAge("2026-03-05T23:50:00.000Z", now)).toBe("3d")
    expect(formatWorkspaceActivityAge(null, now)).toBe("-")
  })
})
