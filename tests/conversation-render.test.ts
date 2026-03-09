import { describe, expect, it } from "vitest"
import {
  DEFAULT_CONVERSATION,
  formatAssistantMessageRail,
  formatUserMessageBox,
  toConversationMarkdown,
} from "../src/ui/conversation-render"

describe("conversation-render", () => {
  it("returns default conversation when empty", () => {
    expect(toConversationMarkdown([])).toBe(DEFAULT_CONVERSATION)
  })

  it("renders user prompts in a boxed block", () => {
    const box = formatUserMessageBox("hello")
    expect(box).toContain("╭")
    expect(box).toContain("│ hello")
    expect(box).toContain("╰")
  })

  it("passes assistant markdown through without forced quote markers", () => {
    const output = formatAssistantMessageRail("**bold**\n- item")
    expect(output).toBe("**bold**\n- item")
  })

  it("preserves extra blank lines in assistant output", () => {
    const output = formatAssistantMessageRail("line A\n\nline B")
    expect(output).toBe("line A\n\nline B")
  })

  it("keeps markdown tokens in assistant output and separates message blocks", () => {
    const rendered = toConversationMarkdown([
      "[12:00:00] [you/prompt] start",
      "[12:00:01] **Repo tour**",
      "[12:00:02] [assistant-break]",
      "[12:00:03] second reply",
    ])

    expect(rendered).toContain("**Repo tour**")
    expect(rendered).toContain("second reply")
    expect(rendered).toContain("...")
  })

  it("keeps the latest user prompt visible when assistant output exceeds the render window", () => {
    const lines = ["[12:00:00] [you/prompt] keep this prompt visible"]
    for (let index = 0; index < 340; index += 1) {
      lines.push(`[12:01:${String(index % 60).padStart(2, "0")}] assistant line ${index}`)
    }

    const rendered = toConversationMarkdown(lines)
    expect(rendered).toContain("keep this prompt visible")
    expect(rendered).toContain("assistant line 339")
  })

  it("preserves blank lines inside assistant messages", () => {
    const rendered = toConversationMarkdown([
      "[12:00:01] Line one",
      "[12:00:02] ",
      "[12:00:03] Line three",
    ])

    expect(rendered).toContain("Line one")
    expect(rendered).toContain("\n\nLine three")
  })

  it("suppresses tool chatter lines", () => {
    const rendered = toConversationMarkdown([
      "[12:00:00] [tool] bash start",
      "[12:00:01] [tool] bash ok",
      "[12:00:02] real assistant text",
    ])

    expect(rendered).not.toContain("bash start")
    expect(rendered).not.toContain("bash ok")
    expect(rendered).toContain("real assistant text")
  })
})
