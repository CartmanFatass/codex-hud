# 10: A quiet CLI job without a report gets one Decision API choice

**Why:** owner 2026-11-14 (spec §2, "One exception"): the main session should not have to handle every CLI worker that
stops without a report. Cost is not a concern; predictability is.

**What to build:** at the point where ticket 09 turns a job `waiting_orchestrator` ("quiet without a report"), the
supervisor first asks the Decision API (the provider chosen in Settings, through `src/jev/`) one choice question with
probabilities. Input: the last 60 lines of the pane (`herdr pane read --source recent`), job state, whether a
background child is alive, minutes quiet. Options and actions:
- `still-working` (waiting on background work or thinking) → keep waiting one more idle grace, then ask again (at most
  3 questions per job);
- `finished-no-report` → send the fixed prompt "Write your report to <path> now; if work remains, finish it first."
  once per job, then wait as after any turn;
- `failed` (error or quota/rate limit on screen) → fail the job with the screen line as reason; quota marks the place
  exhausted (ROLE-BIND);
- `needs-human` (a terminal prompt, a question, or unclear) → `waiting_orchestrator` with the notice, as 09.
Below 0.8 probability for the top option, without a key, over the call cap or on any error → `needs-human`. The
choice, its probability and the action go into STATUS (`quiet_decision`) and show on the card and in the Inspector.
Decision calls count under a `quiet-job` feature in Settings' per-feature breakdown.

Also check whether `mistral/deepseek-v4-1-flash-1017` with reasoning off gives structured output and option
probabilities through the Mistral API; if it does, add it as a Decision API provider choice in Settings (keys from
`~/.hud/credentials.env`); if not, record why in the comments and leave the providers as they are.

**Who:** agy-imp (gemini-4-hydrogen-high) · **Size:** about 120 source lines; tests with a fake herdr and a fake
decision provider (no real calls)

**Blocked by:** 09

**Status:** ready-for-agent

- [ ] Each option leads to its action; a second `finished-no-report` never sends the prompt twice
- [ ] Low probability, no key, cap reached or provider error → needs-human, nothing sent to the worker
- [ ] `quiet_decision` in STATUS, on the card and in the Inspector; Settings breakdown counts `quiet-job`
- [ ] Mistral DeepSeek provider: added or the reason recorded
- [ ] One real run by the orchestrator: an agy job told to start a long background command and stop; recorded below
