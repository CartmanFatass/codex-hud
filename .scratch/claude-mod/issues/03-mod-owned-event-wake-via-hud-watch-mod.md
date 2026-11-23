# 03: Mod-owned event wake via hud watch --mod

**Status:** done
**Owner try:** no
**Blocked by:** 01, 02

**What to build:** Design: oracle report of job j173e9f379178e359, section 'Slice 1: Mod-Owned Wake' (pass it with from_jobs). `hud watch --mod` emits JSONL wake records (shared jobRow/actionable, 3 s settlement coalescing, questions immediate), registers a claude-mod watcher marker, exits after 10 min with nothing pending. The mod spawns it on demand (main session in herdr only, not workers, not `claude -p`), wakes an idle session with `$.prompt.submit`, merges events into one `$.session.append` note while busy, parks events on an aborted turn. While the watch is live hud-mcp creates no MCP tasks (batch `hud_create({ jobs })` works) and stops panel typing; absent or dead watch falls back to MCP tasks / `changes` unchanged. Spec §2.1.6 line on MCP tasks (22.25).

- [x] `hud watch --mod` emits `{type:"wake",lines}` JSONL from the shared row logic, writes the claude-mod marker, exits 0 after idle with nothing pending
- [x] With the mod watch live, hud-mcp skips MCP task creation, `hud_create({ jobs })` succeeds, panel typing is off; with it absent or dead, MCP tasks / `changes` / `hud_wait` behave as today
- [x] `claude plugin validate` and `claude plugin test integrations/claude-mod` pass: idle wake submits once per batch; busy burst becomes one appended note; aborted turn parks without waking; workers and non-herdr sessions spawn nothing
- [x] Unit tests for `--mod` output, idle exit, marker liveness, task stand-down; docs/reference.md + reference.zh.md updated (incl. the stale 'install does not register it yet' line)
- [x] Live: in a Claude main session with the mod, a dispatched sonic's report wakes the idle session exactly once and no task-notification row appears

## Comments

- Landed in this commit (replay base aa5cde9cf17b2adcddeb2b9a1a3b9c4ccb0fa37a); gate 5/5 passed.
