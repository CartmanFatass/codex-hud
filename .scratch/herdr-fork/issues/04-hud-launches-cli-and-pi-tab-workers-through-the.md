# 04: HUD launches CLI and pi tab workers through the fork and deletes the outside inference

**Status:** done
**Owner try:** no
**Blocked by:** 02, 03
**Objective:** herdr-fork

**What to build:** After main installs the fork (owner-confirmed): HUD detects the fork (version suffix `-hud` or a capability field) and, on it, launches CLI and pi tab workers with direct-exec `agent.start` (explicit env from HUD's own process env plus job variables; declared kind; on_exit close_on_zero), records the returned pid/pid_start_time and launch_id as the job's identity, judges exit from `pane.exited` exit_code, and matches tab events by launch_id. On stock herdr today's path stays. Then delete the fork-path uses of the witness shim, ZDOTDIR wrapper, startup shell snapshot, tab-shell verification, closedTabs reconciliation and most of reap-tab (plan: HUD side). Keep worker-tree for headless and detached descendants. Live check by main on the installed fork: one claude, one agy, one pi tab job start, report, and their tabs close; a crashed worker's tab stays readable.

- [x] On the fork, CLI and pi tab jobs start by direct exec with HUD-passed env; identity is the fork's pid + start; no shell in the worker tab
- [x] A finished job's tab closes by itself (clean exit); a crashed one stays readable until HUD's failure retention closes it
- [x] Tab events are matched by launch_id; a reused public tab ID never affects another job
- [x] On stock herdr the current path still works (test)
- [x] The listed inference code is deleted from the fork path; land gate passes; process-safety review before land

## Comments

- Landed in this commit (replay base dc11e8d8c6b42574f27be1b1de356a8809507826); gate 5/5 passed.
