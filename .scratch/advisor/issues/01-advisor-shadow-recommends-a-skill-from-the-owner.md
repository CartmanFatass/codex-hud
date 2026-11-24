# 01: Advisor shadow recommends a skill from the owner's libraries without touching the session

**Status:** ready-for-human
**Owner try:** yes
**Blocked by:** none

**What to build:** Spec §2.2 advisor shadow (D-2026-11-24-06). Reference for the idea only: oh-my-pi's auto-prewalk judge (context = latest request + previous reply) at `tmp/refs/oh-my-pi/packages/coding-agent/src/auto-prewalk/classifier.ts:60-100`; do not copy its injection path. Settings: `advisorShadow` (default off) and `advisorSkillDirs` (list of absolute dirs; default empty). Index each `SKILL.md` under those dirs (frontmatter `name` and `description`, at most 300 bytes each; bounded to 200 skills / 64 KiB; rebuilt when a dir's mtime changes, never per message). Trigger: a new owner-typed message in a main (orchestrator) session HUD already tracks (Claude Code and pi first). Input to the Decision API, same discipline as `src/mcp/sonic-thinking.ts` (quoted untrusted data, fixed choices, own timeout): that message and the previous assistant reply, each at most 2000 chars with secrets scrubbed, plus the skill index. One fixed choice: a skill name or NONE, with the statement that NONE is the default unless a skill clearly fits what the owner is asking now. Skip the call when the message already names a skill path; at most one recommendation per owner message; the same skill is not recommended again in the same session within 30 minutes. Show, never inject: the bottom bars' notice zone shows `skill: <name>` for 10 minutes after the quota notices (Text and Nerd icon sets); the panel shows one line under the session's project, `<name> — <absolute SKILL.md path>`, and Enter or a click copies the path (OSC 52 to the terminal, `clip.exe` fallback on WSL). Nothing is written into any session, prompt or hook output. Record facts once: append `{kind: 'advice', session, skill, at, ms}` to the existing `$HUD_HOME/events/<YYYY-MM>.jsonl`, and the copy action to the existing panel actions log, so toktrack can later count recommendations and copies. No analysis in HUD.

- [x] With the switch on, a stubbed Decision API and a fixture skill dir, a new owner message yields one recommendation shown in the bar notice zone and the panel; NONE shows nothing
- [x] Copying from the panel puts the absolute path on the clipboard (OSC 52 sequence asserted in a test) and logs the action; the advice event is appended
- [x] No session transcript, hook output or prompt receives any advisor text (test greps the Claude hook and pi extension outputs)
- [x] Switch off makes no call and builds no index; dedupe and skip rules hold (tests); docs/reference.md describes the shadow in one paragraph
- [x] Owner try: turn it on with the mattpocock skills dir, chat normally for a while, and copy one recommendation into a session

## Comments

- Landed in this commit (replay base 8ef7617b13b00a34554d9c70c5769834cd46a997); gate 5/5 passed.
