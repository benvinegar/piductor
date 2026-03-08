import { slugify } from "./git"

export interface ParsedWorkspaceNewCommand {
  workspaceName: string
  baseRef: string
  fromBranch: boolean
  requestedBranch: string | null
}

export function workspaceNewUsage() {
  return "Usage: /workspace new <name> [baseRef] | /workspace new --branch <branch> [name]"
}

export function suggestWorkspaceNameFromBranch(branchRef: string): string {
  const normalized = branchRef
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^origin\//, "")

  return slugify(normalized) || "workspace"
}

export function parseWorkspaceNewArgs(args: string[]): ParsedWorkspaceNewCommand | null {
  if (args.length === 0) return null

  let branch: string | null = null
  const positional: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]

    if (token === "--branch" || token === "-b") {
      const value = args[i + 1]
      if (!value) return null
      branch = value
      i += 1
      continue
    }

    if (token.startsWith("-")) {
      return null
    }

    positional.push(token)
  }

  if (branch) {
    if (positional.length > 1) return null

    return {
      workspaceName: slugify(positional[0] || suggestWorkspaceNameFromBranch(branch)) || "workspace",
      baseRef: branch,
      fromBranch: true,
      requestedBranch: branch,
    }
  }

  if (positional.length === 0 || positional.length > 2) return null

  return {
    workspaceName: slugify(positional[0]) || "workspace",
    baseRef: positional[1] || "HEAD",
    fromBranch: false,
    requestedBranch: null,
  }
}
