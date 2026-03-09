import { describe, expect, it } from "vitest"
import { replaySessionMessagesToLogLines } from "../src/ui/session-replay"

describe("replaySessionMessagesToLogLines", () => {
  it("replays user and assistant messages", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      }),
    ].join("\n")

    const lines = replaySessionMessagesToLogLines(jsonl)
    expect(lines).toEqual(["[you/prompt] hello", "hi there", "[assistant-break]"])
  })

  it("handles assistant multiline blocks", () => {
    const jsonl = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      },
    })

    const lines = replaySessionMessagesToLogLines(jsonl)
    expect(lines).toEqual(["line 1", "line 2", "[assistant-break]"])
  })

  it("ignores invalid json lines and enforces max line window", () => {
    const rows = ["not-json"]
    for (let i = 0; i < 10; i += 1) {
      rows.push(
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: `line ${i}` }] },
        }),
      )
    }

    const lines = replaySessionMessagesToLogLines(rows.join("\n"), 4)
    expect(lines).toEqual(["line 8", "[assistant-break]", "line 9", "[assistant-break]"])
  })
})
