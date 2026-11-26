# 22: HUD trusts the fork's agy status and deletes its turn-child /proc workaround

**Status:** done
**Owner try:** no
**Live try:** a live agy worker whose brief runs a background `sleep 6` then hud_report: herdr shows working through the wait, HUD does not close early, and closes cleanly within ~2 s of turn end
**Blocked by:** 21
**Objective:** herdr-fork

**What to build:** Second half of the agy native-status fix (oracle job jb786b61850a1b98a, sections Q4 and Slice 2, file:line at MyHUD b184f001). Starts only after herdr-fork/21 is installed (main installs the fork). Require `capabilities.agy_background_work === true` in HUD's herdr capability check / doctor preflight like hidden_tabs and guarded_prompt (explicit fork-upgrade message; no /proc fallback kept, per spec §1: HUD stops inferring what the fork provides). Set packages/hud-mcp/harnesses.json agy.state_trust to "turn". Delete workerHasChild, bootstrap, firstInput / first_sent_at, readBootTimeMs, sampleChild, Facts.liveChild, action 'sample', backgroundChildAlive / background_child_alive in the quiet-decision payload, and the dead startupQuirk 'done-before-prompt', with their tests. Under closeAtReport && declared, close on herdr done/idle as now, or 10 s after declaredAt with an unchanged report signature and no open hud_ask, so a worker that leaves a daemon child running still closes promptly and worker-tree reaping cleans the daemon. Keep: worker-tree.ts and reapDirect close-time reaping, readProcChildren (daemon-binding uses it), the agy .agy-pending mailbox and PreInvocation hook, done receipts and the hud-progress --done fallback, tab-shell/tab-owner for bro and split pi helpers. Also drop the redundant second paneInfo spawn in notifyAgy now that guarded prompt checks state atomically, and simplify readProcChildren's unused options. Update docs/ARCHITECTURE.md and docs/reference.md. Behaviour note to keep in the report: claude/codex/grok workers rely on herdr's own detection plus done.json; an undeclared background child no longer holds a turn open (close still reaps it). Removes: no user-visible feature (internal workaround only).

- [x] HUD refuses worker preflight with a fork-upgrade message when agy_background_work is absent (test)
- [x] agy state_trust is turn; the listed workaround code and tests are gone; kept pieces intact
- [x] closeAtReport closes on done/idle or 10 s after a declared report with no open question, reaping a lingering daemon (test)
- [x] Touched suites pass via tmp/env.sh; docs updated

## Comments

- Landed in this commit (replay base d56e8c205fcbf343b4f3ddea81885af18af19e4b); gate 5/5 passed.
