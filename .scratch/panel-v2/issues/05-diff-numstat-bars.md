# 05: Bounded safe Git --numstat diff bars in Inspector, Working tree and To-try previews

**Status:** done (ec1fa8bd)
**Blocked by:** none

**What to build:** `docs/spec.md` §2.2 & `.scratch/panel-v2/spec.md` §5. Show fast, safe per-file `--numstat` diff summaries with proportional `+ / -` bars when reviewing To-try slices, inspecting a job's worktree/commits, or viewing Working tree changes.

- [x] Safe diff-stat reader (`src/collectors/diff-stat.ts`): built strictly on `src/utils/git-safety.ts` (read-only, `-c core.fsmonitor=false`, no filters/hooks/fetch, 5 s signature/time cache, max 12 files + `+N more files` summary). Supports:
  - Working tree dirty diff (`git diff HEAD --numstat`) for `ProjectCollector`'s `tree` page;
  - Commit/range diff (`git show --numstat --format=` across the 1–5 commit hashes named on a `try` ledger slice);
  - Job diff (`BASE..HEAD` plus working tree in `job.worktree.root` or `SESSION.txt` `BASE` when available) for Inspector.
- [x] Pure renderer helper (`src/render/diff-stat-rows.ts`): fits at 40+ columns—path squeezed cleanly on the left, `+A -D` and a 5-cell green/red proportional block bar (`███░░` / `+++--`) on the right. Each file row carries `files: [absPath]` so `Enter` / `o` opens the file in `$EDITOR` tab.
- [x] Wire diff rows into: (a) Working tree page (Classic & Split preview), (b) To-try slice expanded/Split preview under acceptance steps, and (c) Inspector (`work-inspector.ts`) for HUD jobs with diff data.
- [x] Add unit tests with a synthetic temporary git repo verifying safe `--numstat` parsing, binary file handling (`- -`), 40-column exact-width formatting, and `o` file targets.

## Comments
