import { describe, expect, it } from "vitest"
import { normalizeRunMode, parseRunCommandArgs, runCommandUsage } from "../src/run/command"

describe("normalizeRunMode", () => {
  it("defaults invalid/undefined values to concurrent", () => {
    expect(normalizeRunMode(undefined)).toBe("concurrent")
    expect(normalizeRunMode("concurrent")).toBe("concurrent")
    expect(normalizeRunMode("nonconcurrent")).toBe("nonconcurrent")
  })
})

describe("parseRunCommandArgs", () => {
  it("parses run/stop/setup/archive variants", () => {
    expect(parseRunCommandArgs([])).toEqual({ action: "run", command: null })
    expect(parseRunCommandArgs(["echo", "hello"])).toEqual({ action: "run", command: "echo hello" })
    expect(parseRunCommandArgs(["stop"])).toEqual({ action: "stop" })
    expect(parseRunCommandArgs(["setup"])).toEqual({ action: "setup" })
    expect(parseRunCommandArgs(["archive"])).toEqual({ action: "archive" })
  })

  it("parses mode get/set and rejects invalid mode usage", () => {
    expect(parseRunCommandArgs(["mode"])).toEqual({ action: "mode-get" })
    expect(parseRunCommandArgs(["mode", "concurrent"])).toEqual({ action: "mode-set", mode: "concurrent" })
    expect(parseRunCommandArgs(["mode", "nonconcurrent"])).toEqual({ action: "mode-set", mode: "nonconcurrent" })
    expect(parseRunCommandArgs(["mode", "CONCURRENT"])).toEqual({ action: "mode-set", mode: "concurrent" })

    expect(parseRunCommandArgs(["mode", "fast"])).toBeNull()
    expect(parseRunCommandArgs(["mode", "concurrent", "extra"])).toBeNull()
  })
})

describe("runCommandUsage", () => {
  it("returns one-line usage", () => {
    expect(runCommandUsage()).toContain("/run")
    expect(runCommandUsage()).toContain("mode")
  })
})
