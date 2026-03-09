import { describe, expect, it } from "vitest"
import { parsePorcelainStatusLine, parseWorktreePorcelain, slugify } from "../src/vcs/git"

describe("slugify", () => {
  it("normalizes mixed case and punctuation", () => {
    expect(slugify("BaudBot Alpha!!")).toBe("baudbot-alpha")
  })

  it("collapses consecutive separators", () => {
    expect(slugify("a___b---c")).toBe("a-b-c")
  })

  it("trims separators from ends", () => {
    expect(slugify("---modem---")).toBe("modem")
  })

  it("returns empty string when no alnum characters", () => {
    expect(slugify("@@@***")).toBe("")
  })
})

describe("parsePorcelainStatusLine", () => {
  it("preserves first filename character for leading-space statuses", () => {
    expect(parsePorcelainStatusLine(" M README.md")).toEqual({
      status: "M",
      file: "README.md",
    })
  })

  it("parses rename targets", () => {
    expect(parsePorcelainStatusLine("R  old-name.md -> README.md")).toEqual({
      status: "R",
      file: "README.md",
    })
  })
})

describe("parseWorktreePorcelain", () => {
  it("parses worktree paths and branches", () => {
    const parsed = parseWorktreePorcelain([
      "worktree /repo",
      "HEAD 123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/feature",
      "HEAD 456",
      "branch refs/heads/pc/feature",
      "",
    ].join("\n"))

    expect(parsed).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/repo/.worktrees/feature", branch: "pc/feature" },
    ])
  })
})
