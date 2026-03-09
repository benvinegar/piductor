import { describe, expect, it } from "vitest"
import { DEFAULT_THEME_KEY, getThemeByKey, listThemes, resolveThemeKey } from "../src/ui/themes"

describe("themes", () => {
  it("resolves theme aliases and names", () => {
    expect(resolveThemeKey("dark")).toBe("midnight")
    expect(resolveThemeKey("High Contrast")).toBe("high_contrast")
    expect(resolveThemeKey("solarized")).toBe("solarized")
    expect(resolveThemeKey("unknown-theme")).toBeNull()
  })

  it("lists starter themes", () => {
    const keys = listThemes().map((theme) => theme.key)
    expect(keys).toEqual(["midnight", "light", "solarized", "forest", "high_contrast"])
  })

  it("returns a theme definition for default key", () => {
    const theme = getThemeByKey(DEFAULT_THEME_KEY)
    expect(theme.colors.appBackground).toMatch(/^#/)
    expect(theme.name.length).toBeGreaterThan(0)
  })
})
