# 04: Flake collection repair: dispatch through ticket admission, named cases only, scoped keys, no silent drops

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** 01
**Objective:** unattended

**What to build:** Repair of chores/01 after the milestone review (reviewer job j42cd2d46ab80e99d, run q8b08879d49c9a03a; read its report for file:line). Fix all four: (1) BLOCKER: a promoted running-list ticket is dispatched with a standalone dispatchJob call (src/mcp/land-flakes.ts ~413-425) that the shipped defaults reject (auto-prewalk on, imp prewalk on) and pane-less unattended lands reject with herdr_required. Dispatch through the queue-capable ticket admission path instead (the same path hud_tickets run uses, pane-less capable), so no approximation of dispatch rules lives in land-flakes; verify with shipped settings (auto-prewalk on) and a pane-less land in tests (the thin-mcp harness disables auto-prewalk by default; the new test must not). (2) An unidentified failure (no parsed test case; land-runner substitutes the gate label) must not count toward the repeat rule; record it as evidence (command, flow, log) but only named tests repeat. (3) The dispatch request key must include the project identity and the attempt, and a failed or stopped earlier attempt must not return the old job as a successful admission. (4) A refused ticket edit (hand edit on the running list) or a dispatch refusal must not be silently dropped: keep the land green and the owner's edit intact, record the pending collection on the land receipt, and retry it idempotently from the recorded rerun on the next land or service wake (no gate rerun). Also fold the duplicated dedupe loop (land-flakes.ts ~374-401) into one pass.

- [ ] A promoted running-list ticket starts one imp through ticket admission with shipped settings, from a pane and pane-less (tests)
- [ ] Unidentified gate failures are recorded but never trigger the repeat rule (test)
- [ ] Dispatch keys are project- and attempt-scoped; a failed attempt does not block later admission (test)
- [ ] A refused ticket edit or dispatch is recorded on the land receipt and retried idempotently later without a gate rerun (test)

## Comments
