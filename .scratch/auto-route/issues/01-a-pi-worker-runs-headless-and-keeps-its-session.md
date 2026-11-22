# 01: A pi worker runs headless and keeps its session

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** Spec §2.1.2 "A headless worker…" (22.22). Survey 2026-11-22: 95 of 185 worker jobs (51%) ran brief-to-report with no question, send or repair, but each held a herdr tab; the owner saw 9 tabs. Add a run mode `headless` for continuable roles on the pi harness (imp, general). Selected by `hud_create({ mode: "headless" })` for now; 03 makes it automatic. A headless job opens no tab. It runs pi in its non-interactive JSON mode with a session file in the job dir (not `--no-session`), output appended to a job-dir log, and the same worker MCP tools as a tab worker (hud_report, hud_progress, hud_ask, hud_lease, hud_sonic). It settles on its report like a tab worker and is closed at once (close-on-delivery). `hud_ask` ends the turn and marks the job asking. `hud_respond` then resumes the session (`pi --session <file>`) with the answer as the next message. `hud_send` resumes it the same way, within `resume_s` and otherwise as a repair job, and so do land repairs. Stop (`hud_close`, panel stop) kills the process tree. Reuse headless sonic's spawn/supervision and close-on-delivery's resume helper; do not fork either.

- [x] A synthetic headless imp job runs to a report with no herdr tab and settles closed with its session file kept
- [x] hud_ask → hud_respond resumes the same session and the job reports; hud_send after the report resumes within resume_s
- [x] A land repair of a headless job resumes its session headless
- [x] Stop kills the process tree; progress shows on the card as for tab jobs
- [x] Targeted thin-mcp/sonic/close-resume tests pass

## Comments

- Landed e33c2515353f844fd216243bd6be917bc18f3713; gate 5/5 passed.
