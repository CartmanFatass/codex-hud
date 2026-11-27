# 09: Repair ticket-store/04: land hud tickets migrate and JSON sync mirrors on top of the JSON readers

**Status:** done
**Live try:** none
**Blocked by:** 07
**Repairs:** ticket-store/04
**Objective:** ticket-store

**What to build:** ticket-store/04 (job jf3e530677c655e15, commit 0dc26220 "Add hud tickets migrate with round-trip verification and JSON sync mirrors") failed its assumption check only because no reader on main read the JSON yet. ticket-store/03 and /06 have now landed, so readers check `.hud/tickets/<slug>.json` first and fall back to Markdown per feature. Start from 0dc26220, rebase it onto current main after ticket-store/07 (single schema), and use that one schema/serializer instead of any copy. Keep everything ticket-store/04 asks for (lossless `hud tickets migrate [--cwd] [--delete-legacy]` with round-trip verification; `hud tickets sync` writing `.hud/tickets/<slug>.json` with a `mirror` block plus git-ignore, existing mutual-exclusion guards). Add a test that a GitHub-mirrored feature written by `sync` still shows up in the collector, `hud board` and `hud_tickets ready`. Do not run migrate on MyHUD (that is ticket-store/05). Keep the 64 KiB cap; report features over it (herdr-fork) rather than raising it.

- [x] Migrating a fixture tree covering every header and section variant yields JSON whose facts equal the parsed Markdown
- [x] --delete-legacy refuses and deletes nothing when any ticket fails the round trip
- [x] Test: a feature mirrored by `hud tickets sync` (JSON with mirror block) is listed by the collector, hud board and hud_tickets ready

## Comments

- Landed in this commit (replay base d5891a97b868936e6dd83e701b3bc901c95bc610); gate 5/5 passed.
