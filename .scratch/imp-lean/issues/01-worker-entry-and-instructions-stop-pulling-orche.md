# 01: Worker entry and instructions stop pulling orchestrator docs

**Status:** done
**Blocked by:** none

**What to build:** docs/llm/imp-load-2026-11-22.md ranks 1, 4, 6 (instruction part), 7; D-2026-11-22-17. Archive the 2026-11-03 root AGENTS.md to docs/archive/root/ and write a ~25-line worker-safe AGENTS.md (read the brief and docs/ARCHITECTURE.md §8; do not read STATE, delegation, spec in full or archived docs unless the brief names them). Trim CLAUDE.md so the orchestrator read list is marked orchestrator-only. In packages/hud-mcp/instructions/{implementer,general,frontend-implementer}.md and integrations/pi/roles/implementer.md: drop the CodeGraph paragraphs (search with grep and read); git self-checks are `git status -s`, `git diff --stat`, `git diff --check` (no full diff dumps); batch independent reads in one turn and read large files by range; targeted tests while iterating, one full `npm test` at the end, repeat it only when a fix touched shared code; never poll with sleep loops. Keep the release-archive exclusion of .codegraph as is.

- [x] A fresh pi imp in a worktree gets no instruction that sends it to STATE.md, delegation.md or docs/archive
- [x] No worker instruction mentions CodeGraph
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed b7852e69 via sonic gate (test:mjs 1024/1024 ×2, unit 92/92, fixtures OK).
