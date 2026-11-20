# Control tab

Design: `docs/design/control-tab/design.md` (oracle; §1 persistence, §2 fallback rule, §3 interaction, §4 model list, §5 migration).
Template: `docs/design/control-tab/index.html` (settled by the owner 2026-11-20 as drawn; its "To settle" points take the drawn choice).
Spec: `docs/spec.md` §2 "Control tab" sentences.

Shared rules for every ticket:
- 40-column frames exact width, EN and ZH, Split and Classic; frames follow the sample.
- No new timers or polling; discovery only on opening Control or `r`.
- Role files, presets and harness switches are written only by an explicit owner action, atomically, 0600; nothing is rewritten on first open.
- Project-pinned roles are read-only in the panel.
- Synthetic data in tests; temp HOME/HUD_HOME via tmp/env.sh.
