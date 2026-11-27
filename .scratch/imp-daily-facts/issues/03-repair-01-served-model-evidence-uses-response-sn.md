# 03: Repair 01: served-model evidence uses response snapshots and never trusts truncated or masked history

**Status:** done
**Live try:** none
**Blocked by:** none

**What to build:** Repairs imp-daily-facts/01 (milestone review je6beab56fe18b3fe findings 3-5). All in src/roles/job-usage.ts plus tests/unit/job-usage-stats.test.mjs. (3) piModel (~:90-96) reads only message.model; Pi's own usage-totals uses `responseModel ?? model`. Prefer a valid message.responseModel when present, then qualify with provider and fast/ultrafast tier as today. (4) The Codex rollout path (~:205-213) returns served models together with a cumulative event_msg/token_count total before checking window.cut || window.malformed, so a >1 MiB rollout whose discarded prefix used another model is archived as single-model. The Claude headless path (~:291-301) likewise treats one result with a known byte start as complete even when the assistant window was cut. Gate model collection separately from numeric totals: a cumulative count may still supply tokens, but served_model/served_models from a cut or malformed window must be omitted (unknown), never presented as full history. (5) An AGY stream result with input, output and result.model skips PLANNER_RESPONSE history entirely, and the stream/native merge (~:312-320) drops the native model list whenever the stream has any model. Keep token totals from one view (never add two views of the same traffic), but collect model evidence independently from both views through one bounded distinct-model accumulator (last-4, last-seen order, served_model = last). This replaces the all-or-nothing choice between model lists and the repeated normalize/expand passes in jobUsage, sum and the merge. No archive format change.

- [x] Pi fixture: two assistant messages with the same model alias but different responseModel snapshots yields both snapshots (provider-qualified, tier-suffixed) in served_models and the later one as served_model (test)
- [x] Codex fixture: rollout over the window bound whose cut prefix has model A and tail turn_context model B with a cumulative token_count still yields token totals but omits served_model/served_models (test)
- [x] Claude headless fixture with known byte start and a cut assistant window omits served-model history rather than reporting a partial list as complete (test)
- [x] AGY fixture: stream result with input/output and result.model B plus native PLANNER_RESPONSE A then B yields served_models [A, B] and tokens counted once (test)
- [x] npm test, npm run test:mjs and check:fixtures pass

## Comments

- Landed in this commit (replay base 6f0ba6d5386994b0741aadbce740d36bc75b89c6); gate 5/5 passed.
