# M3 Validation Pack (scripts + tests + diff workflows)

Date: 2026-03-09
Scope: `TODO-2b143cd6`

## Automated validation

### Baseline checks

- `npm test` ✅ (21 files, 81 tests)
- `npx tsc --noEmit` ✅

### Focused M3 coverage in test suite

- Script command/parser + run-mode policy:
  - `tests/run-command.test.ts`
  - `tests/run-policy.test.ts`
- Process/log structure:
  - `tests/run-log.test.ts`
- Test workflow status:
  - `tests/test-status.test.ts`
- Diff review parsing/selection:
  - `tests/diff-review.test.ts`
- Readiness signal logic:
  - `tests/workspace-readiness.test.ts`
- Diff fingerprint determinism:
  - `tests/diff-fingerprint.test.ts`

## Manual tmux soak (pane `0:7.1`)

### Sequence A — run lifecycle + mode behavior

1. `/run mode concurrent`
2. `/run sleep 5`
3. `/run sleep 5`
4. `/run stop`
5. `/run mode nonconcurrent`
6. `/run sleep 4`
7. `/run sleep 4` (replacement expected)

Observed:
- Concurrent mode allowed parallel run starts.
- `/run stop` terminated active runs and logged stop/escalation flow.
- Nonconcurrent mode replaced prior run as expected.

### Sequence B — test status + readiness transitions

1. `/test false`
2. `/test true`

Observed:
- Status panel updated to `tests fail (code=1)` then `tests pass (code=0)`.
- Readiness reflected test state and other gates accurately.

### Sequence C — diff modal + review gate

1. `/diff open`
2. `/diff mode split`
3. `Esc` to close modal

Observed:
- Modal opens with proper overlay and OpenTUI diff renderer.
- Unified/split mode toggle works.
- `Esc` closes modal.
- Readiness shows `ready` after successful test and diff review completion.

## Regressions found/fixed during M3 work

- Composer focus bleed: pressing Enter sometimes opened diff instead of submitting prompt.
  - Fixed by forcing composer focus on input container/textarea click (`f4457ba`).
- Diff modal close behavior:
  - `Esc` close and close affordances hardened in modal flow (`48fd1ec`, `ad037e6`).

## Exit criteria

- [x] Passing automated tests and typecheck
- [x] Repeatable manual soak steps recorded
- [x] Script/test/diff flows verified together
- [x] Regressions documented with fixes
