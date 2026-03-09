import { describe, expect, it } from "vitest"
import { diffFingerprintFromStats } from "../src/review/diff-fingerprint"

describe("diffFingerprintFromStats", () => {
  it("returns empty fingerprint for no stats", () => {
    expect(diffFingerprintFromStats([])).toBe("")
  })

  it("builds deterministic fingerprint including status and counts", () => {
    const stats = [
      { status: "M", path: "README.md", added: 2, removed: 1 },
      { status: "A", path: "src/new.ts", added: null, removed: null },
    ]

    expect(diffFingerprintFromStats(stats)).toBe("M:README.md:2:1|A:src/new.ts:?:?")
  })
})
