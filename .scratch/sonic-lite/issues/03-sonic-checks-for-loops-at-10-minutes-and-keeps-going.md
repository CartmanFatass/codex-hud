# 03: Sonic checks for loops at 10 minutes and keeps going in the same session

**Status:** done
**Blocked by:** 01
**Owner try:** no

**What to build:** Owner 2026-11-22 asked whether the 10-minute headless cap fits and what happens to a long query cut off. Facts: of 25 recent sonic jobs with timings, p50 259 s, p90 497 s, 2 over 600 s (677 s and 1,490 s), both finished with outcome done; a fixed 10-minute kill would have failed them and thrown the work away. Owner's design: at 10 minutes do not kill; check whether the query is going round in circles, and if not let the same pi process keep going (same session, prompt cache kept), and never let it go quiet.

- Checkpoint every 10 minutes (`check_s`, default 600). The check reads the recent pi JSON events: it is looping when the last window repeats the same tool calls with the same arguments, or shows no new tool target and no new hud_progress since the previous checkpoint. Looping: stop, settle failed `looping`. Otherwise: keep running and post a progress line ("still working at 10 min: <last step>") that reaches the caller like any progress, so a long query is never silent; the caller may still close it.
- Separate stall rule: no stdout growth and no hud_progress for `stall_s` (default 180) stops it as `stalled`. Safety cap `max_s` (default 1800) stops it as `timeout`. All three are optional sonic role-file fields, shown in `hud_roster(detail:true)`.
- A stopped query keeps its partial stdout; its digest carries the last progress line. Run pi with a session file in the job dir; `hud_create({role:"sonic", retry_of})` on a stopped query resumes that pi session (pi --session) with a short "continue; you were stopped for <reason>" message instead of a fresh start, so context and cache are reused; if the session cannot be resumed, fall back to a new query whose brief carries the original brief plus the partial result.

- [x] A query that keeps making progress runs past 10 minutes in the same process and posts a checkpoint progress line
- [x] A synthetic query repeating the same tool call is stopped at the checkpoint as `looping`; a silent one as `stalled` after stall_s; max_s as `timeout`
- [x] retry_of on a stopped sonic resumes its pi session (fallback: partial result in the brief)
- [x] role-file values change the limits; npm test and check:fixtures pass

## Comments

- Landed 1001aa02bbf9094e6f326e7849183e46f37b7ea6; gate 5/5 passed.
