# 01: Session ids, land repair causes and retention in job records

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Spec `.scratch/toktrack-facts/spec.md`, D-2026-11-23-01. (1) Record `sessions[]` (`{harness, id,
path?}`) on `job.json` for every native session a job runs, for pi (session file; the job's `sessions/` links
and headless session files), Claude Code, Codex and Antigravity workers, including repair continuations; copy it
into the archive line. (2) Extend the archived `land` with per-repair `{step_kind, step, outcome}` (`conflict`
for cherry-pick, `gate` otherwise) and per-rerun `{step, passed_unchanged}` taken from the flow records; keep the
existing counts. (3) Add `retry_of` to the archive line. (4) Retention keeps a job directory whose native session
file exists nowhere else (headless pi) for at least 7 days after it settles; nothing else changes. Synthetic data
only in tests.

- [ ] Unit tests: sessions[] for a pi tab job, a headless sonic, a Claude CLI job and a repaired continuation
- [ ] Archive line carries sessions[], retry_of and per-repair / per-rerun causes for a flow with a conflict
      repair and a flaky rerun
- [ ] Retention test: headless job kept 7 days, a pi tab job whose session lives in `~/.pi` follows today's rule
- [ ] docs/reference.md (EN/ZH) describes the new archive fields

## Comments
