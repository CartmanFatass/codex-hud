# Upstream pin

Jev Ultrafast, MIT, Copyright (c) 2026 Browser Use.

- Repository: https://github.com/browser-use/jev-ultrafast
- Commit: `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`

| Upstream | Port |
|---|---|
| `jev_ultrafast/model.py` | `src/jev/model.ts` |
| `jev_ultrafast/questions.py` | `src/jev/questions.ts` |

`decide.ts` and the TypeSafe provider keep `model.py`'s `choose()` request shape; the OpenAI provider is a second backend for the same `DecisionRequest`.

## Deviations

- `choose` takes a `DecisionProvider`. `selectDecisionProvider` is async so the provider modules load after `model.ts` (they share `postJson` / `validateChoice`). An explicit provider wins; otherwise `decisions.primary` defaults to OpenAI. Automatic fallback is the first other keyed provider in Gemini → OpenAI → TypeSafe order; an explicit fallback is preserved unless identical to primary. Settings saves that same primary for the next job. `GEMINI_API_KEY` uses the HUD credential loader. Gemini quota replies cool it down process-wide for Retry-After/retryDelay or 60 seconds; safety 400 is a refusal. `decideProviderId` checks one selected provider; `ask/config.ts` shares the credential/fallback rules. Provider keys are private fields, not enumerable properties. `OPENAI_BASE_URL` may include a trailing `/v1`; that suffix is stripped before `/v1/decisions` is appended.
- `judge()` asks read-only page statements. TypeSafe maps each statement to a yes/no choice, OpenAI maps it to a predicate, and Gemini uses `noul` directly as the probability. One-choice OpenAI and Gemini questions are padded with `NONE`.
- OpenAI responses renormalise only when strict `validateChoice` fails, every returned key is a known id, values and confidence are finite and in `[0, 1]`, the choice is a known id and a maximum of the returned mass, and that mass is in `[0.95, 1.02]`. Missing ids are filled with 0 and the distribution is divided by the mass. Mass above 1.02 is `DecisionInvalid`. The 200-choice probe did not need this path.
- The OpenAI wire body adds a `NONE` choice ("No observed element fits this operation.") to any target question that has exactly one candidate. The Decisions API rejects a choices array shorter than 2. TypeSafe is not padded. Selecting `NONE` is no valid target for that operation: the same path as a refusal of the selected target head, so nothing is acted.

`pythonJson` follows `json.dumps(..., sort_keys=True, ensure_ascii=True)` with separators `(', ', ': ')` for the values this port sends. Provider request bodies use `JSON.stringify` (UTF-8, not `\u` escapes), which is what `fetch` sends.
