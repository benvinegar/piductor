export interface CommandCatalogEntry {
  command: string
  description: string
}

export const COMMAND_CATALOG: readonly CommandCatalogEntry[] = [
  { command: "repo add <local-path|git-url> [name]", description: "Add a local or remote git repo" },
  { command: "repo select <id|name>", description: "Switch active repo" },
  { command: "workspace new <name> [baseRef]", description: "Create workspace from a base ref" },
  { command: "workspace new --branch <branch> [name]", description: "Create workspace from branch" },
  { command: "workspace branches", description: "List repo branches" },
  { command: "workspace archive [--force]", description: "Archive selected workspace" },
  { command: "workspace archived", description: "List archived workspaces" },
  { command: "workspace restore <id|name>", description: "Restore archived workspace" },
  { command: "workspace select <id|name>", description: "Select workspace" },
  { command: "agent start [model]", description: "Start workspace agent" },
  { command: "agent stop", description: "Stop workspace agent" },
  { command: "agent restart [model]", description: "Restart workspace agent" },
  { command: "agent kill", description: "Force kill workspace agent" },
  { command: "agent list", description: "List agents" },
  { command: "mode <prompt|steer|follow_up>", description: "Set send mode" },
  { command: "pr create [--dry-run]", description: "Create pull request" },
  { command: "pr status", description: "Show pull request summary" },
  { command: "pr checks", description: "Show pull request checks" },
  { command: "pr merge [--merge|--squash|--rebase] [--delete-branch] [--dry-run]", description: "Merge pull request" },
  { command: "run [command]", description: "Run command or configured scripts.run" },
  { command: "run setup", description: "Run configured setup script" },
  { command: "run archive", description: "Run configured archive script" },
  { command: "run stop", description: "Stop active run process(es)" },
  { command: "run mode [concurrent|nonconcurrent]", description: "Set run policy" },
  { command: "test [command]", description: "Run tests or configured scripts.test" },
  { command: "status", description: "Show workspace status" },
  { command: "checklist [show]", description: "Show merge checklist" },
  { command: "checklist add <label>", description: "Add required manual checklist item" },
  { command: "checklist done <key|label>", description: "Mark checklist item complete" },
  { command: "checklist undone <key|label>", description: "Mark checklist item incomplete" },
  { command: "checklist remove <key|label>", description: "Remove manual checklist item" },
  { command: "checklist clear", description: "Remove all manual checklist items" },
  { command: "diff [open|close|next|prev|mode [unified|split]|refresh]", description: "Open/toggle diff review" },
  { command: "ui left|right|toggle", description: "Toggle sidebars" },
  { command: "help", description: "Show command help" },
]

export function findCommandSuggestions(query: string, limit = 8): CommandCatalogEntry[] {
  const normalized = query.trim().toLowerCase()

  if (normalized.length === 0) {
    return [...COMMAND_CATALOG.slice(0, limit)]
  }

  const startsWith = COMMAND_CATALOG.filter((entry) => entry.command.toLowerCase().startsWith(normalized))
  const contains = COMMAND_CATALOG.filter(
    (entry) => !startsWith.includes(entry) && entry.command.toLowerCase().includes(normalized),
  )

  return [...startsWith, ...contains].slice(0, limit)
}

export function buildHelpMarkdown(): string {
  const lines = ["## Commands", ""]

  for (const entry of COMMAND_CATALOG) {
    lines.push(`- \`/${entry.command}\` — ${entry.description}`)
  }

  lines.push("")
  lines.push("Tip: type `/` in the composer to open command autocomplete.")

  return lines.join("\n")
}
