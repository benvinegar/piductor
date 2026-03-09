import { describe, expect, it } from "vitest"
import { formatRunExitSummary, formatRunLogLine } from "../src/run-log"

describe("formatRunLogLine", () => {
  it("adds stable run id + source prefixes", () => {
    expect(formatRunLogLine(3, "cmd", "$ bun test")).toBe("[run#3/cmd] $ bun test")
    expect(formatRunLogLine(11, "err", "ENOENT")).toBe("[run#11/err] ENOENT")
  })
})

describe("formatRunExitSummary", () => {
  it("normalizes nullable exit fields", () => {
    expect(formatRunExitSummary(0, null)).toBe("exited code=0 signal=none")
    expect(formatRunExitSummary(null, "SIGTERM")).toBe("exited code=null signal=SIGTERM")
  })
})
