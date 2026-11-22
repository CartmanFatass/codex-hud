# 03: The Decision API routes imp work by tier and mode

**Status:** ready-for-agent
**Blocked by:** 01
**Owner try:** no

**What to build:** Spec §2.1.2 "Imp routing" (22.22). Settings toggle "Imp routing" (off by default), which needs the Decision API like Sonic auto-thinking and reuses its client, budget and fallback code. When on, an `imp` create with no `preset`, `on`, `model` or `thinking` asks the Decision API for `{tier: light|standard|hard, mode: headless|tab, reason}`. The input is the brief, ticket text and context-file names and sizes. The guidance is tier and mode purposes written in the imp role file:
- light (`hydrogen` preset): text or doc edits, one or two files, a single test fix, a small bug;
- standard: an ordinary end-to-end slice;
- hard (`astra`): cross-module, concurrency or process lifecycle, repeated conflicts;
- headless: likely one shot with no owner watching;
- tab: likely questions, long runs, or the owner wants to watch.

Apply the choice to the create. Record `route: {tier, mode, reason, source: "decision"|"default"}` in job.json. Show it in the create result and `hud_read`. A land repair of a light job runs as standard. Failure, timeout or the toggle off means the role default in a tab, with `source: "default"`. Overflow to general keeps the chosen mode and uses general's default model.

- [ ] With a stub Decision API: a one-file doc brief routes light+headless; a cross-module brief routes hard+tab; explicit preset skips routing
- [ ] API error or timeout falls back to default+tab and says so
- [ ] A light job's land repair runs one tier up
- [ ] job.json and hud_read carry the route; targeted tests pass

## Comments

- Owner 2026-11-22: once this lands, the main session turns Imp routing on in the owner's own Settings (`~/.hud/hud-settings.json`); the shipped default stays off.
