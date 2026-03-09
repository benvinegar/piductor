import { describe, expect, it } from "vitest"
import { formatTestRunStatus, nextTestRunFinished, nextTestRunStarted } from "../src/run/test-status"

describe("test status state transitions", () => {
  it("marks started test runs as running", () => {
    expect(nextTestRunStarted("2026-03-09T00:00:00.000Z")).toEqual({
      status: "running",
      at: "2026-03-09T00:00:00.000Z",
      code: null,
      signal: null,
    })
  })

  it("maps exit code to pass/fail", () => {
    expect(nextTestRunFinished(0, null, "2026-03-09T00:01:00.000Z").status).toBe("pass")
    expect(nextTestRunFinished(1, null, "2026-03-09T00:01:00.000Z").status).toBe("fail")
  })
})

describe("formatTestRunStatus", () => {
  it("returns readable labels", () => {
    expect(formatTestRunStatus(null)).toBe("not run")
    expect(formatTestRunStatus(nextTestRunStarted("2026-03-09T00:00:00.000Z"))).toBe("running")
    expect(formatTestRunStatus(nextTestRunFinished(0, null, "2026-03-09T00:01:00.000Z"))).toBe("pass (code=0)")
    expect(formatTestRunStatus(nextTestRunFinished(null, "SIGTERM", "2026-03-09T00:01:00.000Z"))).toBe(
      "fail (signal=SIGTERM)",
    )
  })
})
