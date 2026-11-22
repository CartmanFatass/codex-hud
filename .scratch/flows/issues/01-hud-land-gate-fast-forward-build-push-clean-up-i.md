# 01: hud_land: gate, fast-forward, build, push, clean up in one call

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** D-2026-11-22-19, spec §5 (22.19). New main-session tool `hud_land({ job })` for a settled job that ran with isolation:"worktree". Project config in `.hud/project.json` key `land`: `{ base, gate: [cmds], after: [cmds], push: bool }` (MyHUD: base universal-hud; gate build, build:test, test:mjs, test:mjs, test:unit, check:fixtures; after build; push true; commands run through the project's env wrapper if configured, e.g. `wrapper: "tmp/env.sh"`). Steps, run by HUD itself (no sonic; exit codes decide): fresh detached worktree at the base tip; cherry-pick base..HEAD of the job's worktree in order; run gate commands; on green fast-forward the base in the main checkout (refuse if the base moved or the checkout's touched paths are dirty), run `after`, push if configured, remove the integration and job worktrees and the job branch. State persists in `$HUD_HOME/flows/<id>.json` so a watcher restart resumes or reports. One land per checkout at a time (queue behind the main-checkout lease). Result for the main session: one notice with state, landed SHA or the failing step and its last 40 log lines. MCP-task clients get one task for the whole flow. Spec: add `hud_land` to the §2.1.1 tool list with one sentence.

- [ ] A green job lands: base fast-forwarded, after commands run, pushed, worktrees and branch removed, one notice
- [ ] A conflicting or red job leaves the base untouched and the notice names the step and log tail
- [ ] A watcher restart mid-flow resumes or reports, never double-lands
- [ ] npm test and check:fixtures pass

## Comments
