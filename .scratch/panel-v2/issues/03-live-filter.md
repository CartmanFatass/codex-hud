# 03: Global live `/` filter across Home, Progress slices and Tickets

**Status:** done (ca767fb1)
**Blocked by:** 02

**What to build:** `docs/spec.md` §2.2 & `.scratch/panel-v2/spec.md` §3. Add instant keyboard filtering (`/`) across Home cards/lanes, Project Progress slices and Project Tickets.

- [x] Filter state & input bar: add `filterOpen?: boolean` and `filterQuery?: string` (scoped per view or cleared on tab/page switch) to `MonitorState` (preserved across panel self-reload). Pressing `/` opens a one-row `/ query▌  N matches` bar right under the header band, capturing typed characters and Backspace (like `model-input.ts`). `Enter` closes typing mode while keeping `filterQuery` active for arrow-key navigation and actions; `Esc` clears `filterQuery` (first `Esc` exits typing if open, or clears active filter before leaving page).
- [x] Filtering rules (pure, case-insensitive substring):
  - **Home** (Classic & Split): matches worker/lane package, title, role, harness, model sentence keywords, or status word (`asking`, `failed`, `working`, `stalled`, `done`). Always preserves visibility ofmatched items even if older when `showAll` is active.
  - **Project Progress**: filters ledger slices and unsliced jobs by slice ID, milestone, text, role or state (`try`, `working`, `blocked`, `accepted`, `todo`).
  - **Project Tickets**: filters tickets across lanes by feature slug, ticket number, title, status or blocker.
- [x] Update footer hints, Help (`?`), EN/ZH labels, and add unit tests covering `/` typing, live match counts, navigation over filtered items and `Esc` clear.

## Comments
