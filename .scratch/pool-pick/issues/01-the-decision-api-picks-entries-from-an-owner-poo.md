# 01: The Decision API picks entries from an owner pool for a role's job

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Spec §2.2 (Decision API uses, D-2026-11-24-04). A role file may declare `"pool": {"dir": "<abs path>", "max": 4, "default": ["<file>.md", ...]}` (first user: frontend-imp pointing at the owner's Personal Standards style pool; HUD reads it, owns none of it). On hud_create for that role: build an index of the pool (each `*.md` except README.md: file name, `# ` title, and the header lines before the first `## `, at most 400 bytes per entry; plus the first 8 KiB of README.md as selection rules; bounded to 64 entries / 48 KiB). If the brief already names any entry by file name or stem, make no call and record that. Otherwise, when the new Settings switch `poolPick` (Decision API group, default on) is on, call the Decision API the way `src/mcp/sonic-thinking.ts` does (brief as untrusted quoted data, first 4000 chars) for 1..max entry file names plus a one-line reason; drop unknown names. On switch off, failure or timeout, use `default`. Attach the picked files as references exactly like context_files (a read line for local workers, bounded inline for browser roles). Record `pool_pick {entries, reason, source: 'decision'|'brief'|'default', ms}` on the job record and the archive, and show it in the hud_create receipt so the main session can tell the owner in one line. Same timeout and fallback discipline as Sonic thinking; no call for roles without `pool`.

- [ ] A fixture pool and a brief with no entry named produce a Decision API request listing the entries (stubbed endpoint) and attach the returned files; unknown names are dropped
- [ ] A brief naming an entry makes no call and records source brief; switch off or endpoint failure records source default with the default files
- [ ] pool_pick appears on job.json, the archive row and the hud_create receipt
- [ ] docs/reference.md describes the role-file pool field and the Settings switch in one paragraph; the MCP tool declaration budget test still passes

## Comments
