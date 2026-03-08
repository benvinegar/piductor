import { describe, expect, it } from "vitest"
import { slugify } from "../src/git"

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
