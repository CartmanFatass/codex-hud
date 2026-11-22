# 05: Milestone review fixes for routing and headless workers

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Fix every blocking finding in `docs/reviews/2026-11-22-auto-route-milestone.md` in one pass (spec 1-5, simplicity 1-3, plus its "What can be deleted" list). The review names files and lines; the design intent it was judged against is in `tmp/tasks/review-auto-route/brief.md`. In short:
- Explicit `mode: "tab"` and `mode: "headless"` both win while routing; routing then asks only for the tier; the continuability check applies only to headless.
- Placement flags (model/thinking) in caller `pi_args` are rejected for roles other than `general`; a `retry_of` that changes role does not carry general's one-job overrides.
- A standard/headless route that cannot launch falls back to the active preset in a tab when mode was not explicit (pre-input only; never replay after input may have reached a worker).
- Inspector output parses Antigravity's `event` records and tells "no output yet" (zero bytes) from "nothing displayable".
- A headless Claude or Antigravity question ends the turn through the runner (keep the native session), not by trusting the model's next reply; `hud_respond` then resumes.
- Unrouted headless jobs fall through to the next compatible place on a pre-input rejection like tab jobs do; the one-shot exception stays for sonic only; direct and queued creates share the rule.
- An expired follow-up to an overflow job keeps imp's launch role and chain.
- Headless pi session identity compares canonical cwd paths.
- Deletions: the blanket headless break, the `retrySource` shadow, the 40-vs-12 output line limit (one shared limit).
Leave the review's optional list alone.

- [ ] Each blocking finding has one main-path test that fails before and passes after
- [ ] Targeted tests pass

## Comments
