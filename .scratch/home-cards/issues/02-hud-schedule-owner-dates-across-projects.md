# 02: hud_schedule: owner dates across projects

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Build the storage and MCP tool of the owner-settled design `docs/design/home-cards/README.md` section 5 (D-2026-11-24-02): `$HUD_HOME/schedule.json` (private, atomic 0600 write, abstract lock, version, seq, items with id/date `YYYY-MM-DD` or `YYYY-MM`/text ≤160/optional project and objective/created_at/done_at), bounds (≤200 open items, done items dropped 30 days after done_at, reads capped at 64 KiB), and a new MCP tool `hud_schedule` with ops `add`, `done`, `move`, `list` (each item with its stage: far, soon, today, overdue). The tool description carries the rules (the MCP owns the protocol): a schedule item says when, a request says someone waits; resolve with `done`. Register the tool in the HUD MCP surfaces the other tools use (main sessions of Claude Code, pi and Codex). Add one line to `packages/hud-mcp/hud-convention.md` only if a main session would otherwise not know the tool (mechanics only; update its digest test). No panel rendering in this ticket. Update `docs/reference.md`.

- [ ] Tests: add with a day date and a month date, list sorted with stages, move, done removes it from list; a 201st open item is refused; a done item older than 30 days is dropped on the next write
- [ ] Test: an unregistered project or unknown Objective is refused at add
- [ ] The land gate passes

## Comments
