# 05: Help no longer lists backup skills

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Owner approved (D-2026-11-22-27): remove the backup-skills section from Help (`?`) with its collector, translations and wrapping code. Write `docs/optional-skills.md` listing the shipped uninstalled skills (name + one-line description, English) so the main session can still point to them; the skill files stay shipped. Update spec §2.2.9 and reference*.md.

- [x] Help has no backup-skills section; collector and strings removed
- [x] docs/optional-skills.md lists the shipped optional skills
- [x] Spec, reference updated; tests pass

## Comments

- Landed in this commit (replay base 816f498c60249e3fe64ab0e616fbf3ae067863a8); gate 5/5 passed.
