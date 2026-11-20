# 05: Direct chain editing

**Status:** ready-for-agent
**Blocked by:** 02, 03, 04, model-picker/03

**What to build:** Enter on a role focuses its chain in place (Split preview / Classic expand). `I` starts an empty named draft; edits make a "Not saved" draft: `i` add a place via the one-sheet form (Target / Model / Thinking / Done, inline lists with filter, off targets unselectable, the 03 picker for pi models), Enter edits a place, `K`/`J` move, `Del` remove, `s` validate and save in one atomic write and select it, Esc / dirty-leave asks "Discard edits?". Advanced place options (skills, pi_args, args, split) are never stripped: replacing such a target is refused with file open offered. Remove legacy p/P harness cycling, e/E effort cycling and auto-added fallbacks; update reference EN/ZH and Help. Sample frames 5a–5e. See design.md §3 chain and sheet bullets.

- [ ] create empty → cancel writes nothing
- [ ] create empty → pi model + CLI fallback → reorder → save → roster/create use that order
- [ ] failed save keeps the draft; half a chain is never written
- [ ] legacy keys gone from code, Help and reference
- [ ] 40-col frames match the sample
