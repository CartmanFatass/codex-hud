# 05: Migrate MyHUD to the JSON store, delete the Markdown tickets, update docs and skills

**Status:** ready-for-agent
**Owner try:** no
**Live try:** After landing: `hud_tickets ready` and the panel's Feature page show the same tickets as before the migration; `.scratch/*/issues/` is gone and `.scratch/*/spec.md` remain.
**Approved removals:** Local Markdown ticket files `.scratch/<feature>/issues/*.md` after lossless migration (owner 2026-11-26, D-2026-11-26-06; spec Removed by this spec)
**Blocked by:** 02, 03, 07, 08, 09
**Objective:** ticket-store

**What to build:** Design: docs/design/ticket-store/README.md §5. Start only when no ticket-queue run on MyHUD is working and toktrack already reads `.hud/tickets/*.json` (toktrack ticket in its own tracker; check its land first). Run `hud tickets migrate --delete-legacy` on MyHUD, keeping `.scratch/<feature>/spec.md` and prose notes. Remove the `.scratch` write paths and the Markdown fallback readers that no migrated project needs (keep the fallback only if another registered project still has `.scratch` tickets; say which in the report). Update `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md` (claimed/done lifecycle, resolved → done), `integrations/tickets/method.md` (`hud_tickets guide`: get/ready/add/update/commit, no Markdown ticket template), `integrations/skills/hud-delegate/SKILL.md` (pass `ticket` without `brief_file`), `packages/hud-mcp/hud-convention.md`, `packages/hud-mcp/instructions/lead.md`, `docs/ARCHITECTURE.md` and `docs/reference.md`.

- [ ] All MyHUD tickets exist in `.hud/tickets/*.json` with the same statuses, blockers and acceptance as before (count per status reported)
- [ ] `.scratch/*/issues/*.md` is deleted; spec.md and prose notes remain
- [ ] Docs and skills describe the JSON store and no longer tell anyone to edit ticket Markdown
- [ ] Full test suite passes

## Comments
