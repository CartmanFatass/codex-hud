# 03: Entry docs and package metadata describe the current four-client HUD

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** package.json still describes 'Real-time statusline HUD for OpenAI Codex CLI'. README.md never mentions Antigravity (agy) as a client, nor the optional Claude mod, and lists main-session tools only partly. docs/ARCHITECTURE.md §2 repository map names src/mcp/thin-main.ts as the MCP surface, but that file is now a 4-line stub. Update: package.json description (keep name codex-hud, the package is not published); README client list and what each client gets (bar, panel, worker places) plus the optional claude-mod and the main-session tool list as in docs/reference.md; ARCHITECTURE §2 map rows so every path exists and names where its responsibility now lives. Take facts from code and docs/reference.md only; spec.md wins on conflict. Keep README's length within +40 lines; English only.

- [x] package.json description names Claude Code, Codex, pi and Antigravity; name and version unchanged
- [x] README names all four clients and the optional Claude mod, and its tool list matches docs/reference.md
- [x] Every path in ARCHITECTURE §2 exists (checked by a script in the report) and each row names the current responsible module
- [x] No behaviour or code change; npm run build passes

## Comments

- Landed in this commit (replay base 8ec5e9ea59122e6bb39b810e728bf1dd3cd00593); gate 5/5 passed.
