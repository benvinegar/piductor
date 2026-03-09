import { describe, expect, it } from "vitest"
import {
  DEFAULT_THEME_KEY,
  getThemeByKey,
  nextThemeKey,
  parseThemeArgs,
  resolveThemeKey,
  toThemeMarkdown,
} from "../src/ui/themes"

describe("themes", () => {
  it("resolves theme aliases and names", () => {
    expect(resolveThemeKey("dark")).toBe("midnight")
    expect(resolveThemeKey("High Contrast")).toBe("high_contrast")
    expect(resolveThemeKey("solarized")).toBe("solarized")
    expect(resolveThemeKey("unknown-theme")).toBeNull()
  })

  it("parses theme command args", () => {
    expect(parseThemeArgs([])).toEqual({ action: "show" })
    expect(parseThemeArgs(["list"])).toEqual({ action: "list" })
    expect(parseThemeArgs(["next"])).toEqual({ action: "next" })
    expect(parseThemeArgs(["set", "forest"])).toEqual({ action: "set", themeKey: "forest" })
    expect(parseThemeArgs(["high", "contrast"])).toEqual({ action: "set", themeKey: "high_contrast" })
    expect(parseThemeArgs(["set", "nope"])).toBeNull()
  })

  it("cycles themes in order", () => {
    const first = nextThemeKey(DEFAULT_THEME_KEY)
    expect(first).not.toBe(DEFAULT_THEME_KEY)
    expect(nextThemeKey("high_contrast")).toBe(DEFAULT_THEME_KEY)
  })

  it("renders theme markdown with active marker", () => {
    const markdown = toThemeMarkdown("forest")
    expect(markdown).toContain("## Themes")
    expect(markdown).toContain("`forest` **(active)**")
  })

  it("returns a theme definition for every key", () => {
    const theme = getThemeByKey("midnight")
    expect(theme.colors.appBackground).toMatch(/^#/) 
  })
})
