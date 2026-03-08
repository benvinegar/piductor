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

export function removeWorktree(params: { repoRoot: string; worktreePath: string; force?: boolean }) {
  const args = ["-C", params.repoRoot, "worktree", "remove", params.worktreePath]
  if (params.force) args.push("--force")
  run("git", args)
  runAllowError("git", ["-C", params.repoRoot, "worktree", "prune"])
}

export function getChangedFiles(worktreePath: string): string[] {
  const output = runAllowError("git", ["-C", worktreePath, "status", "--short"], worktreePath)
  const text = (output.stdout ?? "").trim()
  if (!text) return []
  return text.split(/\r?\n/)
}

export interface ChangedFileStat {
  path: string
  added: number | null
  removed: number | null
  status: string
}

export function getChangedFileStats(worktreePath: string): ChangedFileStat[] {
  const statusLines = getChangedFiles(worktreePath)
  const statusMap = new Map<string, string>()

  for (const line of statusLines) {
    const status = line.slice(0, 2).trim() || "??"
    const file = line.slice(3).trim()
    if (!file) continue
    statusMap.set(file, status)
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
