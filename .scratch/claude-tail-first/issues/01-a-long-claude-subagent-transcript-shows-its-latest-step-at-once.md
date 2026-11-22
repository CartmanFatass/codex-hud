# 01: A long Claude subagent transcript shows its latest step at once

**Status:** ready-for-agent
**Blocked by:** none (panel lane, after monitor-state/04)

**What to build:** Proposal docs/neon-proposal/11-claude-native-tail-first.md with its §6 defaults (owner, 2026-11-22): Claude subagent transcripts only (not main rollouts or Codex); a first-seen file over 64 KiB is read tail-first within a budget of 16 files per refresh; until the forward read reaches line one, order by the meta file's birthtime (missing birthtime sorts last); preview text never feeds the one-line summary (no new model calls). The spec's M5 candidate "a transcript is read tail-first on open".

- [ ] A synthetic 5 MB subagent transcript shows its latest step in the first frame; nesting fills in after
- [ ] Refresh read budget respected (test); npm test and check:fixtures pass

## Comments
