# 38: A headless sonic that answers in chat without hud_report keeps its answer

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Twice on 2026-11-26/27 a luna sonic (pi, openai/gpt-6-luna) finished its lookup, wrote the full answer as its final assistant message and exited without calling hud_report (latest j95360f77506837ee, child of reviewer j37c5c8f52507c874). HUD failed the job with "pi exited without a declared report" and the parent lost a correct answer; main had to dig it out of stdout.jsonl. When a headless sonic settles (agent_settled, not aborted, exit 0) with no declared report but a non-empty final assistant text, HUD publishes that text as the report, marked `salvaged: final message without hud_report` in the digest and with the usual unverified-facts prefix for the parent. No nudge or extra turn is sent (cli-workers/09 rule). Aborted runs, provider errors and empty final text still fail as today.

- [x] Test: a fake headless sonic that settles with final text and no hud_report yields a done job whose report is that text with the salvaged marker
- [x] Test: aborted, errored or empty-final-text runs still fail with the current reason
- [x] Test: the parent's collection notice for a salvaged sonic shows the marker
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base efc8bc273d89fff4a5ff00d4fc2a3acfb21029c7); gate 5/5 passed.
