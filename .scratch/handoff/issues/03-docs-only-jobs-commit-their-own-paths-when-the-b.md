# 03: Docs-only jobs commit their own paths when the brief asks

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Owner 2026-11-24 accepted. Two workers asked the same question today because the role prompt says "Elsewhere leave changes in the working tree" while their briefs said to commit (design samples in the main checkout). toktrack patched it in its `.hud/brief.md`; make it the default for every project. In `packages/hud-mcp/instructions/implementer.md`, `frontend-implementer.md` and `general.md` (line ~19-24, the sentence with "Elsewhere leave changes in the working tree"), keep the default but add: when the brief asks a job without a managed worktree to commit, commit only the paths the job wrote, with a pathspec (`git add <paths> && git commit -m ... -- <paths>`), never others' changes; no push. Update any digest or snapshot test that pins these files. Keep the wording short; no other change.

- [x] The three instruction files carry the rule; their tests pass
- [x] The land gate passes

## Comments

- Landed in this commit (replay base bc317add935e25c483510e773951339c6b89a117); gate 5/5 passed.
