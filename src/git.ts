import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  })

  if (result.status !== 0) {
    const stderr = result.stderr?.trim()
    const stdout = result.stdout?.trim()
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, stderr, stdout].filter(Boolean).join("\n"),
    )
  }

  return (result.stdout ?? "").trim()
}

function runAllowError(command: string, args: string[], cwd?: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  })
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
}

export function resolveGitRoot(candidatePath: string): string {
  return run("git", ["-C", candidatePath, "rev-parse", "--show-toplevel"])
}

export function isGitRepo(candidatePath: string): boolean {
  const result = runAllowError("git", ["-C", candidatePath, "rev-parse", "--is-inside-work-tree"])
  return result.status === 0
}

function branchExists(repoRoot: string, branch: string): boolean {
  const result = runAllowError("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
  return result.status === 0
}

function commitRefExists(repoRoot: string, ref: string): boolean {
  const result = runAllowError("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
  return result.status === 0
}

export function resolveWorkspaceBaseRef(repoRoot: string, requestedRef: string): string | null {
  const ref = requestedRef.trim()
  if (!ref) return null

  const candidates = [
    ref,
    `refs/heads/${ref}`,
    `refs/remotes/origin/${ref}`,
    ref.startsWith("origin/") ? `refs/remotes/${ref}` : "",
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (commitRefExists(repoRoot, candidate)) {
      return candidate
    }
  }

  return null
}

export function listBranchRefs(repoRoot: string): string[] {
  const localResult = runAllowError("git", ["-C", repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads"])
  const remoteResult = runAllowError("git", ["-C", repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])

  const local = (localResult.stdout ?? "")
    .split(/\r?\n/)
    .map((it) => it.trim())
    .filter(Boolean)

  const remote = (remoteResult.stdout ?? "")
    .split(/\r?\n/)
    .map((it) => it.trim())
    .filter((it) => it && it !== "origin/HEAD")

  return [...new Set([...local, ...remote])]
}

export function getDefaultBranchName(repoRoot: string): string {
  const symbolic = runAllowError("git", ["-C", repoRoot, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
  const symbolicText = String(symbolic.stdout ?? "").trim()
  if (symbolic.status === 0 && symbolicText.startsWith("origin/")) {
    return symbolicText.slice("origin/".length)
  }

  const head = runAllowError("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"])
  const headText = String(head.stdout ?? "").trim()
  if (head.status === 0 && headText && headText !== "HEAD") {
    return headText
  }

  return "main"
}

function findUniqueBranch(repoRoot: string, branchBase: string): string {
  if (!branchExists(repoRoot, branchBase)) return branchBase

  let i = 2
  while (branchExists(repoRoot, `${branchBase}-${i}`)) {
    i += 1
  }

  return `${branchBase}-${i}`
}

function findUniquePath(basePath: string): string {
  if (!existsSync(basePath)) return basePath
  let i = 2
  while (existsSync(`${basePath}-${i}`)) {
    i += 1
  }
  return `${basePath}-${i}`
}

export function ensureRepoFromLocalPath(localPath: string): { repoRoot: string; repoName: string } {
  const repoRoot = resolveGitRoot(localPath)
  return {
    repoRoot,
    repoName: path.basename(repoRoot),
  }
}

export function cloneRepo(url: string, reposDir: string, preferredName?: string): { repoRoot: string; repoName: string } {
  const rawName = preferredName || url.split("/").at(-1)?.replace(/\.git$/, "") || "repo"
  const repoName = slugify(rawName) || "repo"

  mkdirSync(reposDir, { recursive: true })
  const targetDir = findUniquePath(path.join(reposDir, repoName))

  run("git", ["clone", url, targetDir])

  return {
    repoRoot: resolveGitRoot(targetDir),
    repoName,
  }
}

export interface CreateWorktreeResult {
  branch: string
  worktreePath: string
}

export function createWorktree(params: {
  repoRoot: string
  workspacesDir: string
  workspaceName: string
  baseRef?: string
  branchPrefix?: string
}): CreateWorktreeResult {
  const safeName = slugify(params.workspaceName) || "workspace"
  const branchBase = `${params.branchPrefix ?? "pc"}/${safeName}`
  const branch = findUniqueBranch(params.repoRoot, branchBase)

  const repoName = path.basename(params.repoRoot)
  const workspacePath = findUniquePath(path.join(params.workspacesDir, repoName, safeName))
  mkdirSync(path.dirname(workspacePath), { recursive: true })

  run("git", ["-C", params.repoRoot, "worktree", "add", "-b", branch, workspacePath, params.baseRef ?? "HEAD"])

  return { branch, worktreePath: workspacePath }
}

export function addWorktreeForBranch(params: {
  repoRoot: string
  worktreePath: string
  branch: string
  baseRef?: string
}) {
  mkdirSync(path.dirname(params.worktreePath), { recursive: true })

  if (commitRefExists(params.repoRoot, params.branch)) {
    run("git", ["-C", params.repoRoot, "worktree", "add", params.worktreePath, params.branch])
    return
  }

  const fallbackBase =
    params.baseRef ??
    resolveWorkspaceBaseRef(params.repoRoot, params.branch) ??
    resolveWorkspaceBaseRef(params.repoRoot, `origin/${params.branch}`)

  if (!fallbackBase) {
    throw new Error(`Branch not found for restore: ${params.branch}`)
  }

  run("git", ["-C", params.repoRoot, "worktree", "add", "-b", params.branch, params.worktreePath, fallbackBase])
}

export function removeWorktree(params: { repoRoot: string; worktreePath: string; force?: boolean }) {
  const args = ["-C", params.repoRoot, "worktree", "remove", params.worktreePath]
  if (params.force) args.push("--force")
  run("git", args)
  runAllowError("git", ["-C", params.repoRoot, "worktree", "prune"])
}

export function getChangedFiles(worktreePath: string): string[] {
  const output = runAllowError("git", ["-C", worktreePath, "status", "--porcelain=v1"], worktreePath)
  const text = String(output.stdout ?? "")
  if (!text.trim()) return []

  return text
    .split(/\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)
}

export interface ChangedFileStat {
  path: string
  added: number | null
  removed: number | null
  status: string
}

export function parsePorcelainStatusLine(line: string): { status: string; file: string } | null {
  if (line.length < 4) return null

  const status = line.slice(0, 2).trim() || "??"
  const rawPath = line.slice(3)
  if (!rawPath) return null

  const file = rawPath.includes(" -> ") ? (rawPath.split(" -> ").pop() ?? rawPath) : rawPath
  if (!file) return null

  return { status, file: file.trim() }
}

export function getChangedFileStats(worktreePath: string): ChangedFileStat[] {
  const statusLines = getChangedFiles(worktreePath)
  const statusMap = new Map<string, string>()

  for (const line of statusLines) {
    const parsed = parsePorcelainStatusLine(line)
    if (!parsed) continue
    statusMap.set(parsed.file, parsed.status)
  }

  const diff = runAllowError("git", ["-C", worktreePath, "diff", "--numstat", "--no-color", "HEAD"])
  const numstatText = (diff.stdout ?? "").trim()
  const statsMap = new Map<string, { added: number | null; removed: number | null }>()

  if (numstatText) {
    for (const line of numstatText.split(/\r?\n/)) {
      const [addedRaw, removedRaw, ...fileParts] = line.split("\t")
      const file = fileParts.join("\t").trim()
      if (!file) continue

      const added = addedRaw === "-" ? null : Number.parseInt(addedRaw || "0", 10)
      const removed = removedRaw === "-" ? null : Number.parseInt(removedRaw || "0", 10)
      statsMap.set(file, {
        added: Number.isFinite(added) ? added : null,
        removed: Number.isFinite(removed) ? removed : null,
      })
    }
  }

  const fileOrder = [...new Set([...statusMap.keys(), ...statsMap.keys()])]
  return fileOrder.map((file) => {
    const status = statusMap.get(file) ?? "M"
    const counts = statsMap.get(file)
    return {
      path: file,
      added: counts?.added ?? null,
      removed: counts?.removed ?? null,
      status,
    }
  })
}

export function getDiff(worktreePath: string, maxLines = 220): string {
  const output = runAllowError("git", ["-C", worktreePath, "--no-pager", "diff", "--no-color", "--unified=3"])
  const text = (output.stdout ?? "").trim()
  if (!text) return ""

  const lines = text.split(/\r?\n/)
  if (lines.length <= maxLines) return text

  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join("\n")
}
