# 02: Try flow shrinks to accept-all and flagged items

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** 01

**What to build:** Owner approved (D-2026-11-22-27): the per-slice try machinery goes — to-try view with y/n marks per slice, model-written try briefs and steps, the try Detail setting, to-try filter views, `m` land intent on a to-try slice, try briefs in `hud board`. Keep: one 'accept all' action that writes the existing tries.jsonl record, and a list of items the main session flagged (STATE Waiting). Update spec §2.2.4/§2.2.6 lines (y/n marks, board model try briefs, `m`), reference*.md, delegation docs if they mention owner per-slice try. Report lists every removed visible element.

- [ ] No per-slice try marks, try briefs or `m`; accept-all and flagged list remain
- [ ] No model call is made for try briefs
- [ ] tries.jsonl readers still work with old records
- [ ] Spec, reference updated; tests pass

## Comments
