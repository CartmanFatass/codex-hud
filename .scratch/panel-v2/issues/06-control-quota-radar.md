# 06: Control plane quota watermarks, pi spend and today's role dispatch radar

**Status:** done (12a9a868)
**Blocked by:** none

**What to build:** `docs/spec.md` §2.2 & `.scratch/panel-v2/spec.md` §6. Give the Control plane proactive visibility into client quota watermarks, today's pi spend, and today's per-role dispatch health so the owner can switch presets before hitting walls.

- [x] Control radar collector (`src/collectors/control-radar.ts`): read-only, bounded aggregation cached on 5 s ticks:
  - Client quotas: read latest known Claude / Codex quota percentages & reset times from `$HUD_HOME/display/state/*.json` snapshots when fresh (never invoking network calls);
  - Pi today spend: sum today's input/output tokens and cost (when recorded in pi session headers/entries under `~/.pi/agent/sessions` or HUD display cache, bounded to today's modified files);
  - Today's role health: scan newest 200 `$HUD_HOME/jobs` created today (local TZ) to tally per-role `{ total, ok, failed, quiet_escalated, avg_minutes }`.
- [x] Render a compact `Radar` / `Quota & today` section on the Control plane (`src/render/control-view.ts` and `src/render/split-project.ts` `controlPart`, e.g. a `split:radar` row + preview and inline summary on role previews) that fits cleanly at 40 and 80 columns, omitting absent metrics rather than showing fake zeroes.
- [x] Add EN/ZH translations and unit tests with synthetic state snapshots and job receipts.

## Comments
