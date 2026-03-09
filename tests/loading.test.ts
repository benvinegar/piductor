import { describe, expect, it } from "vitest"
import { LOADING_TOKEN, renderLoadingTokens } from "../src/ui/loading"

describe("renderLoadingTokens", () => {
  it("replaces loading token with frame glyph", () => {
    const rendered = renderLoadingTokens(`agent ${LOADING_TOKEN}`, 0)
    expect(rendered).not.toContain(LOADING_TOKEN)
    expect(rendered.length).toBeGreaterThan("agent ".length)
  })

  it("uses stable frame selection from index", () => {
    const a = renderLoadingTokens(`x ${LOADING_TOKEN}`, 1)
    const b = renderLoadingTokens(`x ${LOADING_TOKEN}`, 11)
    expect(a).toBe(b)
  })
})
