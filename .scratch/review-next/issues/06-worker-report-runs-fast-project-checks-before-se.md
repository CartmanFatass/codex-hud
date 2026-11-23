# 06: Worker report runs fast project checks before settling

**Status:** done
**Owner try:** no
**Blocked by:** 05

**What to build:** Carbon #7: `.hud/project.json` may set `worker_checks` per role (e.g. imp: build + build:test, ≤60 s). When a code worker with commits calls hud_report, HUD runs them; if red, the report is refused with the error tail so the worker fixes it in the same turn; `skip_checks_reason` lets a blocked worker report anyway. Read-only roles and clean worktrees skip. This changes spec §2.1.6 'Checks never settle, accept or fail a job' (owner approved A–G 2026-11-23; main session updates the spec line when dispatching).

- [x] Red worker_checks refuse the report with a bounded error tail; green settle as today
- [x] skip_checks_reason accepted and shown in the digest
- [x] 60 s cap enforced
- [x] MyHUD .hud/project.json sets build + build:test for imp/frontend-imp
- [x] Unit tests

## Comments

- Landed in this commit (replay base 51416d469376effda8c35f97802dcc49bef0e08c); gate 5/5 passed.
