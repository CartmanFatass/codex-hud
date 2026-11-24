# 01: HUD runs prewalk automatically before strong-model jobs

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** pool-pick/01

**What to build:** Spec §2.1 (D-2026-11-24-05). Generalise the existing `scout` flow and pool-pick into one prewalk step HUD runs on its own before a job starts. Owner role files only (`$HUD_HOME/roles`): `"prewalk": {"scout": "on"|"off"}` next to the existing `pool` field; shipped defaults: imp, oracle and frontend-imp `on`, reviewer and sonic `off`. No Decision API call decides whether to scout (owner 2026-11-24: the owner sets activation; strong roles need broad information most of the time). Settings switch `autoPrewalk` (default on) turns all automatic scouts off at once. With `on`, unless the caller passes its own `scout` or skips prewalk for this job, run the existing scout flow first with a fixed question built from the brief: list the files, symbols, commands and facts a worker needs for this brief with path:line citations; no design, diagnosis or judgement. Attach its report via from_jobs as today; a failed or slow scout (cap 5 minutes) leaves the existing note and the target starts anyway. The caller skip is a minimal schema addition (the declaration budget test must pass). Record `prewalk: [{kind: 'scout'|'pool', source: 'decision'|'brief'|'caller'|'role'|'default', result, ms}]` on the job record, archive and hud_create receipt (fold pool-pick's `pool_pick` into it). Update the hud-delegate skill and hud-convention so the main session stops adding routine scouts by hand. Nothing chains after the target.

- [ ] With autoPrewalk on, an imp dispatch runs a sonic scout first and attaches its report; with the role set to off or the switch off, imp starts directly; no Decision API call is made for this
- [ ] A caller scout, a caller skip and a scout over 5 minutes each behave as specified (tests)
- [ ] prewalk entries appear on job.json, the archive row and the receipt; reviewer and sonic never prewalk by default
- [ ] docs/reference.md and the hud-delegate skill describe prewalk briefly; the declaration budget test passes

## Comments
