# 02: Sonic thinking can be none; lookups lean low; native tools

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Owner 2026-11-22: deepseek-v4-1-flash supports none/low/high/max. Add `none` to sonic's thinking_choices (packages/hud-mcp/roles/sonic.json) for running a given command and reporting its output, copying exact text, listing files; tighten the level purposes so narrow named-file lookups pick low (81% of survey sonics picked high after auto-thinking). sonic.md asks for native read/grep/find tools over bash where the harness has them (38.6 bash vs 0 grep per survey). Spec §2.1.4 level list updated (draft; the main session tells the owner).

- [x] The Decision API can pick none, and a command-runner brief does
- [x] sonic.md names native read/grep tools
- [x] npm test and check:fixtures pass

## Comments
