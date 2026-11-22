# 01: A long Claude subagent transcript shows its latest step at once

**Status:** done
**Blocked by:** none (panel lane, after monitor-state/04)

**What to build:** Proposal docs/neon-proposal/11-claude-native-tail-first.md with its §6 defaults (owner, 2026-11-22): Claude subagent transcripts only (not main rollouts or Codex); a first-seen file over 64 KiB is read tail-first within a budget of 16 files per refresh; until the forward read reaches line one, order by the meta file's birthtime (missing birthtime sorts last); preview text never feeds the one-line summary (no new model calls). The spec's M5 candidate "a transcript is read tail-first on open".

- [x] A synthetic 5 MB subagent transcript shows its latest step in the first frame; nesting fills in after
- [x] Refresh read budget respected (test); npm test and check:fixtures pass

## Comments

- 2026-11-22 main: landed 3a9b7166. Synthetic 5 MB transcript: latest step on frame 1 (1–7 ms) vs ~4 s before; goldens unchanged. Suite 970/970.
