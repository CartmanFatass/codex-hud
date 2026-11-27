# 02: Ticket landings fold into the landed commit; hud_tickets commit for the rest

**Status:** done
**Owner try:** no
**Live try:** Land a scratch ticket stored in JSON while another hud_tickets edit is made during its gate; git log shows one landed commit carrying both ticket changes and no separate tickets: commit.
**Blocked by:** 06
**Objective:** ticket-store

**What to build:** Design: docs/design/ticket-store/README.md §3. Move `recordLanding` from the integration worktree to right after `git merge --ff-only` in main, under the tickets lock: write `landing`, `status` (done, or ready-for-human with owner_try) and ticked acceptance into the newest main-checkout JSON, then `commit --amend --no-edit --only` the swept files (only those whose hash matches `ticket-writes.json`; never hand edits), and push the amended head. Add `.hud/tickets/*.json` and `.hud/objectives.md` to `isMetadataPath`. Reject worker diffs touching `.hud/tickets/**` in prepare/train. Move unattended acceptance (`accepted` receipt, non-blocking commit attempt at run end) and gate flakes (`kind: flake-list`, `cases[]`, promotion rule unchanged) to the store. Add `hud_tickets({op: "commit"})` and `hud tickets commit`. Remove `src/mcp/ticket-commits.ts` and the queued-receipt path from mcp-latency/02 once nothing uses them.

- [x] A land of a JSON-tracked ticket produces one landed commit containing the ticket's landing record; no separate tickets commit
- [x] A dirty HUD-written ticket file in main never fails checkClean, ff-only or the gate; an owner hand edit to a ticket file is never swept into a commit
- [x] A replay onto a ticket-amended head skips the gate as metadata-only
- [x] Unattended acceptance and gate flake collection write the JSON store
- [x] `hud_tickets commit` commits only HUD-written ticket files and leaves other staged and unstaged changes alone
- [x] ticket-commits.ts and the receipt queue are gone with their tests replaced

## Comments

- Landed in this commit (replay base 684331e2c71bd3af97ecb48be4e21fa9e51b6cfa); gate 5/5 passed.
