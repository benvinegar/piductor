import { describe, expect, it } from "vitest"
import { buildHelpMarkdown, findCommandSuggestions } from "../src/ui/commands"

describe("findCommandSuggestions", () => {
  it("returns top suggestions for empty query", () => {
    const suggestions = findCommandSuggestions("")
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions[0]?.command).toContain("repo")
  })

  it("prioritizes starts-with matches", () => {
    const suggestions = findCommandSuggestions("workspace")
    expect(suggestions.every((item) => item.command.includes("workspace"))).toBe(true)
    expect(suggestions[0]?.command.startsWith("workspace")).toBe(true)
  })

  it("supports substring matching", () => {
    const suggestions = findCommandSuggestions("dry-run")
    expect(suggestions.some((item) => item.command.includes("dry-run"))).toBe(true)
  })
})

describe("buildHelpMarkdown", () => {
  it("contains help heading and slash commands", () => {
    const markdown = buildHelpMarkdown()
    expect(markdown).toContain("## Commands")
    expect(markdown).toContain("`/help`")
    expect(markdown).toContain("autocomplete")
  })
})
