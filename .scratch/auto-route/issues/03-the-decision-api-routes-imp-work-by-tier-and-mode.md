# 03: The Decision API routes imp work by tier and mode

**Status:** ready-for-agent
**Blocked by:** 01
**Owner try:** no

**What to build:** Spec §2.1.2 "Imp routing" (22.22). Settings toggle "Imp routing" (off by default), which needs the Decision API like Sonic auto-thinking and reuses its client, budget and fallback code. When on, an `imp` create asks the Decision API for `{tier: light|standard|hard, mode: headless|tab, reason}`. The input is the brief, ticket text and context-file names and sizes. The guidance is tier and mode purposes written in the imp role file:
- light (`hydrogen` preset, high): mechanical work that follows an existing pattern — text or doc edits, one or two files, a single test fix, a small bug. Hydrogen high scores 51 against sol high's 55 on the Artificial Analysis index, and it runs on the Gemini quota, so this tier mainly offloads GPT work;
- standard: an ordinary end-to-end slice;
- hard (`astra`; owner 2026-11-22 kept astra for the hard tier): cross-module, concurrency or process lifecycle, repeated conflicts;
- headless: likely one shot with no owner watching;
- tab: likely questions, long runs, or the owner wants to watch.

Apply the choice to the create. Record `route: {tier, mode, reason, source: "decision"|"default"}` in job.json. Show it in the create result and `hud_read`. A land repair of a light job runs as standard. Failure, timeout or the toggle off means the role default in a tab, with `source: "default"`. Overflow to general keeps the chosen mode and uses general's default model.

- [ ] With a stub Decision API: a one-file doc brief routes light+headless; a cross-module brief routes hard+tab
- [ ] API error or timeout falls back to default+tab and says so
- [ ] A light job's land repair runs one tier up
- [ ] job.json and hud_read carry the route; targeted tests pass

## Comments

- Owner 2026-11-22: once this lands, the main session turns Imp routing on in the owner's own Settings (`~/.hud/hud-settings.json`); the shipped default stays off.

- 2026-11-22 capability check (Artificial Analysis): Sol scores 57/56/55/53 at max/xhigh/high/medium, and Hydrogen 54/51/41 at xhigh/high/medium. Per index task, Sol (max) takes 10.2 min and Hydrogen (xhigh) 16.9 min, and Hydrogen emits about 5× the output tokens. Hydrogen is no faster per task than Sol; its gain is a second provider's quota. Never route below high effort. Pilot: Hydrogen landed perf-ts/08 first time (13 min, single file plus tests).

- 2026-11-22: owner ruled that only `general` takes `preset`/`on`/`model`/`thinking` (ticket role-overrides/01), so every `imp` create is routed when the toggle is on; the router applies the tier presets internally.
