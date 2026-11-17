# 01: Output tokens/s on Claude's statusline and Codex's bar

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Claude's statusline and Codex's tmux bar show the latest response's output tokens per second, as the
pi footer's `tps` band already does (`src/harness/pi/p10k-footer.ts`, `12.3 t/s`). Spec (owner, 2026-11-17): every
status line shows output tokens/s.

- [ ] Claude's statusline shows `N t/s` for the latest assistant response, from data the statusline already reads
      (stdin JSON and a bounded tail of the transcript); nothing new is scanned whole.
- [ ] Codex's bar shows it from the existing output-rate estimate (`outputRate` in `src/snapshot.ts`), marked as an
      estimate (`~N t/s`).
- [ ] No rate known: the field is absent, never `0` or a guess.
- [ ] It is a bar field in every bar theme, drops early on a narrow bar, and keeps the statusline as fast as today.
- [ ] One main-path test per client with a synthetic transcript/rollout.

## Comments
