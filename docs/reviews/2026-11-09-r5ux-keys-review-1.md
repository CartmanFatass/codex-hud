Verdict: changes-required

## Findings

### 1. Major — AI Studio still implicitly reads another tool's configuration

**`src/jev/runtime/aistudio-state.ts:55`**, reached through **`src/jev/runtime/executor.ts:432,823`** — The configuration-independence migration covers `loadJevConfig`, but the active AI Studio loader still defaults to `~/.config/jev-ask/config.toml` without `JEV_ASK_CONFIG`.

**Failure scenario:** With valid `$HUD_HOME/config.json`, synthetic credentials in `credentials.env`, no `JEV_ASK_CONFIG`, and an invalid foreign TOML, the runtime starts successfully but an AI Studio `createJob` fails with `aistudio_config`. With a valid foreign TOML, it silently takes that tool's models, CDP endpoint and state-directory configuration instead. Settings in the HUD JSON's `aistudio` section are ignored. This violates the brief's self-contained configuration goal and explicit-only TOML requirement.

I reproduced the first scenario against the built production `JevRuntime`, using temporary HOME/HUD_HOME, fake execution and an injected AI Studio target so no browser/provider call occurred. Actual result:

```text
Valid HUD JSON and no JEV_ASK_CONFIG: runtime starts, but aistudio createJob fails with aistudio_config
EXIT 0
```

**Suggested fix:** Load AI Studio settings from this runtime's `$HUD_HOME/config.json` (`aistudio` beside `jev`, retaining the existing TOML-table field shape); read TOML only when explicitly selected through `JEV_ASK_CONFIG`. Preserve the deliberately shared AI Studio state-directory semantics and add poisoned-foreign-TOML coverage through the active AI Studio path.

The orchestrator confirmed this is in scope in review question **q6**, including that JSON shape and the unchanged shared-state requirement. The existing poisoned-TOML test exercises only `loadRuntimeConfig`/`loadJevConfig`, so it does not detect this omission.

## Verified

- Reviewed the complete diff against `1f20f0157ec29b9dce151d86f084459950556768`, the untracked `tests/unit/hud-credentials.test.ts`, the task brief and implementation notes, applicable project/architecture/privacy guidance, and rulings q1–q5. The isolated `src/tree-page.ts` effort wiring and the five assertion-hash exceptions/test-title rename match their authorizations; no visual golden changed.
- The credentials reader uses descriptor-based `O_NOFOLLOW`/`O_NONBLOCK` checks, requires a regular 0600 file, performs no interpolation, and implements environment > credentials.env > jev.env per-name precedence. Tests use real temporary files, including a deadline-bounded FIFO check.
- The real request builder binds general keys to the exact official HTTPS OpenAI/Mistral origins, rejects userinfo, preserves explicit-key precedence, and keeps redirects refused. Tests cover lookalikes, HTTP, custom ports and local/custom endpoints.
- Explicit tier efforts, the approved legacy mapping (`true` → none/low/low; `false` → off/off/off), typed-only minimal/medium compatibility, 512-token reasoning headroom, and the supplied Mistral thinking-part shape are covered. The probe test records actual SmallModel HTTP request bodies and headers using injected fetch; it does not substitute the B17 synthetic model.
- Jev decision-provider selection and the ordinary HUD JSON/explicit-TOML path are exercised with the real reader/runtime. Importer tests cover explicit sources, preservation of existing Mistral/unknown assignments, unsafe destinations and names-only output.
- Inspected the three supplied mutation logs: each reports one failed test for its intended mutation (origin leakage, removed permissions check, restored implicit TOML). I did not mutate repository files to repeat those checks in this read-only review.

### Independently run checks

Node **v24.22.1**, npm **11.19.1**. Commands ran sequentially with temporary HOME/HUD_HOME and `NO_COLOR`/`FORCE_COLOR` unset. All required checks passed on their first review run; no isolated failure rerun was necessary.

| Command | Actual output/result | Exit |
| --- | --- | --- |
| `npm run build` | `node ./node_modules/typescript/bin/tsc && node scripts/copy-jev-assets.mjs dist` completed without compiler errors | 0 |
| `npm run build:test` | `node ./node_modules/typescript/bin/tsc -p tsconfig.test.json && node scripts/copy-jev-assets.mjs dist-test` completed without compiler errors | 0 |
| `npm run test:unit` | `tests 4090`; `pass 4064`; `fail 0`; `cancelled 0`; `skipped 26` | 0 |
| `npm run test:mjs` | `tests 391`; `pass 390`; `fail 0`; `cancelled 0`; `skipped 1` | 0 |
| `npm run test:hud-mcp` | `tests 212`; `pass 211`; `fail 0`; `cancelled 0`; `skipped 1` | 0 |
| `bash tests/run-main.sh` | `run-main summary: files=113 tests=1176 pass=1176 fail=0`; `run-main: TAP covers every named node:test title` | 0 |
| `npm run format:check` | `All matched files use Prettier code style!` | 0 |
| `git diff --check` | No output | 0 |

The additional isolated AI Studio reproduction above also exited 0, confirming the reported defect. No real credential file, live provider, shared browser, real installer or real tmux acceptance check was used.

Report: `/home/fires/projects/MyHUD/tmp/tasks/R5UX-KEYS/review-1.md` — 1 finding (major).
