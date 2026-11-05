# Experimental managed Claude and Pi targets

The production delegation composition now includes Codex, Claude and Pi launch preparers. Both new targets use the existing accepted-intent ticket, `launchPreparedRun`, `hud-run`, ledger, authenticated `delegate_whoami` / `delegate_report`, scope retirement and resume lifecycle. They do not use the independent experimental Claude-print or Pi-RPC transports. There is no HUD chat UI or live stdin channel.

## Scope and release gates

- Claude: native 2.1.305, Linux, headless print/stream JSON, persisted sessions, `claude_pre_tool_use_v1`, and `config_env`. Explicit existing HUD stdio configuration is required. Hooks remain active; bare, continue, fork and no-persistence selectors refuse.
- Pi: 1.4.0, Linux/Node, persisted print/JSON, exact session root, `pi_extension_v1` and the shipped extension. The narrow profile explicitly chooses no automatic extensions, skills, prompt templates or themes. These flags are not silently added to arbitrary user profiles. Resume selects one verified existing v3 file by its full ID, not a picker, fuzzy name or synthetic replacement.
- Role mappings, bounded immutable input, source/profile checks, one-level managed-child restriction and request-key replay are unchanged. Resume must bind the original full SessionRef; missing/replaced identity cannot become a new session under the old link.
- Shipped managed and compatibility Codex capability manifests remain empty. Partial configuration coverage from either new preparer cannot be promoted by the production verifier, even if a cell is supplied. Verified product support still needs complete exact-profile, executable/version, configuration, host and runtime evidence. Test-only constructor verification is not a production switch.
- Startup observes target executables separately from the calling harness. Native version probes strip all HUD authority and stale Pi session/channel markers after inherited and profile environments are merged. Missing facts remain unverified. Shell/script wrappers are not treated as native executable-version evidence by the bounded startup probe.

## Private Claude artifacts

The preparer performs no writes. It creates at most three bounded JSON payloads for the existing supervisor: Claude hook, settings and MCP configuration. Fixed-kind filenames contain the SHA-256 of their exact bytes under `HUD_HOME/runs/<runId>`. Settings and MCP argv paths commit this small dependency graph in the existing launch digest. There is no new run/meta schema or generic arbitrary-path writer.

The supervisor validates kind, count, canonical base64, per-file/total size, content hash and reachability from frozen argv before execution-ticket registration. Only the ticket winner creates the private run directory and exclusively writes files through its existing checked directory descriptor. Files are 0600, directories are 0700, symlinks and existing destinations refuse, and writes precede the single harness dispatch. Raw claims remain in protected transport/private MCP configuration, never frozen argv or ledger event payloads.

**Retention is deliberate:** this slice does not automatically delete these private support files, including after a successful terminal receipt. Their removal remains pending cleanup. In particular no uncertain/live scope loses credentials or settings beneath it, and partial writes are retained for diagnosis rather than retried or overwritten. Public exports and test evidence must not include their secret contents.

## Pi host identity

Pi changes its process title and erases the OS command line. The authenticated private fd3 host proof is retained only in the in-memory registration, not serialized as caller authority. Handshake rechecks that proof before and after the physical ancestry check, with exact PID/start/source agreement. ProcessReader observations are never rewritten. Per-call persisted session evidence still determines the full SessionRef.

## Verification levels

Focused preparation tests use synthetic configuration and version-labelled inputs. Owned-process tests use temporary HOME/HUD_HOME and real SQLite/supervision/proof paths with explicitly synthetic hosts and a constructor-only test gate. Official no-model Pi parser/session-manager checks are a separate evidence level. None of these results is real-provider observation, production capability qualification, or a claim of full desktop/platform coverage. Preserve failures and cleanup receipts alongside successful runs.
