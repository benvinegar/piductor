import { describe, expect, it } from "vitest"
import {
  buildWorkspaceNameSummaryPrompt,
  extractAssistantTextFromMessages,
  formatWorkspaceNameWithSummary,
  normalizeWorkspaceNameSummary,
} from "../src/workspace/name-summary"

describe("workspace name summaries", () => {
  it("builds an instruction prompt that includes the task text", () => {
    const prompt = buildWorkspaceNameSummaryPrompt("add oauth callback validation")
    expect(prompt).toContain("You write short workspace labels")
    expect(prompt).toContain("Task: add oauth callback validation")
  })

  it("normalizes noisy model output", () => {
    expect(normalizeWorkspaceNameSummary("Label: \"Fix login callback race.\""))
      .toBe("fix login callback race")
    expect(normalizeWorkspaceNameSummary("- Workspace summary: tighten api error handling"))
      .toBe("tighten api error handling")
  })

  it("truncates long labels while preserving words", () => {
    const value = normalizeWorkspaceNameSummary(
      "harden websocket reconnect retry state machine behavior for flaky mobile connections",
      40,
    )
    expect(value).toBe("harden websocket reconnect retry state")
  })

  it("formats workspace display names", () => {
    expect(formatWorkspaceNameWithSummary("main-5", "fix flaky auth refresh"))
      .toBe("main-5 · fix flaky auth refresh")
    expect(formatWorkspaceNameWithSummary("main-5", "")).toBe("main-5")
  })

  it("extracts assistant text from rpc message payloads", () => {
    expect(
      extractAssistantTextFromMessages([
        { role: "user", content: "hello" },
        { role: "assistant", content: "short summary" },
      ]),
    ).toBe("short summary")

    expect(
      extractAssistantTextFromMessages([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toBe("first\nsecond")
  })
})
