# 04: STATE keeps milestones; slice progress comes from tickets

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** docs/llm/post-change-load-2026-11-22.md Rank 7 (owner agreed 2026-11-22): hud_land no longer appends a STATE.md slice row or makes a separate `Record landing` commit; it marks the ticket ready-for-human with the landed sha inside the landed commit (amend of the tested tip before fast-forward, or one commit on top — one commit per land either way). The panel's Progress, To-try and Project board read slice state from .scratch tickets (and existing STATE rows for history); docs/handoff/STATE.md is updated by the main session only at milestone boundaries and stays under 10 KB. Spec §2.2.4 and §5 sentences change accordingly (draft them; the main session tells the owner).

- [ ] A land produces one commit on main and no STATE.md change; the ticket shows ready-for-human with the sha
- [ ] Home progress and To-try show the same slices as before on a synthetic project
- [ ] npm test and check:fixtures pass

## Comments
