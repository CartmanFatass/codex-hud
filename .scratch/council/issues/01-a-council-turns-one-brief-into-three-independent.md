# 01: A council turns one brief into three independent plans and one converged plan

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Spec §2.1 dispatch, D-2026-11-25-02. Add an optional `council` role (off by default like `pro`; shipped file packages/hud-mcp/roles/council.json) that the main session starts with `hud_create({role: "council", task | brief_file, context_files?, from_jobs?, cwd})`. Its role file names `members` (ordered place objects in the existing run-place format; shipped default: cli claude `claude-fable-5-2` thinking high; pi architect `openai/gpt-6.2-astra` high; cli agy `gemini-4-carbon-high`), the `instructions` the members borrow (default `oracle`, read-only advice) and the `synthesizer` role (default `pro`). HUD then runs a fixed flow and nothing else: (1) start one job per member in parallel with the same brief and context, each independent (no member sees another); (2) when all settle, if at least two produced a report, start one synthesizer job whose brief is a fixed HUD template (in code, not in prompts): the original brief, the member reports attached via from_jobs, and the instruction to write one converged plan, a table of disagreements (point; each member's position; the choice; why), and open questions for the owner, with no new work beyond the plan; (3) deliver one notice / MCP task when the synthesis settles. Fewer than two member reports fails the council with the reasons; a failed member is named in the synthesis brief. If the synthesizer role is off or unavailable, `hud_create` refuses the council up front with the enablement hint (do not silently swap synthesizers). Reuse existing machinery where it fits: the prewalk scout wait/attach path in src/mcp/dispatch/orchestrator.ts, `general`-style instruction borrowing for members, browser context limits for the `pro` synthesizer (64 KiB per file, 256 KiB total; on overflow fail plainly with context_too_large). Link children to the council job (a `council: {id, part: member|synthesizer}` receipt field, copied to archive rows) so `hud_read({job: <council>})` shows state, member job ids and, when done, the synthesis report. Panel: children appear as ordinary jobs; no new panel UI. Docs: docs/reference.md (+ zh) council paragraph; one usage line in integrations/skills/hud-delegate/SKILL.md: council only when the owner explicitly asks.

- [x] With fake member harnesses and a fake jev-ask, one hud_create(role council) starts three member jobs, then one pro job carrying the three reports, and delivers one notice; hud_read(council) shows member ids and the synthesis
- [x] Members cannot see each other's output (their briefs and context contain no other member's report)
- [x] One member failing still synthesizes from two and names the failure; two failing fails the council without starting the synthesizer
- [x] Council or pro off: hud_create refuses with the enablement hint and starts nothing
- [x] Receipts and archive rows of children carry the council link; nothing is started after the synthesizer settles
- [x] Targeted tests only; reference (+zh) and hud-delegate line updated

## Comments

- 2026-11-25 owner change (D-2026-11-25-02): synthesizer per council from `pro` | Fable high (local, cli claude `claude-fable-5-2` thinking high, oracle instructions) | `main` (no synthesis job; the council settles when members do and its read returns the three reports plus the synthesis template for main). Role file `synthesizer` is the default; `hud_create` takes `synthesizer` to override. Refuse up front only when the chosen synthesizer is unavailable. For `pro`, attach member reports as before and add an index of the original context_files/from_jobs as repository, commit and paths that Pro can open on GitHub (mark files not on the pushed remote as local-only); no bodies of original attachments.

- Landed in this commit (replay base 3862df0d17ed65543d11a90ac597ed8a5257856f); gate 5/5 passed.
