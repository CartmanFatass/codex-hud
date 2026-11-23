# 03: Facts: agy's missing instructions.md and settings for reminders and transcript copies

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Survey 2026-11-22: one agy conversation tried to read ~/.gemini/antigravity-cli/mcp/hud/instructions.md, which does not exist (a wasted call); agy injects a 570 B 'Reminder: work efficiently' 2-5× per conversation, doubles Created/Completed headers per result, and writes each transcript 2-3× on disk (0.5-1.5 MB per conversation, 501 dirs). Find: when agy writes instructions.md for an MCP server (from the server's MCP `instructions`?) and whether HUD's server should provide it; whether agy settings/flags can turn off the reminder or the duplicate transcript copies; how much disk the brain dir uses and whether agy prunes it. Facts only.

- [ ] Report with sources (agy --help, settings schema, binary strings, file timestamps) for each question
- [ ] Clear yes/no on whether HUD should ship MCP instructions for agy

## Comments
