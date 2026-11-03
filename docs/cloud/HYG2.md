# Brief HYG2: small hygiene items left by HYG1

Tier S.

## Base

`universal-hud`.

## Items

1. **The SQLite warning from `hud link export`.** On Node 22 a real user sees the ExperimentalWarning on stderr.
   - The panel already suppresses it: `src/collectors/daemon-binding.ts:47`.
   - `src/ledger/runtime.ts` does not.
   - Apply the same suppression and add a test.
2. **`b45-launch` test 9.** When its 10 s timer fires, kill `result.pid` before rethrowing, so the detached supervisor
   does not outlive the test. Add a test.
3. **Process helpers.** `tests/int/b12r-process.mjs` and the similar helpers import `dist/` and leave stderr unread.
   Make them fail fast with the helper's stderr, as `b12-store` now does.

## Acceptance

- Each item has a test that fails without the change.
- The README check set is green.

## Ownership

`src/ledger/runtime.ts` (the warning only), and `tests/unit/b45-launch.test.ts` and the listed helpers.
