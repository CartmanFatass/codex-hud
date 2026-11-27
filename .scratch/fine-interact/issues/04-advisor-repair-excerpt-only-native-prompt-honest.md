# 04: Advisor repair: excerpt-only native prompt, honest launch failure, no eviction of outstanding advisors

**Status:** done
**Live try:** Select text in a pane of a checkout whose .pi/APPEND_SYSTEM.md holds a sentinel, press Ctrl+b a, choose "Ask an advisor": the advisor answers about the excerpt and neither the sentinel nor the checkout path reaches it; force a launch failure (e.g. role pointed at a CLI that refuses the cwd): the composer keeps the draft and shows the failure.
**Blocked by:** none
**Objective:** interaction

**What to build:** Milestone review jd24d8862257fc92b findings 1, 6, 7 on fine-interact/01 (see ~/.hud/jobs/jd24d8862257fc92b/report.md). 1 (blocker, spec): `src/roles/selection-advisor.ts:26-34` launches the advisor with cwd = source project root; `pi-worker-argv.ts:75-77` disables context files, skills and tools but pi's native system prompt still loads a trusted checkout's `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` (resource-loader) and states the cwd in the system message (system-prompt). That breaks the excerpt-only brief and Architecture §5's no-checkout-path promise. Isolate the native prompt on the initial AND resumed turns (e.g. a private empty advisor cwd under $HUD_HOME with a bound, or an explicit system-prompt override — pick the simplest that holds for resume) while the excerpt source is still recorded on the card. 6 (major): `orchestrator.ts:110-125,937-939,964-970` can return a failed launch row with both `ok: false` and `job`; `selection-advisor.ts:35` checks only `job`, and `src/cli/select-send.ts:342-346` then clears the question and switches to an unavailable advisor. Check the dispatch outcome before switching views; keep the editable draft and show the launch failure. 7 (major): `selection-excerpts.ts:123-137` protects pending notes but advisor cards are created `queued` and are evictable from the 64-card store, losing the hidden advisor's answer slot, reopen and /end. Keep the bound but never evict a card whose advisor turn is outstanding (job not settled); settled advisor history may still expire.

- [x] Test: assembled provider input (system + user) for a new and a resumed advisor turn, with a synthetic checkout path and a sentinel in .pi/APPEND_SYSTEM.md, contains neither the sentinel nor the checkout path
- [x] Test: a dispatch result with ok:false and a job keeps the composer draft, shows the failure and does not switch to the advisor view
- [x] Test: filling the store with newer selections does not evict a card whose advisor turn is outstanding; settled advisor cards remain evictable
- [x] Architecture §5 / reference.md state what the advisor receives

## Comments

- Landed in this commit (replay base d3b0dc840f3b94efb00dfd63df567384865beb85); gate 5/5 passed.
