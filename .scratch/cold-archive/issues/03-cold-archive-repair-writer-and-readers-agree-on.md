# 03: Cold archive repair: writer and readers agree on member size; extraction never writes outside --out

**Status:** done
**Live try:** none
**Blocked by:** 01

**What to build:** Repair from milestone review j23ab25bbcd1130a6 (findings 2 and 4) of cold-archive/01. (a) src/roles/cold-archive.ts:183 encodes entries without a size limit, while merge, report lookup and extraction reject decompressed tar payloads above 64 MiB (text) / 512 MiB (raw) (:13-14,161,377,402). A 513 MiB stdout can be archived and its source unlinked, then fail `hud archive extract`; an oversized text member makes a small report read as job_not_found (src/mcp/mcp/operations.ts:393-395,785-791). Make writer and readers agree: preferred is streaming encode/decode with bounded memory so large raw logs archive and extract; at minimum the writer must refuse (and keep the source for the next sweep, surfacing a diagnostic) any member HUD could not later read, measured including tar header/PAX overhead. hud_read report lookup must still find report.md in a text member regardless of other entries' sizes, or the writer must keep text members within the read bound. (b) src/cli/archive.ts:98-106 `--force` lets extraction write into an existing non-empty directory, and the lexical containment check in src/roles/cold-archive.ts:407-410 follows existing intermediate symlinks (e.g. a linked qa/). Drop the `--force` overwrite mode: extract only into a newly created private (0700) directory that must not already exist (or is created empty by HUD), and write entries without following symlinks. Update docs/reference.md usage for hud archive and the help text.

- [x] A raw member just above the old 512 MiB bound (and a text member just above 64 MiB), including tar overhead, either archives and round-trips byte-identically through hud archive extract, or is refused before the source is deleted with the source kept; both sides of the boundary are tested (tests may lower the bound via an internal knob to keep runtime small).
- [x] hud_read job=<pruned job> returns the report when the text member also holds a large non-report entry, or the writer keeps such members readable (test).
- [x] hud archive extract has no --force; extracting into an existing non-empty directory fails; an extraction where the target tree contains a symlinked intermediate directory never writes outside --out (test).
- [x] docs/reference.md and the CLI help describe the final hud archive extract options.

## Comments

- Landed in this commit (replay base 94ffc7fa194a998e0a78ab15e79493a067f14ccd); gate 5/5 passed.
