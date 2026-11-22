# 06: CLI workers load only the HUD MCP and get instructions as system prompt

**Status:** ready-for-human
**Blocked by:** 02

**What to build:** Workers study §3.4 and §4 rank 3, D-2026-11-22-18. dispatchCli: Claude CLI workers start with --strict-mcp-config and only the HUD worker MCP plus servers the role file names (new optional role field, e.g. mcp_servers); Codex workers likewise only the HUD MCP plus named ones; agy as far as its CLI allows (say what it cannot). Pass role instructions as system prompt where the CLI supports it (claude --append-system-prompt) and inline briefs under 16 KB in the first message instead of 'Read <instructions> and then <brief>'. Reuses ticket 02's inline-brief helper. Spec §2.1.4 gets one sentence on worker MCP scope, told to the owner.

- [x] A Claude CLI worker launched by HUD sees only the HUD MCP unless the role names more
- [x] A short brief reaches a CLI worker inline; no startup read turns
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed 8c763005 via sonic gate (test:mjs 1045/1045 on run 2; run 1 one statusline-agy load flake (dogfood-fixes/07)).
