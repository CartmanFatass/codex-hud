# 10: Repair /05: Codex served model needs response evidence for its turn

**Status:** done
**Live try:** none
**Blocked by:** none
**Repairs:** imp-daily-facts/05, imp-daily-facts/03, imp-daily-facts/01

**What to build:** Repairs imp-daily-facts/05 (and the served-model purpose of /03 and /01): milestone review jc672ee56962100ba Simplicity finding 2. In src/roles/job-usage.ts transcriptUsage Codex path (~:222-230) a model is added to served history straight from every `turn_context` (and `session_meta` as fallback). Those rows describe the request context, so an intact rollout whose turn has only user/developer input and lifecycle events and no response still publishes served_model, and a successful turn on model A followed by a response-less turn_context on B creates a false change point to B. Keep using turn_context/session_meta to identify the model, but add a turn's model to served history only when that turn shows response evidence (assistant output, or a metered response: token_usage_record or a token_count with last_token_usage attributed to that turn). A session_meta-only rollout that is metered must still publish its model. Leave numeric token accounting untouched. No archive format change. Add tests in tests/unit/job-usage-stats.test.mjs: (a) intact rollout with a turn_context but no response -> served_model/served_models omitted; (b) turn on A with a response, then a response-less turn_context on B -> served_model A, no B; (c) metered session_meta-only rollout -> served_model from session_meta.

- [x] A Codex turn_context model enters served history only when that turn has response evidence; numeric totals unchanged
- [x] Tests: response-less intact rollout omits served_model; A-served then unserved B context keeps served_model A without B; metered session_meta-only rollout still publishes its model

## Comments

- Landed in this commit (replay base d0995cafb79fb18a31cb14aedbbb8c879a02d804); gate 5/5 passed.
