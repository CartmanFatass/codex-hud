# 07: Finished work leaves no logs or scratch behind

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** Spec §2.1.5 "Retention" (22.22). Owner 2026-11-22: finished work need not be kept. Sonic `stdout.jsonl` files held 75–125 MB, 97% of `~/.hud/jobs`, and `tmp/tasks/` had grown to 5.7 GB; the main session cleaned the latter once by hand. (1) The watcher deletes `stdout.jsonl` and `stderr.log` of a job that settled cleanly (done or closed with a report) once its `resume_s` window has passed. Failed or stopped jobs keep them until the job directory itself goes. Anything that reads those files must tolerate their absence: archive facts, failure digests, the panel's output view. (2) The `.hud/project.json` `scratch` field (`{ "paths": [...], "keep_days": 7 }`, already added for this repo) makes the watcher remove top-level entries under each path whose newest file is older than `keep_days`. It runs at most hourly from the existing housekeeping pass (perf-hygiene/05), never follows symlinks, never leaves the project root, and logs one line with the count. Registered projects only. Document both in docs/reference.md and docs/reference.zh.md.

- [x] A clean sonic and a clean worker lose stdout.jsonl after resume_s; a failed one keeps it; digests and archive still work
- [x] Scratch entries older than keep_days are removed, newer ones and symlink targets untouched, paths outside the root refused
- [x] Targeted watch/retention tests pass

## Comments

- Landed f625756adc61d65dbd91201524c55c08151827d9; gate 5/5 passed.
