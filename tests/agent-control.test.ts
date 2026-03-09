import { describe, expect, it } from "vitest"
import { parseAgentCommand, resolveRestartModel } from "../src/agent/control"

describe("agent-control helpers", () => {
  it("parses supported agent commands", () => {
    expect(parseAgentCommand(["start"])).toEqual({ action: "start", model: undefined })
    expect(parseAgentCommand(["start", "gpt-5"])).toEqual({ action: "start", model: "gpt-5" })
    expect(parseAgentCommand(["stop"])).toEqual({ action: "stop" })
    expect(parseAgentCommand(["restart"])).toEqual({ action: "restart", model: undefined })
    expect(parseAgentCommand(["restart", "claude"])).toEqual({ action: "restart", model: "claude" })
    expect(parseAgentCommand(["kill"])).toEqual({ action: "kill" })
    expect(parseAgentCommand(["list"])).toEqual({ action: "list" })
  })

  it("rejects unsupported commands", () => {
    expect(parseAgentCommand([])).toBeNull()
    expect(parseAgentCommand(["wat"])).toBeNull()
  })

  it("resolves restart model with explicit > current > default priority", () => {
    expect(resolveRestartModel("explicit", "current", "default")).toBe("explicit")
    expect(resolveRestartModel(undefined, "current", "default")).toBe("current")
    expect(resolveRestartModel(undefined, null, "default")).toBe("default")
    expect(resolveRestartModel(undefined, null, undefined)).toBeUndefined()
  })
})
