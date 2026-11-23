# 02: Try flow shrinks to accept-all and flagged items

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** Owner approved (D-2026-11-22-27): the per-slice try machinery goes — to-try view with y/n marks per slice, model-written try briefs and steps, the try Detail setting, to-try filter views, `m` land intent on a to-try slice, try briefs in `hud board`. Keep: one 'accept all' action that writes the existing tries.jsonl record, and a list of items the main session flagged (STATE Waiting). Update spec §2.2.4/§2.2.6 lines (y/n marks, board model try briefs, `m`), reference*.md, delegation docs if they mention owner per-slice try. Report lists every removed visible element.

- [x] No per-slice try marks, try briefs or `m`; accept-all and flagged list remain
- [x] No model call is made for try briefs
- [x] tries.jsonl readers still work with old records
- [x] Spec, reference updated; tests pass

## Comments

- Landed in this commit (replay base c4d5ae72b88c561a2d8c9a2d584bd6a2cf3b442b); gate 5/5 passed.
