import { describe, expect, it } from "vitest"
import { parseFileDiff, renderDiffReviewMarkdown } from "../src/diff-review"

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 console.log(a, b)
@@ -10,2 +11,2 @@
-oldLine()
+newLine()`

describe("parseFileDiff", () => {
  it("splits metadata and hunks", () => {
    const parsed = parseFileDiff(SAMPLE_DIFF)
    expect(parsed.meta.length).toBeGreaterThan(0)
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[0]?.header).toContain("@@ -1,3 +1,4 @@")
  })
})

describe("renderDiffReviewMarkdown", () => {
  it("renders unified hunk view", () => {
    const rendered = renderDiffReviewMarkdown({
      path: "src/a.ts",
      diffText: SAMPLE_DIFF,
      mode: "unified",
      hunkIndex: 0,
    })

    expect(rendered.hunkCount).toBe(2)
    expect(rendered.markdown).toContain("unified · hunk 1/2")
    expect(rendered.markdown).toContain("```diff")
    expect(rendered.markdown).toContain("+const c = 4")
  })

  it("renders split view with paired remove/add rows", () => {
    const rendered = renderDiffReviewMarkdown({
      path: "src/a.ts",
      diffText: SAMPLE_DIFF,
      mode: "split",
      hunkIndex: 0,
    })

    expect(rendered.markdown).toContain("split · hunk 1/2")
    expect(rendered.markdown).toContain("│")
    expect(rendered.markdown).toContain("-const b = 2")
    expect(rendered.markdown).toContain("+const b = 3")
  })

  it("clamps out-of-range hunk index", () => {
    const rendered = renderDiffReviewMarkdown({
      path: "src/a.ts",
      diffText: SAMPLE_DIFF,
      mode: "unified",
      hunkIndex: 99,
    })

    expect(rendered.activeHunkIndex).toBe(1)
    expect(rendered.markdown).toContain("hunk 2/2")
  })
})
