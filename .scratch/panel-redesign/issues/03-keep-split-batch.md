# 03: Keep Split, delete Inbox; mark several rows, one try record

**Status:** ready-for-agent
**Blocked by:** none (in parallel with 04; see Comments)

**What to build:** `docs/spec.md` §2.2 (owner, 2026-11-18): the owner kept Split; Inbox is deleted, Classic stays the
default. The owner can mark several to-try rows and record them with one `y`/`n`, so the main session hears one line.

- [ ] Delete Inbox: `src/render/inbox-*.ts`, its branches in work-view.ts, project-view.ts and workboard-input.ts, its
      tests and fixtures (`inbox-layout`, `inbox-live`, `tests/fixtures/inbox*`), its snapshot writer, its i18n
      strings, its docs (reference.md, reference.zh.md "Panel layouts", ARCHITECTURE §6). The setting keeps
      `classic | split`; a saved `inbox` value reads as `classic`. Settings help names only Classic and Split. Exports
      Split still imports stay; drop the `export` keyword where only Inbox used it.
- [ ] Mark several: on Classic's Progress to-try view and on Split's To try rows (hub preview and Progress page), Space
      toggles a mark on the cursor row (a visible mark glyph); `y`/`n` with marks present records all marked slices as
      one record in `$HUD_HOME/tries.jsonl` (`slices: [...]`) and clears the marks; with no marks `y`/`n` act on the
      cursor row as today. Leaving the view clears the marks. Help and the footer name Space.
- [ ] `hud watch` and MCP `changes` print one line per record (check it already joins several slices; fix if not).
- [ ] Tests: one frame test that Split and Classic are unchanged by the deletion apart from the Settings row; one that
      Space-mark-mark-`y` writes one record with both slices and one watch line.

## Comments

- Main session, 2026-11-18: runs in parallel with 04. Seam: 03 owns key handling (workboard-input.ts, split-input.ts),
  the marks state and glyph, and the Inbox deletion; 04 owns the text of to-try and waiting rows and the preview
  content. The main session merges both.
