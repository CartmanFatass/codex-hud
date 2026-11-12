# Upstream pin

Jev Ultrafast, MIT, Copyright (c) 2026 Browser Use.

- Repository: https://github.com/browser-use/jev-ultrafast
- Commit: `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`

| Upstream | Port |
|---|---|
| `jev_ultrafast/agent.py` | `src/jev/agent.ts` |
| `jev_ultrafast/browser.py` | `src/jev/browser.ts` |
| `jev_ultrafast/model.py` | `src/jev/model.ts` |
| `jev_ultrafast/questions.py` | `src/jev/questions.ts` |
| `jev_ultrafast/snapshot.js` | `src/jev/snapshot.js` |

`snapshot.js` has one leading comment. Everything after that newline is the upstream file. `cdp.ts`, `decide.ts`, and `providers/` are new. `decide.ts` and the TypeSafe provider keep `model.py`'s `choose()` request shape; the OpenAI provider is a second backend for the same `DecisionRequest`.

## Deviations

- Calls are async. `Agent.open` and `Browser.open` are static because a constructor cannot await. `Browser.bare()` builds an offline browser for tests.
- CDP is a direct socket (`node:net` / `node:tls` for the WebSocket, `node:http` for `/json/version`). `/json/version` passes `agent: false`, because `--use-env-proxy` replaces the global agent and a request that uses that agent follows `HTTP(S)_PROXY`. There is no `Origin` header. The default per-call timeout is 60 seconds. Frames that arrive before `onMessage` is attached are queued. Closing the socket unrefs it so a peer that never answers the close frame cannot keep the process alive. Decision HTTP stays on global `fetch`, so `--use-env-proxy` applies to provider calls and not to loopback CDP. Node's global `WebSocket` does follow that proxy unless `NO_PROXY` lists the CDP host (measured: 2 proxy hits and 0 direct connections with `NO_PROXY=example.invalid`; 0 proxy hits with `NO_PROXY=127.0.0.1,localhost`). The direct socket stays because loopback CDP has to bypass the proxy either way.
- `postJson` uses `fetch` instead of `httpx`. Each attempt aborts after 25 seconds, the upstream `httpx` timeout. A caller abort, including `Agent.close()`, is rethrown. A timeout is `DecisionProviderError('network')`. Status 429, 503, and 529 retry twice with sleeps of 0.5s and 1s. Other HTTP statuses and network failures become `DecisionProviderError` and do not execute an action. The error text does not include the response body. The same signal and timeout cover the text-model request.
- The text model is optional. Without `TEXT_MODEL_API_KEY`, fill is not offered and `snapshot().text_model` is `unconfigured`. Field text is never invented by the executor. Reuse compares `pythonJson(fieldContext(...))`, which matches upstream dict equality for these values.
- `choose` takes a `DecisionProvider`. `selectDecisionProvider` is async so the provider modules load after `model.ts` (they share `postJson` / `validateChoice`). An explicit provider wins; otherwise `decisions.primary` defaults to OpenAI. Automatic fallback is the first other keyed provider in Gemini → OpenAI → TypeSafe order; an explicit fallback is preserved unless identical to primary. Settings saves that same primary for the next job. `GEMINI_API_KEY` uses the HUD credential loader. Gemini quota replies cool it down process-wide for Retry-After/retryDelay or 60 seconds; safety 400 is a refusal. `decideProviderId` checks one selected provider; `ask/config.ts` shares the credential/fallback rules. Provider keys are private fields, not enumerable properties. `OPENAI_BASE_URL` may include a trailing `/v1`; that suffix is stripped before `/v1/decisions` is appended.
- `judge()` asks read-only page statements. TypeSafe maps each statement to a yes/no choice, OpenAI maps it to a predicate, and Gemini uses `noul` directly as the probability. One-choice OpenAI and Gemini questions are padded with `NONE`. `awaitState` pauses its stable-page deadline while the document is visibly loading.
- OpenAI responses renormalise only when strict `validateChoice` fails, every returned key is a known id, values and confidence are finite and in `[0, 1]`, the choice is a known id and a maximum of the returned mass, and that mass is in `[0.95, 1.02]`. Missing ids are filled with 0 and the distribution is divided by the mass. Mass above 1.02 is `DecisionInvalid`. The 200-choice probe did not need this path.
- The OpenAI wire body adds a `NONE` choice ("No observed element fits this operation.") to any target question that has exactly one candidate. The Decisions API rejects a choices array shorter than 2. TypeSafe is not padded. Selecting `NONE` is no valid target for that operation: the same path as a refusal of the selected target head, so nothing is acted.
- A refusal of the operation, or of the target head that operation selected, does not act. The agent observes once and asks again. A second refusal in the same `predict` sets `status` to `blocked` and throws `DecisionRefused`, even when the fingerprint changed. The question is stored on `question` because assigning `Error.name` would overwrite the exception name. The fingerprint is kept on the decision record only. Unused target-head refusals are ignored. A missing selected target head is `DecisionInvalid`, not a refusal. Refusals, invalid responses, and network failures all count toward the decision budget because the budget increments before the call returns.
- `setGoal` clears `decision`, sets `status` to `ready` and `plan_index` to 0, and keeps `history`. Action and decision budgets, and the three-unchanged non-wait rule, restart for the new phase. Upstream counted `len(history)` and `len(decisions)` for the whole run. This matches the design's per-phase counting.
- `open` waits until `document.readyState === 'complete'` and `location.href` is not `about:blank`. A normalised or redirected URL is accepted. `Page.navigate` `errorText` throws `cdp_navigate_failed`. The readiness poll uses a 2 second CDP timeout. Upstream waited on `readyState` only; `about:blank` is already complete, so that check can return before the requested page loads.
- `questions.ts` exports `MAX_STEPS` only. The decision budget is `MAX_STEPS * 2` inside the agent. The 250-candidate cut still happens inside `snapshot.js`.
- `tests/test_agent.py`'s flight-verification case is not ported. It imports `examples/flights.py`, which is outside the J1 cases.

`pythonJson` follows `json.dumps(..., sort_keys=True, ensure_ascii=True)` with separators `(', ', ': ')` for the values this port sends. Provider request bodies use `JSON.stringify` (UTF-8, not `\u` escapes), which is what `fetch` sends.
