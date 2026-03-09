import { describe, expect, it } from "vitest"
import { parseFileDiff, selectDiffReviewHunk } from "../src/diff-review"

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

describe("selectDiffReviewHunk", () => {
  it("selects a single hunk while preserving patch headers", () => {
    const selected = selectDiffReviewHunk(SAMPLE_DIFF, 0)
    expect(selected.hunkCount).toBe(2)
    expect(selected.activeHunkIndex).toBe(0)
    expect(selected.diffText).toContain("diff --git a/src/a.ts b/src/a.ts")
    expect(selected.diffText).toContain("@@ -1,3 +1,4 @@")
    expect(selected.diffText).not.toContain("@@ -10,2 +11,2 @@")
  })

  it("clamps out-of-range hunk index", () => {
    const selected = selectDiffReviewHunk(SAMPLE_DIFF, 99)
    expect(selected.hunkCount).toBe(2)
    expect(selected.activeHunkIndex).toBe(1)
    expect(selected.diffText).toContain("@@ -10,2 +11,2 @@")
  })

  it("returns raw diff when no hunks are present", () => {
    const raw = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt"
    const selected = selectDiffReviewHunk(raw, 0)
    expect(selected.hunkCount).toBe(0)
    expect(selected.activeHunkIndex).toBe(0)
    expect(selected.diffText).toBe(raw)
  })
})
