import { describe, expect, it } from "vitest"
import { summarizeToolCall, summarizeToolError } from "../src/ui/agent-activity"

describe("agent activity formatting", () => {
  it("formats common tool calls", () => {
    expect(summarizeToolCall("read", { path: "src/app.tsx" })).toBe("Read `src/app.tsx`")
    expect(summarizeToolCall("read", { path: "/home/bentlegen/Projects/tui-experiment/src/ui/app-react.tsx" })).toBe(
      "Read `…/src/ui/app-react.tsx`",
    )
    expect(summarizeToolCall("bash", { command: "npm test --silent" })).toBe("Run tests")
    expect(summarizeToolCall("bash", { command: "rg -n conversation src" })).toBe("Search project files")
    expect(summarizeToolCall("todo", { action: "claim", id: "TODO-1" })).toBe("Todo claim TODO-1")
  })

  it("formats unknown tool calls with a readable fallback", () => {
    expect(summarizeToolCall("send_to_session", { sessionName: "helper" })).toBe("Send To Session")
  })

  it("formats tool errors with useful detail", () => {
    expect(summarizeToolError("bash", { stderr: "permission denied" })).toBe("Bash failed: `permission denied`")
    expect(summarizeToolError("read", {})).toBe("Read failed")
  })
})
