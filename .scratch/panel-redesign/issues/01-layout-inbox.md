# 01: Layout setting and the Inbox layout

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** `docs/spec.md` §2.2 "Panel layouts" (owner, 2026-11-17). Option 1 · Inbox of
`docs/design/panel-v8/` (`options.html` frames, `notes.md` "Option 1 · Inbox"), built as drawn, selectable beside
today's layout.

- [ ] Settings → Panel → Layout: Classic (default, today's Home and Project unchanged), Inbox, Split (Split shows
      Classic until ticket 02 lands). Saved like the other Settings rows; the panel switches without a restart.
- [ ] Inbox Home as drawn: one list ranked by need (question, failure, stalled, report ready, running), a job is its
      title row plus one sentence row while it runs or when it went wrong, the package as the title's first word
      (dim `PKG ›` prefix when the title does not start with it), the waiting row (busy: a count, Enter lists them;
      idle: all of them), decisions folded to `▸ N as proposed` with departures kept, the compact progress block, and
      the 40 × 24 give-way order from notes.md.
- [ ] Inbox Project as drawn: the hub's `Waiting for you` holds STATE's items and the to-try slices once, `y`/`n`
      work on its rows (same records as PANEL-TRY), Latest lists accepted slices, `In flight`, page rows with marks;
      Progress puts `To try` above `Now`; `t` does nothing in Inbox.
- [ ] Classic is byte-identical to today (existing frame snapshots unchanged).
- [ ] Frame tests for Inbox Home busy/idle/24 rows and the Inbox hub and Progress on synthetic data; snapshots added
      with `npm run snapshots:update`.

## Comments
