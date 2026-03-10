# Piductor

Piductor is a terminal-native control plane for teams running Pi coding agents across git workspaces and PR branches.

[![GitHub stars](https://img.shields.io/github/stars/benvinegar/piductor?style=flat-square)](https://github.com/benvinegar/piductor/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/benvinegar/piductor?style=flat-square)](https://github.com/benvinegar/piductor/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/benvinegar/piductor?style=flat-square)](https://github.com/benvinegar/piductor/pulls)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-f472b6?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/benvinegar/piductor/pulls)

## Why Piductor

- **Parallel branch execution**: run one agent per `git worktree` workspace.
- **PR-oriented review**: Changes panel shows branch diff against `main`, not just uncommitted files.
- **Single surface area**: manage repo setup, agent runs, tests, diffs, checklists, and PR actions in one TUI.
- **Persistent sessions**: keep workspace runtime state, conversation history, selected model, and send mode across restarts.
- **Mouse-first UX**: desktop-style terminal layout with collapsible sidebars, modal pickers, and tree navigation.

## Install

### Prerequisites

- [Bun](https://bun.sh/)
- `git`
- `pi` CLI available on `PATH` (used in RPC mode)
- Optional: [`gh`](https://cli.github.com/) for `/pr ...` commands

### Option 1: npm (global)

```bash
npm i -g piductor
```

### Option 2: from source

```bash
git clone https://github.com/benvinegar/piductor.git
cd piductor
bun install
```

## Quick start

```bash
piductor
```

If you are running from a local checkout instead of a global install:

```bash
bun run dev
```

Then inside the app:

1. On the splash screen, click **Open project** and provide a local repo path.
2. Expand the project in the left tree and click **[+]** to create a workspace.
3. Select a workspace row.
4. Run `/agent start` and send a prompt.
5. Use the right-side **Changes** panel to review branch diffs before opening a PR.

## Typical workflow

1. Add/select a project.
2. Create a workspace branch (`/workspace new ...`).
3. Start an agent (`/agent start`) and iterate in chat.
4. Run checks (`/test`, `/run`).
5. Review branch changes and checklist status.
6. Open and manage PRs with `/pr create`, `/pr status`, `/pr checks`, `/pr merge`.

> PR commands require `gh auth login` in your shell.

## Common commands

Use `/help` in-app for the full command catalog.

```text
/repo add <local-path|git-url> [name]
/repo select <id|name>
/workspace new <name> [baseRef]
/workspace new --branch <branch> [name]
/workspace select <id|name>
/agent start [model]
/agent stop
/model
/theme
/test [command]
/checklist [show]
/pr create [--dry-run]
/pr status
/pr checks
/pr merge [--merge|--squash|--rebase] [--delete-branch] [--dry-run]
```

## Configuration

Piductor merges config from:

1. `~/.config/piductor/config.json`
2. `./piductor.json` (project-local override)

Example:

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

Default local data directory: `./.piductor`.

## Architecture

- `src/ui/` — OpenTUI React app shell, renderer, interaction logic
- `src/agent/` — agent lifecycle and reconnect handling
- `src/network/` — Pi RPC transport
- `src/vcs/` — git/worktree and PR helpers
- `src/workspace/` — workspace tree/readiness/session logic
- `src/core/` — config, persistence, shared types

## Development

```bash
npx tsc --noEmit
npm test --silent
```

For UI changes, verify behavior in a live tmux session before merging.

## Docs

- Contributor automation guidance: [agents.md](agents.md)
- Validation notes: [docs/m3-validation-pack.md](docs/m3-validation-pack.md)
- Runtime command reference: `/help` inside the app

## Contributing

- Open an issue describing bugs, UX gaps, or feature proposals.
- Keep PRs focused and include before/after context for UI changes.
- Run typecheck and tests before submitting.
- If command behavior changes, update code + tests + README together.

## Security

Please do **not** report vulnerabilities in public issues.

Use GitHub private vulnerability reporting:

- https://github.com/benvinegar/piductor/security/advisories/new

## License

[MIT](LICENSE) © Ben Vinegar

## Community / support

- Issues: https://github.com/benvinegar/piductor/issues
- Pull requests: https://github.com/benvinegar/piductor/pulls
