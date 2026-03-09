import { describe, expect, it } from "vitest"
import { consumeBufferedLines } from "../src/stream-buffer"

describe("stream-buffer", () => {
  it("emits full lines and keeps trailing remainder", () => {
    const result = consumeBufferedLines("hello", " world\nnext", 100)
    expect(result.lines).toEqual(["hello world"])
    expect(result.remainder).toBe("next")
  })

  it("preserves all data while capping remainder size", () => {
    const result = consumeBufferedLines("", "abcdefghij", 4)
    expect(result.lines).toEqual(["abcdef"])
    expect(result.remainder).toBe("ghij")
  })

  it("handles multiple lines with capped tail", () => {
    const result = consumeBufferedLines("pre", "fix\none\ntwothreefour", 5)
    expect(result.lines).toEqual(["prefix", "one", "twothre"])
    expect(result.remainder).toBe("efour")
  })
})
