# Experimental Pi managed target

`preparePiLaunch` prepares a Pi **target** for the normal managed delegation
pipeline: accepted intent, private supervisor ticket, `launchPreparedRun`, and
`hud-run`. It is distinct from the ordinary foreground launcher and the
unmanaged RPC transport. Preparation does not create a session, launch a process,
write settings, accept an intent, or grant a verified capability.

## Selected surface

The first profile is Linux, direct executable argv, headless host `none`, and
`@earendil-works/pi-coding-agent` **1.4.0**, source commit `4a080252`.
It uses persisted, single-shot `--mode json --print` with the shipped
`extensions/pi/hud-delegate.ts` extension. The profile must select
`callSource: { "kind": "pi_extension_v1" }` and `claimTransport: "config_env"`.
No shell, RPC, ephemeral session, interactive picker, native fork, positional
prompt, or unrecognized option is supported by this narrow preparer.

The profile must explicitly opt into `--no-extensions --no-skills
--no-prompt-templates --no-themes` in both managed templates. The preparer never
silently suppresses discovery in an existing profile. The pinned Pi loader still
loads an explicitly selected `-e` path with `--no-extensions`. Other discovery
profiles remain outside this implementation's scope; no global settings or
native agent behavior is changed.

For example, the two managed template fields can be:

```json
{
  "headless": {
    "argv": ["pi", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"]
  },
  "resumeHeadless": {
    "argv": ["pi", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--session", "{{sessionId}}"]
  },
  "roles": {
    "implementer": { "model": "provider/model", "effort": "high" }
  }
}
```

These are partial configuration examples, not executable capability evidence.
The preparer supplies the canonical source directory, JSON/print switches,
absolute shipped extension, resolved model and `--thinking`. Explicit copies in
the template must match exactly; duplicates, conflicting selectors and unknown
flags are rejected. Thinking accepts the pinned vendor's `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max` values.

## Input, identity and resume

- Brief bytes are bounded and snapshotted before acceptance. The optional bounded
  prompt and instructions to call `delegate_whoami` and `delegate_report` travel
  once through protected stdin. They are not shell code or argv prompt text.
- Each run gets fresh `HUD_RUN`, `HUD_LINK`, `HUD_CLAIM`, `HUD_HOME`, and the
  selected `HUD_MCP_PROFILE`. Parent HUD authority, private test/channel selectors,
  and inherited Pi session hints are removed. Ordinary provider environment and
  explicit `PI_CODING_AGENT_DIR` remain intact.
- New spawn has **no session selector** and lets Pi create a fresh native session.
- Resume searches at most 4096 directory entries, one child-directory level, and
  64 JSONL headers. Exactly one canonical, in-source, existing v3 header must match
  the complete bound session ID. Symlinks, outside paths, missing/empty files,
  partial IDs and ambiguous matches cannot select a session. The actual command
  receives `--session` with that exact file path, not a fuzzy identifier.
- Preflight cannot freeze a native session file against later replacement.
  Pi can create a new identity if its selected file disappears or becomes empty.
  Shared handshake validation must therefore also match the full expected
  `SessionRef`; a changed identity cannot bind, report, or cause an automatic retry.
  Filesystem inode identity does not replace session identity.
- The official extension supplies independent per-call identity. Preparation does
  not synthesize whoami, reports, a managed binding, or permission for nested HUD
  children. The normal one-level delegation guard remains authoritative.

## Evidence and limitations

The fingerprint includes resolved executable identity, the selected vendor
profile, shipped extension and bridge implementation hashes, fixed templates,
source, model/thinking, profile environment, and bounded agent/project settings
and model configuration snapshots. It does not read authentication files or claim
those snapshots cover every possible provider configuration. Unknown versions or
missing exact product evidence cannot become a production verified cell.

Focused checks are `npm run build`, `npm run build:test`, and
`node --test tests/unit/pi-managed-launch.test.mjs`. The process test uses real
temporary `hud-run` supervision, protected input, group lifecycle and a finite
synthetic Pi executable with an explicit file-backed test port. It does not
manufacture MCP handshake/report evidence and is not a real-provider test.
The shared integration tests separately cover the production default registry,
accepted intents, authoritative host proof, whoami/report and resume binding.

The optional existing `tests/probes/pi-delegation-official.mjs` exercises the
already installed official Pi loader and extension without a model. That evidence
is a separate category from the synthetic process test and from authenticated
provider or full product-capability qualification. No test result alone promotes
a shipped capability cell.
