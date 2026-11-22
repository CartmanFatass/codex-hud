# Experimental managed Claude target

This implementation adds a real managed **target** preparer to the existing
`DelegationService → accepted intent → launchPreparedRun → hud-run` route. It is
not a wrapper around `ClaudePrintTransport`, a new chat UI, a provider test, or a
production capability promotion.

## Selected lane

- Native Claude Code **2.1.305**, headless, `host:none/layout:none`, argv execution.
- Default discovery with `-p --output-format stream-json --verbose`. An optional
  `--include-partial-messages` remains observational. Task bytes go through the
  existing bounded, snapshotted stdin delivery, never shell interpolation.
- Resume selects one full lowercase canonical UUID through `--resume
  {{sessionId}}`. Continue/latest, forks, bare, session-persistence disabling,
  custom agents, extra discovery selectors and positional prompts are refused.
- Explicit `callSource:{kind:'claude_pre_tool_use_v1'}` and `config_env` are
  required. Default discovery is intentional: `--bare` suppresses hooks and is
  incompatible with this identity lane. Existing tmux configuration gates are
  unchanged.
- Role mappings are data. Explicit model/effort values use `--model` and
  `--effort`; a role without a mapping or explicit model refuses. No model is
  guessed from the role name, no extra scheduler is introduced, and no permission
  bypass or blanket tool allowance is added.

## Configuration and identity

The preparer makes bounded reads through held, no-follow parent descriptors of local user/project MCP and
settings inputs plus the known `/etc/claude-code` managed locations. It requires
one unambiguous matching stdio server definition. Missing, conflicting,
HTTP/remote, malformed or explicitly disabled selected servers refuse. User
settings and other servers are never written or cleared.

The snapshot is explicitly **partial**. It does not claim to reconstruct remote
policy, plugin/connector discovery, the effective settings merge, or changes
between snapshot and process launch. Those limitations, the actual local hashes,
selected server, resolved executable/version, helper hashes, role/options and
operation enter the capability fingerprint. The new request reports
`configurationCoverage:'partial'`; the production verifier refuses such a
request even if a matching accepted cell is supplied. The shipped matrix stays
empty. Synthetic tests may use an explicitly trusted fixture verifier, which
cannot confer production support.

Three bounded content-addressed JSON artifacts are composed in memory:

1. `claude-hook.<sha256>.json` contains the existing hook's exact source,
   executable, selected profile digest and private run directory.
2. `claude-settings.<sha256>.json` adds only the existing helper's HUD
   `PreToolUse` matcher, preserving normal settings/hook discovery.
3. `claude-mcp.<sha256>.json` overlays only the selected, copied stdio server.
   Its command, arguments and ordinary environment stay intact. Fresh
   `HUD_CLAIM`, `HUD_RUN`, `HUD_LINK`, `HUD_HOME`, `HUD_MCP_PROFILE` and
   `HUD_CLAUDE_HOOK_CONFIG` replace HUD-owned leaves. These authority leaves
   remain only in the selected server overlay, never the top-level Claude
   environment inherited by unrelated MCP servers or tool children. Only
   `HUD_HOME` is retained at the top level for the supervisor.

The launch argv contains the settings/MCP artifact paths; these reference the
hook artifact. Thus the existing launch digest commits the full content-addressed
DAG without changing `RunLaunchInput`. Preparation and `forRun` do not write
files, spawn processes or touch the ledger. Only the registered supervisor ticket
winner validates/materializes the private artifacts before launch, using the
existing run-owned storage and materialization path.

The stream's `session_id`, a model claim and a print result never prove ownership
or completion. Existing per-call hook resolution, registered process/source
ancestry, `delegate_whoami`, `HandshakeService`, report authority, supervisor
scope receipts and one-level delegation guard remain authoritative. In
particular, a first print `result` cannot end the supervisor: current documented
Claude streams can emit multiple results when background work completes.

## Evidence and limits

Official rolling sources consulted on 2026-11-05 (documentation evidence, not a
binary/provider observation):

- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/settings

The exact helper implementation is `claude-hook-2`, pinned to 2.1.305 by the
existing repository hook contract. Local synthetic tests do not establish that
all rolling documentation describes the same binary revision.

`tests/unit/claude-managed-launch.test.ts` covers immutable stdin, write-free
preparation, exact run/profile/source injection, retained settings/server data,
content-addressed artifacts, UUID resume, role handling, dangerous/unsupported
selectors, executable/version/source refusals, bounded inputs and fail-closed
configuration. Existing `claude-configuration` and `claude-print-transport`
regressions remain separate checks of their existing surfaces. Shared runtime
integration tests own the actual accepted-intent, child identity, handshake,
report, scope completion, replay and resume scenarios; a preparation-only pass
must not be described as that end-to-end result.

Real Claude accounts/provider calls, native CLI observations, release capability
qualification, real user settings and HUD chat adaptation are **NOT_RUN** here.

Private launch artifacts are deliberately retained, including after proven terminal scope. Automatic cleanup is not implemented in this slice; removal remains pending, and uncertain or live scopes never lose their support files.
