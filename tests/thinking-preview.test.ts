import { describe, expect, it } from "vitest"
import { compactThinkingPreview } from "../src/ui/thinking-preview"

describe("compactThinkingPreview", () => {
  it("collapses whitespace and trims", () => {
    expect(compactThinkingPreview("  first\n\n  second\tthird  ")).toBe("first second third")
  })

  it("truncates to max characters with ellipsis", () => {
    expect(compactThinkingPreview("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghi…")
  })

  it("returns empty string for blank input", () => {
    expect(compactThinkingPreview("   \n\t ")).toBe("")
  })
})
