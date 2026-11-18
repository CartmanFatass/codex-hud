# 05: Zero-copy context assembly in hud_create (context_files and from_jobs)

**Status:** done (696d361b)
**Blocked by:** 03

**What to build:** `docs/spec.md` §2.1 & `.scratch/mcp-next/spec.md` §5. Let `hud_create` attach local files and upstream job reports directly into worker briefs without round-tripping large bodies through the main session's LLM output.

- [x] Add optional `context_files?: string[]` (max 32 paths, resolved against `cwd`) and `from_jobs?: string[]` (max 16 HUD job ids `j[0-9a-f]{16}`, resolving each `<job>/report.md`) to `hud_create` in `thin-main.ts` and `PI_ROLE_TOOLS`.
- [x] Validate every referenced path before dispatch: reject missing files, directories, NUL bytes, binary content, or symlinks/paths escaping outside `cwd` (for `context_files`) and `$HUD_HOME/jobs` (for `from_jobs`) with `code: 'invalid_arguments'`.
- [x] For `pi` and `cli` places, prepend a structured `## Context References` markdown block to `brief.md` naming each file and upstream job report path so the worker reads them directly; record `context_files` and `from_jobs` in `job.json`.
- [x] For `bro` (browser) places, read and inline the referenced files directly into `brief.md` under fenced sections (capped at 64 KiB per file and 256 KiB total, returning `code: 'context_too_large'` if exceeded).
- [x] Add unit tests for local reference headers, browser inline splicing, size caps and path-escape rejections.

## Comments

- Orchestrator 2026-11-18: the pi/cli reference block sits right after the task, not at the top (docs/spec.md §2.1 names no place): the panel title, sentence goal and decision labels read the brief's opening lines.
