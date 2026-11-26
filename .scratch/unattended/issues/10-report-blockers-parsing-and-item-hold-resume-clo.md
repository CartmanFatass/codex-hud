# 10: Report Blockers parsing and item-hold resume close the gaps found in review

**Status:** ready-for-agent
**Live try:** none (fixture tests cover the parsing and resume cases; main verifies with one synthetic ticket queue)
**Blocked by:** none
**Objective:** unattended

**What to build:** Milestone review j059e4af7ec78077e of unattended/04 (685632f2), src/mcp/workflow-lead.ts:37-52 and src/mcp/ticket-queue.ts:322-333. (1) A Markdown `Blockers:` heading or empty field followed by bullet/continuation lines currently yields zero blockers and lands without triage (regression vs the old check): read the continuation lines, or send an empty-but-not-`none` declaration to the lead; never treat it as clearance. (2) `none` followed only by a qualifier that restates there is no owner decision (`none requiring an owner decision.`, `none (owner live try remains)`, `none - only the live try`) counts as none, with any try part recorded as a try note; this is what paused run q7479f30245134311. (3) A pending-try phrase followed by detail (`owner live try remains: reopen the panel`) is a try note; mixed text that names an owner decision still goes to the lead. (4) Resuming an item hold requires the notice's `request_id`; drop the ID-less fallback to the first hand-back for item holds, keeping ID-less run-level acceptance unchanged.

- [ ] Heading-plus-bullet Blockers naming an owner decision reaches the lead (test)
- [ ] `Blockers: none requiring an owner decision.` and `Blockers: none (owner live try remains)` land without a lead; the try part appears in run todo (test)
- [ ] `owner live try remains: <detail>` is a try note; `live try remains and the owner must decide on deleting X` goes to the lead (test)
- [ ] hud_respond resume without request_id is refused for an item hold while two holds are open; with the id it resumes exactly that hold (test)
- [ ] npm test, npm run test:mjs and check:fixtures pass

## Comments
