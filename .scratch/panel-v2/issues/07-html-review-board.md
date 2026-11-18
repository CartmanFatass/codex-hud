# 07: On-demand self-contained static HTML review board (hud board & panel w key)

**Status:** claimed
**Blocked by:** 05

**What to build:** `docs/spec.md` §2.2 & `.scratch/panel-v2/spec.md` §7. Export a rich, zero-server, single-file static HTML board for reviewing project progress, To-try slices (briefs, steps, linked tickets, diff bars), active jobs and milestone reviews in a browser.

- [ ] Pure HTML generator (`src/render/html-board.ts`): takes `ProjectSnapshot`, `WorkboardSnapshot`, diff stats and newest review markdown, producing one self-contained HTML5 document (`<!doctype html>`):
  - Strictly escape all untrusted/external text (`& < > " '`), zero external fonts/scripts/stylesheets/fetches (`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`);
  - Responsive CSS (works from phone width up to wide desktop) with automatic `prefers-color-scheme` + a pure-CSS light/dark toggle (matching `docs/design/panel-v8/` craft);
  - Sections: Header (project, branch, milestone stacked bar & counts), Waiting for Owner & Open Job Questions, To-Try Review Queue (cards with model brief, numbered acceptance steps, linked `.scratch/` ticket checklists, and `--numstat` diff bars), Active Workers, and Latest Milestone Review.
- [ ] CLI command `hud board [--html] [--cwd DIR] [--out FILE] [--open]` in `src/cli/`: collects a one-shot snapshot, writes atomically (`0600` under `$HUD_HOME/display/board-<slug>.html` by default, or `--out`), prints the path, and when `--open` is passed tries `wslview` then `xdg-open` detached (non-fatal notice if neither exists).
- [ ] Panel shortcut `w`: exports the shown project's HTML board, opens it (or shows the saved path in a brief notice banner), and adds `w` to Help (`?`) and EN/ZH i18n.
- [ ] Add unit tests verifying CLI execution, CSP/HTML escaping against XSS payloads, zero external URLs, and To-try slice rendering.

## Comments
