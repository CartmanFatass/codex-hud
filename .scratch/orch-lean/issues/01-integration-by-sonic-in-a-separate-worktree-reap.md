# 01: Integration by sonic in a separate worktree, reap cherry-picked worktrees

**Status:** done
**Blocked by:** none

**What to build:** docs/llm/orch-load-2026-11-22.md rank 1 (D-2026-11-22-15): a documented sonic integration job (docs/delegation.md + convention text) cherry-picks a slice into a fresh integration worktree, runs build, build:test, test:mjs twice, test:unit, check:fixtures, and reports at most 10 lines (pass/fail, failing test names, first error line); imp on conflict; the main session decides and pushes. The watcher also reaps closed clean worktrees whose commits are already on the base branch by patch identity (spec §2.1.3 sentence as told to the owner).

- [x] A cherry-picked, clean, closed worktree is reaped; a dirty or unpicked one is kept
- [x] The integration brief template is in docs/delegation.md
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22 landed 8cf766b6 (imp on astra j408a4de6136d2eeb): rev-list --cherry-pick picks; later picks rechecked when the base sha changes (≤4/scan, 7 days); spec §2.1.3 sentence; integration template in docs/delegation.md. First integration by sonic (j67d04ce32de784c3, deepseek flash): clean pick, 1011/1011 twice, 92/92, fixtures OK; main fast-forwarded. tmp/wt-new.sh worktrees are not HUD-managed and are not reaped; use hud_create isolation: worktree for that.
