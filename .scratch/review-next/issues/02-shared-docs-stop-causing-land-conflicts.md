# 02: Shared docs stop causing land conflicts

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Reviews (fable #7, carbon): 31 of 46 land repairs were cherry-pick conflicts, mostly docs/reference.md, reference.zh.md and ARCHITECTURE.md whose paragraphs are single lines up to ~3 KB. Reflow these three files to one sentence per line (no wording change) and update tests that read them; change the standing brief (.hud/brief.md) so slices edit reference.zh.md only when they add a new section, and a translation pass per milestone syncs zh. This commit conflicts with every open worktree: dispatch it only when no worktree job touching docs is open, and land it at once.

- [x] Three docs reflowed one sentence per line; `git diff --word-diff` shows no wording change
- [x] Tests reading the docs pass
- [x] Brief rule for zh updated
- [x] Land with no open docs-touching worktree

## Comments

- Landed in this commit (replay base 8323d80e348bebd80269cb4762e91d12d06b0f07); gate 5/5 passed.
