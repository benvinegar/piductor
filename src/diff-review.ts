export type DiffViewMode = "unified" | "split"

export type DiffHunk = {
  header: string
  lines: string[]
}

export type ParsedFileDiff = {
  meta: string[]
  hunks: DiffHunk[]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function parseFileDiff(text: string): ParsedFileDiff {
  const lines = text.split(/\r?\n/)
  const meta: string[] = []
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null

  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      current = { header: line, lines: [] }
      hunks.push(current)
      continue
    }

    if (current) {
      current.lines.push(line)
    } else if (line.length > 0) {
      meta.push(line)
    }
  }

  return { meta, hunks }
}

type SplitRow = {
  left: string
  right: string
}

function toSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  const pendingRemoves: string[] = []

  const flushRemoves = () => {
    while (pendingRemoves.length > 0) {
      const removed = pendingRemoves.shift() ?? ""
      rows.push({ left: `-${removed}`, right: "" })
    }
  }

  for (const line of hunk.lines) {
    if (line.startsWith("-")) {
      pendingRemoves.push(line.slice(1))
      continue
    }

    if (line.startsWith("+")) {
      const removed = pendingRemoves.shift()
      rows.push({ left: removed !== undefined ? `-${removed}` : "", right: `+${line.slice(1)}` })
      continue
    }

    flushRemoves()

    if (line.startsWith(" ")) {
      const content = line.slice(1)
      rows.push({ left: ` ${content}`, right: ` ${content}` })
      continue
    }

    rows.push({ left: line, right: line })
  }

  flushRemoves()
  return rows
}

function fitCell(value: string, width: number): string {
  if (value.length === width) return value
  if (value.length < width) return value.padEnd(width, " ")
  if (width <= 1) return value.slice(0, width)
  return `${value.slice(0, Math.max(0, width - 1))}…`
}

function renderSplitRows(rows: SplitRow[], columnWidth = 54): string[] {
  return rows.map((row) => `${fitCell(row.left, columnWidth)} │ ${fitCell(row.right, columnWidth)}`)
}

export function renderDiffReviewMarkdown(params: {
  path: string
  diffText: string
  mode: DiffViewMode
  hunkIndex: number
}): { markdown: string; hunkCount: number; activeHunkIndex: number } {
  const parsed = parseFileDiff(params.diffText)
  const hunkCount = parsed.hunks.length

  if (hunkCount === 0) {
    const fallback = params.diffText.trim().length > 0 ? params.diffText : "(no textual diff available)"
    return {
      markdown: `### ${params.path}\n\n\`\`\`diff\n${fallback}\n\`\`\``,
      hunkCount: 0,
      activeHunkIndex: 0,
    }
  }

  const activeHunkIndex = clamp(params.hunkIndex, 0, hunkCount - 1)
  const activeHunk = parsed.hunks[activeHunkIndex]

  if (params.mode === "split") {
    const renderedRows = renderSplitRows(toSplitRows(activeHunk))
    const content = [activeHunk.header, ...renderedRows].join("\n")

    return {
      markdown: `### ${params.path} · split · hunk ${activeHunkIndex + 1}/${hunkCount}\n\n\`\`\`text\n${content}\n\`\`\``,
      hunkCount,
      activeHunkIndex,
    }
  }

  const unifiedLines = [activeHunk.header, ...activeHunk.lines].join("\n")
  return {
    markdown: `### ${params.path} · unified · hunk ${activeHunkIndex + 1}/${hunkCount}\n\n\`\`\`diff\n${unifiedLines}\n\`\`\``,
    hunkCount,
    activeHunkIndex,
  }
}

export type DiffReviewSelection = {
  diffText: string
  hunkCount: number
  activeHunkIndex: number
}

export function selectDiffReviewHunk(diffText: string, hunkIndex: number): DiffReviewSelection {
  const parsed = parseFileDiff(diffText)
  const hunkCount = parsed.hunks.length

  if (hunkCount === 0) {
    return {
      diffText,
      hunkCount: 0,
      activeHunkIndex: 0,
    }
  }

  const activeHunkIndex = clamp(hunkIndex, 0, hunkCount - 1)
  const activeHunk = parsed.hunks[activeHunkIndex]

  return {
    diffText: [...parsed.meta, activeHunk.header, ...activeHunk.lines].join("\n").trimEnd(),
    hunkCount,
    activeHunkIndex,
  }
}
