# 03: The Decision API routes imp work by tier and mode

**Status:** done
**Blocked by:** 01
**Owner try:** no

**What to build:** Spec §2.1.4 "Imp routing" (22.22). Settings toggle "Imp routing" (off by default), which needs the Decision API like Sonic auto-thinking and reuses its client, budget and fallback code.

Tiers live in the role file, not in code. Add an optional `routing` block to the role-file schema:

```json
"routing": {
  "light":    { "preset": "hydrogen", "use": "mechanical work on an existing pattern: text or doc edits, one or two files, a single test fix, a small bug" },
  "standard": { "use": "an ordinary end-to-end slice" },
  "hard":     { "preset": "astra", "use": "cross-module, concurrency or process lifecycle, repeated conflicts" },
  "modes": { "headless": "likely one shot with no owner watching", "tab": "likely questions, long runs, or the owner wants to watch" }
}
```

`standard` has no preset: it is the role's active preset (the owner's Control choice). Ship this block in the shipped `imp` role file; adding it to the owner's `~/.hud/roles/imp.json` is the main session's job, not yours. A tier missing from the block is not offered to the Decision API; a role file without the block is never routed. Do not hard-code tier presets or models anywhere in src/.

When on, an `imp` create asks the Decision API for `{tier, mode, reason}`. The input is the brief, ticket text, context-file names and sizes, and the block's `use` texts. Then:
- Run the tier's preset chain. If none of its places is available (harness off, quota exhausted, pre-input launch failure), fall to standard and record `fallback`.
- Headless only when the chosen place's harness supports headless today (pi after 01; claude and agy after 02); otherwise tab, recorded as `mode_reason`.
- Overflow to `general` runs the routed chain (see role-overrides/01 for the unrouted case).
- `retry_of` keeps the tier without a new decision; a land repair of a light job runs as standard.
- Failure, timeout or the toggle off: active preset in a tab, `source: "default"`.

Record `route: {tier, mode, reason, source: "decision"|"default", fallback?}` in job.json. Show it in the create result and `hud_read`. Document the block in docs/reference.md and docs/reference.zh.md.

- [x] With a stub Decision API: a one-file doc brief routes light+headless (tab while agy lacks headless); a cross-module brief routes hard+tab
- [x] A role file without `routing`, or missing the `light` tier, never yields that tier
- [x] Unavailable tier preset falls to standard with `fallback`; API error or timeout falls back to default+tab and says so
- [x] Overflow keeps the routed chain; retry keeps the tier; a light job's land repair runs standard
- [x] job.json and hud_read carry the route; targeted tests pass

## Comments

- Owner 2026-11-22: once this lands, the main session turns Imp routing on in the owner's own Settings (`~/.hud/hud-settings.json`); the shipped default stays off.

- 2026-11-22 capability check (Artificial Analysis): Sol scores 57/56/55/53 at max/xhigh/high/medium, and Hydrogen 54/51/41 at xhigh/high/medium. Per index task, Sol (max) takes 10.2 min and Hydrogen (xhigh) 16.9 min, and Hydrogen emits about 5× the output tokens. Hydrogen is no faster per task than Sol; its gain is a second provider's quota. Never route below high effort. Pilot: Hydrogen landed perf-ts/08 first time (13 min, single file plus tests).

- 2026-11-22: owner ruled that only `general` takes `preset`/`on`/`model`/`thinking` (ticket role-overrides/01), so every `imp` create is routed when the toggle is on; the router applies the tier presets internally.
- 2026-11-22 compatibility pass: tiers moved from code to the role file's `routing` block; standard follows the owner's active preset; headless follows harness support; unavailable tier falls to standard; overflow keeps the routed chain.
- 2026-11-22 answer to q1: the Decision API returns enumerated choices only, so the one-line reason is the chosen tier's and mode's `use` texts from the role file (no second call). An explicit `mode` on create always wins; routing then picks only the tier. Without an explicit mode, every fallback runs in a tab.

- Landed fc2f5dd40cf251397117eee4d0ec59b2be6a8fd2; gate 5/5 passed.
