# 01: The panel runs as one process and backs off when idle

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 01. Replace the waiting spawn in `src/cli/compat.ts` foreground (used by `src/cli/panel.ts`) with an exec handoff where Node supports `process.execve`; keep spawn and signal forwarding as fallback; terminal restore, exit codes and hot reload (`src/utils/panel-reload.ts`) unchanged. In `src/panel/controller.ts` (~241-249) run the Codex `finder.check()` only when the selected harness is Codex or unset-with-Codex, so a Claude or pi panel neither scans Codex sessions nor pins adaptive poll at 1 s. Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [x] `hud panel --here` leaves one Node process
- [x] A Claude-harness panel does not call finder.check and its poll backs off when idle
- [x] Targeted panel/reload tests pass

## Comments

- Landed c79b5308a4d444c9cc5890544cbc680cd97ca277; gate 5/5 passed.
