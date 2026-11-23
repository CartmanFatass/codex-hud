# 02: Experiment tag at hud_create

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** Spec `.scratch/toktrack-facts/spec.md`, D-2026-11-23-01. Optional `experiment` and `arm` strings
(each ≤ 64 chars) on `hud_create`, single and batch, kept by `retry_of` and repairs, stored on `job.json` and in
the archive line. No panel display. Keep the tool-schema growth small (the MCP lean budget): one short
description line.

- [x] Schema accepts and validates both fields; batch items too; retry and repair inherit them
- [x] Archive line carries them; MCP schema bytes grow ≤ 200 B (existing schema-size test)
- [x] docs/reference.md (EN/ZH) one line

## Comments

- Landed in this commit (replay base 8bbd1ca7c87fc369095555128b434f67fe5ce6c0); gate 5/5 passed.
