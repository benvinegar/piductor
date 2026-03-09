import { describe, expect, it } from "vitest"
import { extractFirstUrl, parsePrCreateArgs, prCreateUsage } from "../src/vcs/pr-command"

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

describe("prCreateUsage", () => {
  it("documents dry-run", () => {
    expect(prCreateUsage()).toContain("--dry-run")
  })
})
