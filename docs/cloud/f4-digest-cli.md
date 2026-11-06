# Explicit delegated report digests (F4 CLI candidate)

This bounded, opt-in feature adds `hud digest`. It is a **test candidate**, not all
of F4, a release, or provider/host capability qualification. Local TypeScript,
build, format and behavioral suites have **NOT_RUN** in the implementation
workspace because compatible dependencies are unavailable. Synthetic test source
is included for normal local builds; no real provider or user home was used.

## Commands

```
hud digest --help
hud digest plan --run RUN --report REPORT --json
hud digest run --run RUN --report REPORT --expected-ledger LEDGER_ID --expected-recipient RECIPIENT_ID --json
```

There is no `latest`, batch, watch, background panel generation, send or ask.
Identifiers are explicit safe tokens (1–128 ASCII letters, digits, `_`, `-`);
recipient IDs are 64 lowercase hex characters. Unknown, missing and duplicate
arguments refuse before environment/filesystem access. Help needs no home or
ledger. HUD_HOME follows the existing private absolute home rules. The ledger
must already exist, with storage version 1. Nothing initializes or migrates it.

Plan emits one `hud-delegated-digest-plan`, schemaVersion 1 JSON document. It
identifies the exact ledger/link/run/report/full ref, metadata byte length and
accepted-event sequence, relative policy paths, resolved nonsecret route when
available, and readiness. It never selects summary text, constructs a prompt or
content cache key, accesses model caches/budget, writes telemetry or creates a
directory. A ready plan is informational, not a reusable authorization token.

Run re-resolves current state and requires both expected ledger and resolved
recipient to match. Its `hud-delegated-digest`, schemaVersion 1 JSON includes the
same exact selection, delegated origin, digest purpose, recipient/model/language,
`generatedAt` (epoch milliseconds), `cached`, `material: completed_report_summary`
and `digest: {conclusion, basis?, caveats?}`. There are no private absolute paths,
configuration objects, credentials, input text, prompt or MaterialEnvelope in
these documents. Provider errors are never printed.

## What is authorized

Only one authenticated **completed report's summary** becomes the public `result`
material. The relationship must be confirmed and current-owned, the selected run
must still be current, and the selected report must be its latest accepted
`report.received` event. Full ref, registered source/harness/session, run and
binding generations, caller/context, and accepted binding evidence must agree.
Ambiguous events, unresolved conflicts (including another relationship with the
same full target), stale selections and handover refuse. Historical revocation
of an accepted binding does not erase the report. A closed current-owned
relationship can retain a readable report; it is not reopened.

A completed report and its generated digest **do not prove run termination or
task correctness**, and grant no process, host or MCP authority. Coverage is
complete for this one summary record only, not a session/transcript/task. No
observation stamp or source generation is invented. reportPath, stdout, task,
parent text, private/reasoning/unknown channels and transcripts are never read.
Summary bounds are 32 KiB UTF-8 and 8000 Unicode code points; oversize, empty or
sealed material refuses rather than truncating. Metadata uses SQL byte length
without transferring the body. The only body query occurs after both grants.

## Explicit private source configuration

The user provisions exactly `HUD_HOME/sources/<actual sourceId>/model.json` and
`outbound.json`. This command never writes them. Source ID is the bound ref's 64
lowercase hex ID, not a guessed home. Directories must be real same-uid private
directories (normally 0700); files private regular single-link files (normally
0600), without symlinks. Reads are bounded to 64 KiB, no-follow, and checked before
and after. Unsafe paths are refused, not repaired.

A synthetic example (replace the source and full ref with plan's actual metadata):

```json
{
  "schemaVersion": 1,
  "sourceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "revision": 1,
  "connection": {
    "backend": "api",
    "base": "https://synthetic.invalid/v1",
    "model": "synthetic-model",
    "account": "synthetic-account",
    "keyEnv": "SYNTHETIC_DIGEST_KEY",
    "reasoning": false
  },
  "delegatedDigest": { "enabled": true, "paused": false, "language": "en", "hourlyCap": 60 },
  "materials": [{
    "ref": { "harness": "claude", "sourceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "sessionId": "synthetic-child", "threadId": null },
    "origin": "delegated", "purpose": "digest", "fields": ["result"]
  }]
}
```

All keys are explicit; unknown keys, duplicates in the scope list, wildcards and
unsupported values refuse. `revision` is a positive safe integer; scope has at
most 256 entries. `language` is `en` or `zh`, hourlyCap is 1–1000, switches are
booleans. `connection: {"backend":"off"}` is the only off variant. Other backends
are not supported here. API base/model/account are bounded nonempty strings.
The existing `modelHttpRequest` and `resolveRecipient` determine the actual
chat-completions URL, canonical recipient and model; credentials in URLs, query
routing, fragments and unresolvable recipients refuse.

`keyEnv` is an explicit environment variable name. Only that selected nonempty
key is used, in memory. No ambient OPENAI_API_KEY, CODEX_HUD_BRIEF_MODEL or legacy
key override is allowed. `keyEnv: null` requires the reserved account label
`accountless`; named-key connections cannot use that label. Keys never enter
recipient/config identities, logs or persisted config. The account label is
**user-declared, not provider-attested**. Update the account label and grant when
changing accounts. Credential continuity is checked within an invocation;
hidden profile/account changes across restarts remain the existing B17 limit.
This feature introduces no persisted verified-account or anti-rollback baseline.

Use plan's recipientId for the independent existing outbound policy schema:

```json
{
  "schemaVersion": 1,
  "sourceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "revision": 1,
  "grants": [{ "purpose": "digest", "recipientId": "<plan recipientId>", "decision": "allow", "grantedAt": 1793923200000 }]
}
```

Exact full-ref delegated/result/digest scope **and** source/digest/recipient allow
are required. Deny wins. Old Codex resultDigest/brief settings, native permission,
a credential, a displayed node or delegation existence grants neither. Model
scope and outbound revisions are independent and must advance when meanings
change. The invocation repeatedly checks captured meanings/revisions, directory
identities, live key and current target. Once it observes missing, unsafe,
corrupt, changed or revoked state, restoring old bytes cannot revive it. There
is no watcher, policy migration or automatic repair.

## Model, cache, budget and lifetime

The generic materialRequest/SmallModel boundary composes only the admitted
summary. The fixed neutral prompt treats quoted report content as data. A strict
parser admits one JSON object with only conclusion and optional basis/caveats:
strings of at most 160 Unicode code points, one logical line, no terminal controls.
Conclusion is nonempty. No fences, extra actions/lifecycle fields, coercion,
truncation, translation or repair model calls are accepted. The optional pure
SmallModel response validator checks fresh and cached responses, fails closed on
exceptions, and preserves existing callers when absent. Existing language checks
still apply before reuse/publication.

After initial authorization, run alone may create
`sources/<sourceId>/model-runtime-v1/`. All F4 invocations in that source share
SmallModel's existing budget/claim coordination and hourly cap across reports,
recipients and languages. This is **not** a merged legacy+generic global budget.
Private generic replies and provenance sidecars retain the existing materials-v1
layout. Cache identity includes exact ledger/ref/run/report/event, format,
language, route/model and authorization provenance/revisions. No AgentLog or
RecapStore output is added. Unsafe existing runtime entries refuse without chmod.

Transport timeout is 30 seconds; the entire run, including queue/peer-budget
waiting, has a 60-second deadline. SIGINT, SIGTERM and an injected abort cancel
work even before fetch. The invocation becomes inactive before cleanup, so late
uncooperative transport results cannot publish or deliver. Abort also settles the
awaited transport wrapper. All owned listeners/timers are removed, read handles
close, cancelAll runs, and telemetry flush is bounded to 500 ms. No network retry,
service fallback, daemon or host process is launched.

## Fixed exit and reason codes

- 0: help, plan (including not-ready metadata), successful run.
- 1: `internal_or_output_failure`.
- 2: `invalid_arguments`; reader API invalid identifiers use `invalid_target`.
- 3: `invalid_hud_home` (existing private-home rules).
- 4: `target_unavailable`, `target_changed`, `source_configuration_invalid`,
  `source_path_unsafe`, `source_changed`, `credential_unavailable`,
  `recipient_unavailable`, `expected_ledger_mismatch`,
  `expected_recipient_mismatch`, `backend_off`, `feature_disabled`,
  `feature_paused`, `material_scope_denied`, `outbound_denied`, `runtime_unsafe`,
  `authorization_changed`.
- 5: `unsupported_ledger_schema`, `runtime_unavailable`, `model_runtime_unavailable`.
- 6: `material_invalid`, `invalid_response`, `model_failed`, `hourly_cap`,
  `cancelled`, `timeout`.

Errors are one fixed line on stderr, no success JSON. Output-stream errors can
leave an already attempted partial OS write; the command does not retry output
or provider requests. Plan readiness uses the applicable source reason above or
`ready`. Existing commands keep their old mappings.

## User-local validation checklist

On the final independently published test-branch SHA, with ordinary dependencies
available, run (each build/test command bounded to 180 seconds):

```
npm run build
npm run build:test
npm run build:hud-mcp
node --test dist-test/tests/unit/source-model-config.test.js dist-test/tests/unit/delegated-report-read.test.js dist-test/tests/unit/delegated-digest.test.js dist-test/tests/unit/digest-cli.test.js dist-test/tests/unit/materials.test.js dist-test/tests/unit/small-model.test.js dist-test/tests/unit/b17-legacy.test.js dist-test/tests/unit/product-cli-routing.test.js dist-test/tests/unit/hud-link-export.test.js
npm run format:check
npm run check:fixtures
git diff --check
```

Format timeout: 120 s. Fixture timeout: 60 s. Diff timeout: 10 s.

- Use disposable private HOME/HUD_HOME/CODEX_HOME, native SQLite fixture and
  injected fake fetch only. Never use real transcripts, credentials or providers.
- Verify installed help/refusal routing and an actual plan/run with fake API
  through the built CLI API. Confirm the exact endpoint/model and one JSON result.
- Old Codex settings alone refuse; exact material scope plus outbound grant
  enables generation. Check same-source queued revocation, late reply discard,
  cache reuse/segregation, shared source cap, cancellation and output failure.
- Verify emitted import closure and ordinary source/output/archive inventory
  after normal builds, including only actually emitted MCP copies.
- Confirm legacy CLI/output remains intact. Observe unchanged ordinary CI only
  at its actual commit and actual suite list; routing success is not F4 coverage.

Real provider/account validation is a separate optional user action. No
capability cells, package identity, ledger DDL, contracts, migration, installer,
renderer, publication or scheduling are changed. Automatic panel summaries,
failed/blocked/interrupted reports, multiple reports, native extraction and
provider attestation remain deferred.

## Package handoff

Base: `ac785ae3a6a9116471be40d35d51292e525e31c3`, tree
`a81f758cb828185f5586c6f8dc46bde818bd715b`. New product modules are the narrow
reader, source-config snapshot, one-shot generic service and digest CLI. Existing
edits are routing/help, the optional SmallModel validator and privacy/reference
discovery, with synthetic fixture and regression tests. No main/integration or
release changes are part of this candidate. Coordinator review/publication and
all unrun ordinary local checks remain explicit requirements.
