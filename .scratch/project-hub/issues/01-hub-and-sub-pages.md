# 01: Project is a hub with one page per section

**What to build:** spec items 1, 4 and 6 with today's data. `MonitorState` gets the open Project page; the hub
renders the summary rows; Progress, Tickets, Working tree, Docs and Control plane become pages that render today's
sections (Progress and Tickets unchanged for now; 03 redoes them). Esc/`‹` returns to the hub; per-page cursor and
scroll survive reload; Home's progress block opens Progress, a Home ticket row opens Tickets. Help and
docs/reference(.zh).md describe the hub.

**Who:** frontend-implementer · **Size:** about 300 source lines, project-page tests and frames updated

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Hub at 40/80/120 columns EN/ZH, unicode and text icons (frames regenerated with `npm run snapshots:update`)
- [ ] Enter opens each page, Esc and the crumb return; Tab/`1`/`2` keep switching Home ⇄ Project
- [ ] Page, cursor and scroll survive a panel reload
- [ ] Home's progress Enter lands on Progress; a ticket row on Tickets
- [ ] Collection still runs only while a Project page is visible
