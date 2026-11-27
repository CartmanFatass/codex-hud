# 04: hud tickets migrate converts Markdown tickets losslessly; sync writes JSON mirrors

**Status:** wontfix
**Owner try:** no
**Live try:** none
**Blocked by:** 06
**Objective:** ticket-store

**What to build:** Design: docs/design/ticket-store/README.md §1, §5. Build `hud tickets migrate [--cwd <dir>] [--delete-legacy]`: convert every `.scratch/*/issues/*.md` variant in use (header lines, `resolved` → done, normalised blockers, checkbox acceptance, flake-list cases, Landed and unattended-acceptance lines, comments, Objective links) into `.hud/tickets/<feature>.json`, keep `.scratch/<feature>/spec.md` and prose notes, and verify a round trip (re-render and compare facts) before `--delete-legacy` deletes anything; refuse on any mismatch and list it. Update `hud tickets sync` to write `.hud/tickets/<slug>.json` with a `mirror` block and a git-ignore for mirror files, keeping today's mutual-exclusion guards.

- [ ] Migrating a fixture tree covering every header and section variant yields JSON whose facts equal the parsed Markdown
- [ ] --delete-legacy refuses and deletes nothing when any ticket fails the round trip
- [ ] Without --delete-legacy no Markdown is removed; running migrate twice is a no-op
- [ ] sync writes a JSON mirror and still refuses to overwrite local tickets or edit a mirror locally

## Comments

- Main 2026-11-27: superseded by ticket-store/09 (repair carrying this slice); ticket-store/05 now waits on 07, 08 and 09.
