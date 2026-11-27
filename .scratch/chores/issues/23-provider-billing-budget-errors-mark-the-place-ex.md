# 23: Provider billing/budget errors mark the place exhausted and fail over (pi turn errors, 402)

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** 2026-11-27 00:37Z: every sonic on pi mistral/deepseek-v4-1-flash-1017 failed with 'pi exited without a declared report'. The real cause was in the pi session: the assistant turn stopped with stopReason error, errorMessage 'Mistral API error (402): {"message":"Vibe budget exhausted.","type":"billing_vibe_budget_exhausted","code":"2304"}'. HUD never marked the place exhausted, so dispatch kept choosing it although the role has haiku and luna fallbacks: (1) watch-runtime only checks status.exit_reason/error, which held the generic 'exited without a declared report', not the provider error; (2) QUOTA_ERROR in src/roles/exhausted.ts has no billing/budget/credit-balance/402 pattern. Main marked the place by hand for 12 h. Fix: when a pi (or CLI) worker ends without a report, read the last assistant turn's error from its session/stdout and use it as the failure reason; treat provider billing and budget exhaustion (HTTP 402, billing_*, 'budget exhausted', 'credit balance', 'payment required') as quota failures. Keep a reset hint when present; otherwise use a longer default for billing (e.g. 12 h) than for rate limits.

- [x] Fixture: a pi sonic session ending with the Mistral 402 billing error marks pi:<model> exhausted and the job's exit_reason names the provider error; the next sonic dispatch uses the role's next run place.
- [x] Billing errors without a reset hint get the longer default; 429/rate-limit behaviour unchanged.
- [x] A worker that ends without a report and without a provider error keeps today's reason.

## Comments

- Landed in this commit (replay base 47bbe706518e8d43902dc4ad3fef61864acf8abf); gate 5/5 passed.
