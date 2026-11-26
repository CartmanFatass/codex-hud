# 04: Citation check resolves the paths sonic actually cites

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** sonic-even/03's check (`src/roles/sonic-citations.ts`) verifies 1,452 of 15,203 recorded citations (979 sonic jobs, 2026-11-25); 7,962 failures are `missing_file`, so the numbers say more about the checker than about sonic. Samples of missing_file (cwd | ref): `/home/fires/projects/MyHUD-wt/imp-338bdc | src/render/main-tabs.ts:3-17` (a worktree path; prewalk scouts may run before their imp's worktree exists, or the check may run after it is removed), `/home/fires/projects/toktrack | store.rs:294`, `usage.rs:447`, `app.rs:3356-3362`, `MyHUD-wt/imp-2b2873 | main.rs:245-250` (bare basenames), `MyHUD | owner-64b.txt:495` (a scratch file outside the repo). First measure: classify all current missing_file failures in ~/.hud/jobs by cause (cwd missing at check time, cwd differs from where the sonic actually read, basename/partial path, genuinely absent) and put the counts in the report. Then fix the checker's root causes: check against the directory the sonic actually worked in, at settlement, and resolve a bare or partial path only when exactly one tracked file (`git ls-files` in that root) matches; ambiguous or absent stays a failure with its own reason (e.g. `ambiguous_path`). Keep bounded work (200 citations, 256 KiB, no model, no network) and the record shape `citations {total, verified, failed[] (max 20)}`; new reasons are additive. Do not rewrite old job records.

- [x] Report lists missing_file causes with counts over the existing job records
- [x] Fixture: a citation by unique basename verifies; one matching two tracked files fails as ambiguous_path; a prewalk scout whose cited files are in the repo root verifies
- [x] Check still adds no model call and finishes within 100 ms on a 256 KiB report (existing test)
- [x] docs/reference.md citations paragraph names the resolution rule and the new reason

## Comments

- Landed in this commit (replay base eb6769412562a52d2c43fb0fc96f50a5a7bee559); gate 5/5 passed.
