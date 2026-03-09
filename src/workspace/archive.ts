export interface ParsedWorkspaceArchiveArgs {
  force: boolean
}

export function parseWorkspaceArchiveArgs(args: string[]): ParsedWorkspaceArchiveArgs | null {
  let force = false

  for (const token of args) {
    if (token === "--force") {
      force = true
      continue
    }

    return null
  }

  return { force }
}

export function workspaceArchiveUsage() {
  return "Usage: /workspace archive [--force]"
}
