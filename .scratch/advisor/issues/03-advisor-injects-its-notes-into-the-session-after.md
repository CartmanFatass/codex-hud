# 03: Advisor injects its notes into the session (after the shadow trial)

**Status:** needs-info
**Owner try:** yes
**Blocked by:** 01, 02

**What to build:** Spec §2.2 (D-2026-11-24-07): a later, separate switch `advisorInject` (default off) delivers the shadow's skill recommendation and rule hits into the main session as one short, non-interrupting note on the next turn (Claude Code through the HUD mod's existing event channel; pi through the HUD pi extension), e.g. `HUD advisor: rules R2, R5 · skill tdd (<path>) — weigh, do not obey blindly`. Reference: oh-my-pi `tmp/refs/oh-my-pi/packages/coding-agent/src/advisor/advise-tool.ts:36-58` (advisory element, guidance attribute). Needs-info until the owner has tried the shadow (tickets 01 and 02) and says which items should be injected and how often.

- [ ] Owner decides scope after the shadow trial; criteria to be written then

## Comments
