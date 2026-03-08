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

## Visual style system (important)

Future UI changes should match the current minimal style language.

### Border philosophy

- Avoid superfluous nested boxes.
- Keep strong borders where they help structure:
  - top bar
  - center conversation/composer containers
- Left and right sidebars should be **flat** (no outer border box, no per-section border boxes).

### Sidebar section pattern (left + right)

Use collapsible text headers instead of boxed sections.

- Header format: `▾ <Title> ─────` (expanded) / `▸ <Title> ─────` (collapsed)
- Use `formatSectionHeader(title, collapsed, width)` to build header lines.
- Header is clickable (`onMouseDown`) to toggle collapsed state.
- Keep one blank line of breathing room between major sections.
- Body content appears with a small top margin under header (`marginTop: 1`).

Current sections to keep stylistically consistent:

Left sidebar:
1. Workspaces (single tree view)
   - repo rows are expandable/collapsible
   - nested workspace rows belong to their repo

Right sidebar:
1. Workspace Status
2. Changes
3. Run Terminal

### Color/style tokens to reuse

- Left panel background: `#11151f`
- Right panel background: `#111013`
- Sidebar section header bg:
  - expanded: `#182031`
  - collapsed: `#1a2332`
- Sidebar section header text: `#bfdbfe`
- Status/diff body text: `#d1d5db`
- Terminal body text: `#a7f3d0`
- Resizer colors:
  - idle: `#273142`
  - active/dragging: `#60a5fa`

### Layout sizing rules

- Keep existing width constraints unless explicitly requested:
  - left: min `24`, default `36`, max `72`
  - right: min `34`, default `52`, max `84`
  - center min width: `52`
- Side panels use light horizontal padding (`paddingLeft: 1`, `paddingRight: 1`).
- Left workspace tree section should fill available left-panel height when expanded.
- Run Terminal section uses fixed compact height when expanded (currently `10`).

### Interaction consistency

- Resizer remains the visual separator between columns (1-cell draggable bar).
- Drag robustness uses body-level mouse handlers; preserve this approach.
- `Ctrl+1` / `Ctrl+2` should reveal and focus the left workspace tree even if the section is collapsed.
- Clicking a repo row in the workspace tree should expand/collapse that repo and keep workspace ownership visually explicit.
- Any new mouse interaction should still have keyboard/command fallback where practical.

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
2. `npm test` passes
3. App still starts with `bun run dev`
4. README and help text match behavior changes
5. If deps change, keep lockfiles in sync (`bun.lock` and `package-lock.json`)

## Style preferences

- Keep changes focused and minimal
- Prefer explicit, readable code over clever abstractions
- Avoid large refactors unless requested
- Preserve current terminal-first UX patterns
