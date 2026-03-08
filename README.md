# Piductor

Terminal-native orchestration for parallel Pi coding agents across git workspaces.

Built with:
- `@opentui/core`
- `@opentui/react`
- Bun + TypeScript
- SQLite (`bun:sqlite`)

## What it does

- Register repos (local path or remote git URL)
- Create isolated workspaces via `git worktree` (from `HEAD`, a base ref, or an existing branch)
- Start one Pi RPC agent per workspace
- Send agent messages in `prompt`, `steer`, or `follow_up` mode
- Stream assistant output into a chat-style markdown transcript
- Surface thinking/tool/status events in a readable way
- Run setup/run/archive scripts per workspace
- Show per-file change stats (`+/-`) in a review panel
- Collapse sidebars, resize side columns with mouse drag, and collapse sidebar sections
- Navigate a unified workspace tree grouped by repo (`repo -> workspaces`) with expandable repo rows

## Install

```bash
bun install
```

## Run

```bash
bun run dev
```

If Bun is missing in your shell, load your profile first:

```bash
source ~/.bash_profile
bun run dev
```

## In-app commands

```text
/help
/repo add <local-path|git-url> [name]
/repo select <id|name>
/workspace new <name> [baseRef]
/workspace new --branch <branch> [name]
/workspace branches
/workspace select <id|name>
/workspace archive
/agent start [model]
/agent stop
/mode <prompt|steer|follow_up>
/run [command]
/run stop
/status
/diff
/ui left|right|toggle
```

Plain text input sends a message to the selected workspace agent using the current mode.

## Keyboard + mouse controls

- `Ctrl+1` focus workspace tree
- `Ctrl+2` focus workspace tree (alias)
- `Ctrl+3` focus composer
- `Tab` cycle focus
- `Ctrl+Left` collapse/expand left sidebar
- `Ctrl+Right` collapse/expand right sidebar
- `F5` refresh repo/workspace state
- `Ctrl+L` clear visible logs/run output
- `Ctrl+C` exit
- Click top-bar `[+] / [-]` toggles to collapse sidebars
- Drag vertical separators to resize left/right columns
- Click sidebar section headers to collapse/expand workspace tree, status, changes, and run terminal
- Click repo rows in the workspace tree to expand/collapse nested workspaces

## Configuration

Config files are optional and merged in this order:

1. User: `~/.config/piductor/config.json`
2. Project: `./piductor.json`

Project config overrides user config.

Legacy `piconductor` config/data paths are still detected for backward compatibility.

### Example

```json
{
  "piCommand": "pi",
  "defaultModel": "anthropic/claude-sonnet-4-20250514",
  "scripts": {
    "setup": "bun install",
    "run": "bun run test",
    "archive": "echo archived",
    "runMode": "nonconcurrent"
  }
}
```

### Default storage paths

- `dataDir`: `./.piductor`
- `reposDir`: `./.piductor/repos`
- `workspacesDir`: `./.piductor/workspaces`
- `dbPath`: `./.piductor/piductor.sqlite`

## Project structure

- `src/main.ts` — app entrypoint + signal handling
- `src/app-react.tsx` — UI + application controller
- `src/pi-rpc.ts` — Pi RPC subprocess transport
- `src/git.ts` — git clone/worktree/status helpers
- `src/db.ts` — SQLite persistence + migrations
- `src/config.ts` — config loading/merging
- `src/types.ts` — shared domain types

## Development

Typecheck:

```bash
npx tsc --noEmit
```

Run tests:

```bash
npm test
```
