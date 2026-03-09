import { describe, expect, it } from "vitest"
import {
  DEFAULT_CONVERSATION,
  formatAssistantMessageRail,
  formatUserMessageBox,
  toConversationBlocks,
  toConversationMarkdown,
} from "../src/ui/conversation-render"

describe("conversation-render", () => {
  it("returns default conversation when empty", () => {
    expect(toConversationMarkdown([])).toBe(DEFAULT_CONVERSATION)
    expect(toConversationBlocks([])).toEqual([])
  })

  it("keeps user prompts as plain text blocks", () => {
    expect(formatUserMessageBox("hello   ")).toBe("hello")

    const blocks = toConversationBlocks(["[12:00:00] [you/prompt] hello world"])
    expect(blocks).toEqual([
      {
        kind: "user",
        text: "hello world",
      },
    ])
  })

  it("keeps assistant markdown and adds spacing before bullet lists", () => {
    const output = formatAssistantMessageRail("**bold**\n- item")
    expect(output).toBe("**bold**\n\n- item")
  })

  it("uses blank lines between messages instead of divider lines", () => {
    const rendered = toConversationMarkdown([
      "[12:00:00] [you/prompt] start",
      "[12:00:01] **Repo tour**",
      "[12:00:02] [assistant-break]",
      "[12:00:03] second reply",
    ])

    expect(rendered).toContain("**You:** start")
    expect(rendered).toContain("**Repo tour**")
    expect(rendered).toContain("second reply")
    expect(rendered).not.toContain("...")
    expect(rendered).not.toContain("────")
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

  it("expands inline bullets into separate lines", () => {
    const rendered = toConversationMarkdown([
      "[12:00:01] Done — I read README.md.",
      "[12:00:02] Top lines are: - # Modem - Developer-focused CRM",
    ])

    expect(rendered).toContain("Top lines are:")
    expect(rendered).toContain("\n\n- # Modem")
    expect(rendered).toContain("\n- Developer-focused CRM")
  })

  it("renders thinking and tool activity as a persistent timeline", () => {
    const lines = [
      "[12:00:00] [thinking] I found the stale value source",
      "[12:00:01] [tool] Read `ingest-client.ts`",
      "[12:00:02] [tool] Search `clientName`",
      "[12:00:03] Final answer",
    ]

    const rendered = toConversationMarkdown(lines)
    const blocks = toConversationBlocks(lines)

    expect(rendered).toContain("• I found the stale value source")
    expect(rendered).toContain("• Explored")
    expect(rendered).toContain("└ Read `ingest-client.ts`")
    expect(rendered).toContain("└ Search `clientName`")
    expect(rendered).toContain("Final answer")
    expect(blocks[0]).toEqual({
      kind: "activity",
      text: "• I found the stale value source\n\n• Explored\n  └ Read `ingest-client.ts`\n  └ Search `clientName`",
    })
    expect(blocks[1]).toEqual({
      kind: "assistant",
      markdown: "Final answer",
    })
  })

  it("renders tool errors inside the explored section", () => {
    const rendered = toConversationMarkdown([
      "[12:00:00] [tool] Run `npm test`",
      "[12:00:01] [tool:error] Bash failed: `permission denied`",
    ])

    expect(rendered).toContain("• Explored")
    expect(rendered).toContain("└ Run `npm test`")
    expect(rendered).toContain("└ ⚠️ Bash failed: `permission denied`")
  })
})
