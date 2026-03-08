# Pi Conductor (OpenTUI Prototype)

Terminal-native orchestration for parallel Pi workspaces.
Built with OpenTUI + OpenTUI React.

## What works right now

- Add repos from local path or git URL.
- Create isolated workspaces via `git worktree`.
- Start/stop one Pi RPC agent per workspace.
- Send `prompt`, `steer`, or `follow_up` messages.
- Stream agent/tool logs into the UI.
- Run setup/run/archive scripts.
- View changed files + diff preview.

## Install

```bash
bun install
```

## Run

```bash
bun run dev
```

## Commands (inside the app)

```text
/help
/repo add <local-path|git-url> [name]
/repo select <id|name>
/workspace new <name> [baseRef]
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

## Config

Optional config files:

- User: `~/.config/piconductor/config.json`
- Project: `./piconductor.json`

Example:

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
