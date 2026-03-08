import { describe, expect, it } from "vitest"
import {
  DEFAULT_CONVERSATION,
  formatAssistantMessageRail,
  formatUserMessageBox,
  toConversationMarkdown,
} from "../src/conversation-render"

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

  it("formats assistant output as markdown blockquote lines with hard line breaks", () => {
    const rail = formatAssistantMessageRail("first line\nsecond line")
    const lines = rail.split("\n")

    expect(lines).toEqual(["> first line  ", "> second line  "])
  })

  it("preserves extra blank lines in assistant output", () => {
    const rail = formatAssistantMessageRail("line A\n\nline B")
    const lines = rail.split("\n")

    expect(lines).toEqual(["> line A  ", ">", "> line B  "])
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

  it("preserves blank lines inside assistant messages", () => {
    const rendered = toConversationMarkdown([
      "[12:00:01] Line one",
      "[12:00:02] ",
      "[12:00:03] Line three",
    ])

    expect(rendered).toContain("> Line one")
    expect(rendered).toContain("\n>\n")
    expect(rendered).toContain("> Line three")
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
