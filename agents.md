# Coding Agent Guidance

This file is for automated coding agents working in this repository.

## Scope

This project is the **React-based** OpenTUI prototype for Pi Conductor.

- Use `@opentui/react` + `@opentui/core`
- **Do not migrate to Solid** unless explicitly requested
- Keep behavior aligned with current CLI/TUI UX

## Setup expectations

```bash
bun install
npx tsc --noEmit
```

If `bun` is not found, run:

```bash
source ~/.bash_profile
```

## Core architecture

### Controller + view split

`src/app-react.tsx` contains both:

1. **PiConductorApp** class (controller/state/side-effects)
2. **PiConductorView** (React UI)

Treat this as a deliberate split:

- Controller owns mutable app/runtime state
- View should be mostly presentational + event wiring
- Snapshot bridge is `subscribe/getSnapshot/emitSnapshot`

### Important modules

- `src/pi-rpc.ts`: manages Pi RPC subprocess and request/response lifecycle
- `src/git.ts`: git clone/worktree/status helpers
- `src/db.ts`: SQLite persistence (repos/workspaces/agents)
- `src/config.ts`: user + project config merge
- `src/types.ts`: domain types

## UI/UX invariants to preserve

- 3-column layout: left navigator, center conversation+composer, right status/review/run
- Top bar with left/right collapse toggles
- Sidebars collapsible via mouse + keyboard + `/ui` command
- Side columns resizable via draggable vertical separators
- Conversation panel uses markdown rendering, including:
  - `### You` / `### Pi`
  - thinking blocks (`💭`)
  - tool lines (`⚙️`)
- Agent extension UI requests are auto-cancelled (non-blocking)

## Command surface (keep backward compatible)

`/help`, `/repo ...`, `/workspace ...`, `/agent ...`, `/mode ...`, `/run ...`, `/status`, `/diff`, `/ui ...`

If you add/rename commands, update:

1. in-app `/help` text
2. `README.md`

## Persistence/data rules

- DB schema lives in `src/db.ts` migration block
- Keep existing tables compatible unless migration is intentional
- Workspaces are soft-archived in DB and worktree path is removed from git

## Safety checks before finishing

1. `npx tsc --noEmit` passes
2. App still starts with `bun run dev`
3. README and help text match behavior changes
4. If deps change, keep lockfiles in sync (`bun.lock` and `package-lock.json`)

## Style preferences

- Keep changes focused and minimal
- Prefer explicit, readable code over clever abstractions
- Avoid large refactors unless requested
- Preserve current terminal-first UX patterns
