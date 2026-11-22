# B10B-S3F performance and verification follow-up

Status: owner approved both questions on 2026-11-03; B10B-S3F, HYG2 and RUNZ1 remain unaccepted and unmerged.

## B10B-S3F

The sole fix round in the package brief is consumed. The Oracle's fresh evidence ruling recommends a narrowly scoped follow-on rendering performance remediation under the existing gates, with no threshold or supported-runtime waiver. See `dots/b10b-s3f:docs/cloud/rulings/b10b-s3f-performance.md` and `docs/cloud/handoff/b10b-s3f-recheck-2.md` on that branch. The new strict Node 22 series passed 3/3; Node 24 failed 3/3 on compact changed p99. The first Node 22 run overlapped another benchmark and external load was not controlled. Earlier failures remain part of the evidence.

Owner: may a scoped follow-on performance remediation proceed beyond this brief's one-fix-round limit, using the existing gates and Oracle review loop?

## Verification environment

The current cloud executor denies AF_UNIX and ptrace and its kernel has `CONFIG_PROC_CHILDREN` disabled. The three packages' full checks are therefore not green; no check is waived. Baseline/current diagnosis is on `dots/hyg2:docs/cloud/handoff/hyg2-topology-diagnosis.md` and `hyg2-proc-diagnosis-20261103.log`. The user has prohibited local-only work.

Owner: provide or authorize a capable non-local executor for the normal synthetic check set, or explicitly authorize use of a Codex session on a suitable connected executor for these checks. This request does not include local-only real-harness work or changes to security settings.

## Owner decision

The owner approved both items and requested 6.1 Terra Max for testing. A separate Codex test session was started in the connected environment. Approval does not waive any gate or authorize local-only work or security-setting changes.

On 2026-11-03 the owner also authorized subsequent local testing using 6.1 Terra Max. The active session's immediate assignment remains the normal synthetic checks; other changes to live configuration or security settings are not implied.
