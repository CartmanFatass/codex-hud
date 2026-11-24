# 02: Design previews open in the owner's browser on report

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Owner 2026-11-24 accepted: the main session copied a design sample to `tmp/preview/` and opened it with `explorer.exe` six times in one day (`docs/delegation.md` Design samples paragraph). Make it HUD's job. `hud_create` takes an optional `preview: "<path relative to cwd>"` (an HTML file the job will write). When the job's report is declared, HUD copies that file to `<project root>/tmp/preview/<job>/<basename>` (so it survives a worktree landing) and, when the owner's setting `openPreviews` is on (default on), opens it in the default browser: on WSL `explorer.exe "$(wslpath -w <copy>)"`, otherwise `xdg-open`; a failure to open is noted in the notice, never fatal. The report-ready notice and `hud_read` digest name the copy's path. A worker may also name the preview in its report (`preview:` meta) when the brief did not. A repair or resumed job that rewrites the file opens the new copy once. No preview for a missing file (say so in the notice). Update `docs/delegation.md` (the orchestrator no longer copies and opens samples by hand) and `docs/reference.md`; add the setting to Settings with its i18n. Budget about 100 source lines and 3 tests (copy + open command built for WSL and non-WSL with an injected opener; setting off copies but does not open; missing file noted).

- [x] Test: a job created with `preview` copies the file to `tmp/preview/<job>/` on report and calls the opener once with the WSL path; with the setting off it copies without opening
- [x] Test: a missing preview file is named in the notice and nothing is opened
- [x] The land gate passes

## Comments

- Landed in this commit (replay base 5aa6de0fddd9fba08d514521cc3efd2fc5135d0e); gate 5/5 passed.
