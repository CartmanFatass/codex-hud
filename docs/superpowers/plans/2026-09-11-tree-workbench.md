# Tree Workbench Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task. The user approved execution in this conversation; continue without additional approval gates.

**Goal:** Make the tree a keyboard/mouse workbench with reliable nesting, stable active-first sorting, independent panes, and workspace changes with diff previews.

**Architecture:** Keep rollout and Git collection separate from terminal input and pure rendering. Preserve the existing compact HUD and legacy panel renderer. Add a workbench state/layout/render layer used by tree-page, with per-pane scrolling and selection identities. Use the existing rollout parser to inspect the selected agent.

**Tech Stack:** TypeScript, Node built-ins, ANSI terminal sequences, Git CLI, node:test. No additional runtime dependencies.

**Spec:** User-approved design in this conversation: sibling-only active branch ordering; no sorting on ordinary token events; nested source parent fallback; Agents/Details/Changes/Tasks-Checks-Events panes; independent scrolling, focus, zoom and responsive layout; workspace-wide Git attribution; no Ctx trend.

## Global Constraints

- Work in the current checkout, preserving all pre-existing edits and earlier fixes. A separate checkout would omit the approved uncommitted panel implementation.
- No staging, commits, checkout, or other Git mutations in product actions.
- Preserve F12 observation / Shift+F12 interaction and compact HUD context values.
- Use spawn/execFile argument arrays for Git; bounded output and timeouts; safe handling of unusual filenames and terminal control characters.
- No invented task percentages, test success, or agent ownership of working tree files.

### Task 1: Tree metadata and ordering
Files: src/utils/session-parent.ts, src/collectors/subagent-tree.ts, src/collectors/rollout.ts, src/collectors/session-finder.ts, src/types.ts, tests/unit/subagent-status.test.ts, tests/unit/tree-order.test.ts.
- [x] Add failing tests for nested-source parent links, selected-agent identity, sibling-only sorting and active descendants.
- [x] Implement shared parent extraction; expose rolloutPath and latest turn start on tree nodes; add stable recursive sorting (active branches, failed, unknown, completed; latest start within active; creation then id fallback).
- [x] Run targeted tests and build.

### Task 2: Read-only Git changes
Files: src/collectors/git-changes.ts, tests/unit/git-changes.test.ts.
Interfaces: GitChanges { root, branch, ahead, behind, files, error? }, GitChangedFile { path, previousPath?, index, worktree, added, removed, binary, conflict }; collectGitChanges(cwd): Promise<GitChanges>; readGitDiff(root, file): Promise<string[]>.
- [x] Test real temporary Git repositories: staged/unstaged changes, new/untracked, renamed and unusual filenames, binary, no repository, conflict.
- [x] Implement porcelain -z status and numstat parsing, bounded diff including staged and unstaged sections, untracked preview, repository summary.
- [x] Run tests and verify collection does not modify the repository.

### Task 3: Workbench input, state and layout
Files: src/render/workbench-state.ts, src/render/workbench.ts, src/utils/workbench-input.ts, tests/unit/workbench.test.ts.
Interfaces: WorkbenchState with focus, per-pane scroll, selected file path, zoom, activity tab, tree PanelState and sort mode; renderWorkbench(input) returns lines and pane rectangles for mouse hit testing; input decoder buffers fragmented escape sequences.
- [x] Test focus cycling, independent scroll, mouse wheel targeting, page keys, zoom/back, resize, selection reconciliation and narrow/wide terminal bounds.
- [x] Implement Agents/Details/Changes/Activity panes, live agent and file preview selection, tabbed Tasks/Checks/Events, focus-aware footer and overflow counters.
- [x] Keep row identity stable across refreshes; sort snapshots update on status/start changes only; tree wheel navigation selects rows, detail wheel scrolls text.
- [x] Run focused tests.

### Task 4: Live integration and documentation
Files: src/tree-page.ts, README.md, README.zh.md, tests/unit/workbench-live.test.ts.
- [x] Wire selected-agent parser, throttled Git refresh, selected diff cache, lifecycle/tool event list, cleanup of terminal mouse tracking and input buffering.
- [x] Use workbench layout for terminal resize and remove Ctx history from live tree page. Preserve compact HUD.
- [x] Verify with a real PTY: initial render, Tab, arrows, scroll, file/diff selection, zoom, resize and clean exit.
- [x] Update key reference and README in English/Chinese.
- [x] Run npm test, npm run build, git diff --check, relevant existing rollout suites, then independent code review. Resolve material findings.

### Follow-up scope approved during implementation
- [x] Output throughput from timestamped output-token counters; preserve last value when idle.
- [x] Mouse-click pane titles collapse/reopen, redistribute space; Tasks disabled and Activity collapsed by default.
- [x] Standalone settings with draft/save/back/reset, persisted display and pane preferences.
- [x] Four width presets: 16 / original auto20–30 / 45 / 70; reserve main session space.
- [x] Actual Codex session switching from clicked agent and Main button via verified picker adapter.
- [x] Rerun complete verification after follow-up scope; resolve review findings.

- [x] Restore per-row model/effort badges, including 16-column layout.
- [x] Filter injected recommended_plugins/environment messages from task summaries; retain real task across incremental/full reads.

Verification: unit/test files, production TypeScript build, real PTY flow, independent tmux toggle/width suite, existing rollout/context/queue suites, and whitespace check. Session-switch state machine is tested with a simulated Codex picker; no input was injected into the user's active Codex conversation during development.

### Follow-up: switch redraw fix
The original adapter reopened the native picker after selecting a thread, causing an extra visible popup and transcript redraw. It also always reset selection to Home and walked each row. Now it batches movement to an already-visible exact UUID, verifies again before Enter, and does not reopen the picker afterward. Results distinguish a submitted switch request from a session already confirmed as current. Regression tests cover single-open behavior, current-thread no-op movement, draft preservation, and picker refresh during batched movement. Native transcript refresh during an actual thread change remains.
