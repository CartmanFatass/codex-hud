# 05: Panel and docs show flows

**Status:** done
**Blocked by:** 01, 04

**What to build:** Work cards of a landing or scouted job show the flow step (gate ▸ merge ▸ push, or scout ▸ run) and the final outcome; docs/reference(.zh).md, packages/hud-mcp/hud-convention.md (mechanics only), docs/delegation.md step 4 and the hud-delegate skill switch to hud_land and scout. Owner 2026-11-22: a sonic report reaching another worker through from_jobs (scout dossiers included) is prefixed with one line in the worker's language of the brief: "Sonic facts: unverified starting points with file:line; its unchecked list is where it did not look; read yourself any code you base a decision on." Scout is for where/what/how-many questions; delegation.md and the skill say why/which/is-it-wrong questions (root cause, design, review) stay with the deciding model.

- [x] A running land shows its current step on the card in zh and en
- [x] A worker given a sonic report via from_jobs sees the unverified-facts line before it
- [x] delegation.md and the skill name hud_land; npm test and check:fixtures pass

## Comments

- Landed 98150a6ef54b41adb5355812da8d6b98c069a2fe; gate 6/6 passed.
