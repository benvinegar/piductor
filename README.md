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
- Resume prior workspace sessions after app restart (conversation replay + runtime state)
- Always start in a lobby/splash screen with no active workspace selected
- Open a local project from the lobby via an inline button + path modal
- Surface thinking/tool/status events in a persistent Codex-like timeline (no disappearing action trail)
- Run setup/run/archive scripts per workspace
- Archive and restore workspaces
- Show per-file change stats (`+/-`) in a review panel
- Collapse sidebars, resize side columns with mouse drag, and collapse sidebar sections
- Switch between 5 built-in UI themes (`/theme`) and available agent models (`/model`) via picker modals
- Navigate a unified workspace tree grouped by project (`project -> workspaces`) with caret toggles, `[+]` quick-create workspace actions, and persisted collapse/expand state

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
/workspace archive [--force]
/workspace archived
/workspace restore <id|name>
/agent start [model]
/agent stop
/mode <prompt|steer|follow_up>
/model
/theme
/pr create [--dry-run]
/pr status
/pr checks
/pr merge [--merge|--squash|--rebase] [--delete-branch] [--dry-run]
/run [command]
/run setup
/run archive
/run stop
/run mode [concurrent|nonconcurrent]
/test [command]
/status
/checklist [show]
/checklist add <label>
/checklist done <key|label>
/checklist undone <key|label>
/checklist remove <key|label>
/checklist clear
/diff [open|close|next|prev|mode [unified|split]|refresh]
/ui left|right|toggle
```

Plain text input sends a message to the selected workspace agent using the current mode.

`/help` opens a modal command reference.

Type `/` in the composer to open command autocomplete (mouse-select or `Tab` to apply a suggestion).

Use `/model` to open the model picker (↑/↓ to select, Enter to apply). If the workspace agent is running, the model switches immediately; otherwise the selection is saved for next `/agent start`.

Use `/theme` to open the theme picker (↑/↓ to select, Enter to apply). Theme selection persists across restarts.

`/pr create` requires GitHub CLI auth (`gh auth login`) and is blocked if required merge checklist items are incomplete. Use `/pr status`, `/pr checks`, and `/pr merge` for full PR lifecycle in-app.

## Keyboard + mouse controls

- `Ctrl+1` focus workspace tree
- `Ctrl+2` focus workspace tree (alias)
- `Ctrl+3` focus composer
- Composer: `Enter` sends, `Shift+Enter` inserts newline, `Ctrl+J` inserts newline
- `Tab` in composer toggles Plan/Build send mode (falls back to focus cycling outside composer)
- `Ctrl+Left` collapse/expand left sidebar
- `Ctrl+Right` collapse/expand right sidebar
- `F5` refresh repo/workspace state
- `Ctrl+L` clear visible logs/run output
- `Ctrl+C` exit
- Click top-bar `[+] / [-]` toggles to collapse sidebars
- From the lobby splash, click `Open project` to add a local repo path
- Drag vertical separators to resize left/right columns
- Click sidebar section headers to collapse/expand workspace tree, status, changes, and run terminal
- Click repo rows in the workspace tree to expand/collapse nested workspaces
- Diff review opens as a modal overlay with mouse controls: click `Mode`, `Close`, `◀/▶ File`, and `◀/▶ Hunk` buttons
- Optional keyboard shortcuts in diff review (when focus is not in composer): `Esc` or `q` close review, `m` toggle unified/split, `n`/`p` next/prev file
- `Esc` closes command/help, theme/model, and create-workspace modals

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
    "run": "bun run dev",
    "test": "bun run test",
    "archive": "echo archived",
    "runMode": "nonconcurrent"
  }
}
```

### Script environment variables

Setup/run/archive scripts receive these vars:

- `PIDUCTOR_WORKSPACE_NAME`
- `PIDUCTOR_WORKSPACE_PATH`
- `PIDUCTOR_ROOT_PATH`
- `PIDUCTOR_DEFAULT_BRANCH`
- `PIDUCTOR_PORT` (base of a 10-port range for the workspace)

Compatibility aliases are also provided with `CONDUCTOR_*` names.

### Default storage paths

- `dataDir`: `./.piductor`
- `reposDir`: `./.piductor/repos`
- `workspacesDir`: `./.piductor/workspaces`
- `dbPath`: `./.piductor/piductor.sqlite`

## Project structure

- `src/main.ts` — app entrypoint + signal handling
- `src/ui/` — OpenTUI React view/controller shell (`app-react.tsx`, loading, rendering helpers)
- `src/agent/` — agent lifecycle/control/state helpers
- `src/network/` — Pi RPC transport + stderr filtering
- `src/run/` — run/test command policy, logs, stream buffering, script env
- `src/review/` — diff parsing/fingerprinting helpers
- `src/workspace/` — workspace tree, new-workspace args, session/readiness logic
- `src/vcs/` — git/worktree and PR command helpers
- `src/core/` — config, DB, shared types

## Development

Typecheck:

```bash
npx tsc --noEmit
```

Run tests:

```bash
npm test
```
