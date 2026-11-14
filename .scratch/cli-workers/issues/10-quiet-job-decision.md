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
- `failed` (quota/rate limit on screen) → only when the quoted screen line matches the quota regex
  (`src/roles/exhausted.ts` `isQuotaFailure`): fail the job with that line as reason and mark the place exhausted
  (ROLE-BIND); a `failed` choice whose line does not match → `needs-human` (owner 2026-11-14);
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

**Status:** in-review

- [x] Each option leads to its action; a second `finished-no-report` never sends the prompt twice
- [x] Low probability, no key, cap reached or provider error → needs-human, nothing sent to the worker
- [x] `quiet_decision` in STATUS, on the card and in the Inspector; Settings breakdown counts `quiet-job`
- [x] Mistral DeepSeek provider: added or the reason recorded
- [x] One real run by the orchestrator: an agy job told to start a long background command and stop; recorded below

## Comments

- **Mistral DeepSeek check (`deepseek-v4-1-flash-1017`, reasoning off):** Tested live against `https://api.mistral.ai/v1` using `MISTRAL_API_KEY` from `~/.hud/credentials.env`. `POST /v1/decisions` returned `404` (`no Route matched with those values`). `POST /v1/chat/completions` with `model: "deepseek-v4-1-flash-1017"`, `reasoning_effort: "none"`, and `response_format: { type: "json_schema", strict: true, ... }` returned `200` (`reasoning_tokens: 0`, valid JSON `{"choice": "failed"}`), but adding `logprobs: true, top_logprobs: 5` returned `400` (`code: "3051"`, `"Logprobs are not enabled for this model"`). Structured output works, option probabilities do not, so Decision API providers remain unchanged (`gemini`, `openai`, `typesafe`).
- **2026-11-14 owner ruling:** A `failed` choice only fails the job (and marks the place exhausted via `recordFailureExhaustion`) when `extractFailureScreenLine` matches `isQuotaFailure` (`src/roles/exhausted.ts`); otherwise `failed` falls back to `needs-human`.

- 2026-11-14 (orchestrator): landed 2117e2b5 (472/472). Real run j96e803f27c3b7243 (agy, gemini-4-hydrogen-high):
  told to start `(sleep 90; …) &` and end its turn without a report. agy's tool shell killed the background command
  when the tool call returned (the probe file never appeared), so this run tested "turn ended, no report, no
  background child". After the idle grace the supervisor read the pane and asked the Decision API:
  `quiet_decision {choice: needs-human, probability: 0.35, action: needs-human}`, under the 0.8 bar, so the job went
  `waiting_orchestrator` and the notice reached the main session. Nothing was sent to the worker. Passed.
