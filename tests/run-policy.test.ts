import { describe, expect, it } from "vitest"
import { shouldStopExistingRun, stopSignalSequence } from "../src/run/policy"

describe("shouldStopExistingRun", () => {
  it("stops existing process only in nonconcurrent mode", () => {
    expect(shouldStopExistingRun("nonconcurrent", true)).toBe(true)
    expect(shouldStopExistingRun("concurrent", true)).toBe(false)
    expect(shouldStopExistingRun("nonconcurrent", false)).toBe(false)
    expect(shouldStopExistingRun(undefined, true)).toBe(false)
  })
})

describe("stopSignalSequence", () => {
  it("uses deterministic escalation order", () => {
    expect(stopSignalSequence()).toEqual(["SIGHUP", "SIGKILL"])
  })
})
