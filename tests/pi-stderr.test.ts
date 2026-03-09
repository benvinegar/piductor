import { describe, expect, it } from "vitest"
import { sanitizePiStderrLine, shouldSurfacePiStderr } from "../src/network/pi-stderr"

describe("sanitizePiStderrLine", () => {
  it("removes ANSI escapes and carriage returns", () => {
    const line = "\u001b[2K\u001b[1G⠙ loading\r"
    expect(sanitizePiStderrLine(line)).toBe("⠙ loading")
  })
})

describe("shouldSurfacePiStderr", () => {
  it("suppresses non-error progress lines", () => {
    expect(shouldSurfacePiStderr("⠙ loading tools")).toBe(false)
  })

  it("surfaces error lines", () => {
    expect(shouldSurfacePiStderr("ERROR: timed out connecting to rpc")).toBe(true)
    expect(shouldSurfacePiStderr("fatal: unable to read config")).toBe(true)
  })
})
