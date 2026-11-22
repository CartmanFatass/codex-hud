# 01: `./install --with agy` wires agy to the HUD and uninstalls cleanly

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Proposal docs/neon-proposal/25-agy-adapter.md §2.1 (owner, 2026-11-22: installation may edit agy's own config; delivery A+B). New `install.d/agy.sh` modelled on `install.d/claude.sh`:
- registers the `hud` MCP with the official command (`agy mcp add --env HUD_MCP_SURFACE=roles hud "$BIN_DIR/hud-mcp"`);
- adds `mcp(hud/*)` to `permissions.allow` and the HUD `statusLine` to `~/.gemini/antigravity-cli/settings.json`, keeping an owner's non-HUD statusline;
- registers the HUD PreInvocation hook through an official agy mechanism, sourced from `$HUD_HOME`. The hook script can be a no-op stub until 03, and herdr's own hook stays untouched.
- `--uninstall` reverses exactly what HUD wrote.
Also land the approved spec sentences:
- §1: Antigravity joins the list.
- §2.1.3: agy workers get the worker MCP, with the shell done-command fallback kept.
- §2.1.6: a working agy session gets events through its PreInvocation hook; an idle one has them typed into its prompt.
- §2.2.1: the agy statusline.
- §2.4: the `agy` extension.
Update reference.md and reference.zh.md.

- [ ] Install then uninstall against a temp HOME with synthetic agy config files leaves them byte-identical, apart from deliberately foreign edits made in between
- [ ] Re-install is idempotent; an owner's own statusLine is kept
- [ ] npm test, check:fixtures and test:release pass

## Comments
