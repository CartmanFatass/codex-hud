# 01: Integration by sonic in a separate worktree, reap cherry-picked worktrees

**Status:** claimed
**Blocked by:** none

**What to build:** docs/llm/orch-load-2026-11-22.md rank 1 (D-2026-11-22-15): a documented sonic integration job (docs/delegation.md + convention text) cherry-picks a slice into a fresh integration worktree, runs build, build:test, test:mjs twice, test:unit, check:fixtures, and reports at most 10 lines (pass/fail, failing test names, first error line); imp on conflict; the main session decides and pushes. The watcher also reaps closed clean worktrees whose commits are already on the base branch by patch identity (spec §2.1.3 sentence as told to the owner).

- [ ] A cherry-picked, clean, closed worktree is reaped; a dirty or unpicked one is kept
- [ ] The integration brief template is in docs/delegation.md
- [ ] npm test and check:fixtures pass

## Comments
