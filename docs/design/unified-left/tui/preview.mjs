#!/usr/bin/env node
// Terminal preview of the three sidebar-integration variants for the unified left panel. The frames are copied cell for
// cell from the design exploration; all data is synthetic. Needs a built `dist/`. Colour is decoration only.
// herdr's own chrome wears herdr's rose-pine inks, what HUD adds wears the panel's configured theme.
// Usage: node docs/design/unified-left/tui/preview.mjs   (1 2 3 or a b c · ← → or h l · i · q)
import { theme, truncateAnsi, visualLength } from '../../../../dist/render/colors.js';
import { displayConfig } from '../../../../dist/render/hud-config.js';
import { applyDisplaySettings, runtimeSettings } from '../../../../dist/settings-runtime.js';

const FRAMES = {
  // Expanded (100 × 24: 28c sidebar + 72c terminal)
  A1: [
    ' ?1 harbor-api · waits  14m│  claude    tests   +                                          2 hidden ',
    ' Keep push as the default? │ > how is the dock-ux queue doing?                                      ',
    ' Home  Proj  Exec·2  Ctrl  │                                                                        ',
    '───────────────────────────│ ● 01 landed. 02 failed at the gate.                                    ',
    ' spaces              +3 prj│ ● 03 asks whether push stays default.                                  ',
    ' × harbor-api      main ↑1▸│   Waiting for your answer.                                             ',
    '   dock-ux [✓×?]╌○╌○    47m│                                                                        ',
    ' ◐ lantern-ui         main │ ● lantern-ui runs audit in space 2.                                    ',
    '   ◐◈ audit             12m│                                                                        ',
    ' ○ scratch             dev │                                                                        ',
    ' new                   menu│                                                                        ',
    '───────────────────────────│                                                                        ',
    ' agents             grouped│                                                                        ',
    ' ▾ harbor-api             3│                                                                        ',
    ' ├ ○ harbor-api            │                                                                        ',
    ' │   claude                │                                                                        ',
    ' └─▸ dock-ux        ×⚒ ?⚒ 2│                                                                        ',
    ' ▾ lantern-ui             2│                                                                        ',
    ' ├ ◐ lantern-ui            │                                                                        ',
    ' │   codex                 │                                                                        ',
    ' └ ✓⚖ lantern-ui           │────────────────────────────────────────────────────────────────────────',
    '     bench-check           │ > █                                                                    ',
    ' ▸ scratch              ○ 1│────────────────────────────────────────────────────────────────────────',
    '                          «│ harbor-api main ↑1 · ctx 42% · ?1 · ⚒2 ◈1 · WSL C14% M29%              ',
  ],
  // Deep HUD page open — Execution (100 × 24: 13c live rail + 41c blade + 46c terminal)
  A2: [
    ' ?1 for you │  claude    tests   +                                                         2 hidden ',
    '┈┈┈┈┈┈┈┈┈┈┈┈│ Home ?1   Project  [Execution·2]  Ctrl « > how is the dock-ux queue doing?            ',
    '1 harbor-api│ harbor-api · 2 lantern-ui          [ ] │                                              ',
    ' ╭───┬───╮  │ ? dock-ux/03 waits                 14m │ ● 01 landed. 02 failed at the gate.          ',
    ' ✓01 ×02 ?03│   Keep push as the default?            │ ● 03 asks whether push stays default.        ',
    ' ├╌╌╌┴╌╌╌╯  │ Workflow ──────────────────────────── 1│   Waiting for your answer.                   ',
    ' ○ review   │  ◐ Queue dock-ux            running 47m│                                              ',
    ' ○ accept   │  ✓─────╮                               │ ● lantern-ui runs audit in space 2.          ',
    '2 lantern-ui│ >×╌╌╌╌╌┼╌◇╌╌╌╌╌╌╌☆                     │                                              ',
    ' ◐◈ audit   │  ?╌╌╌╌╌╯                               │                                              ',
    '3 ○ scratch │  × 02 push dock             ⚒ failed 6m│                                              ',
    ' +3 projects│    gate: cargo test dock_push_width    │                                              ',
    '────────────│                                        │                                              ',
    ' ○ claude   │ Workers ───────────────────────────── 2│                                              ',
    ' ▸ ×⚒ ?⚒ 2  │┌─ ×⚒ imp · sonnet ──────── failed 6m ─┐│                                              ',
    '────────────││ dock-ux/02 · remain tab [g peek]     ││                                              ',
    ' ◐ codex    │└─ launch_8f2a ───────────── j02bbbbb ─┘│                                              ',
    ' ✓⚖ check   │┌─ ?⚒ imp · opus ───────── asking 14m ─┐│                                              ',
    '────────────││ dock-ux/03 · Keep push as default?   ││                                              ',
    ' ○ pi       │└─ from claude ───────────── j03ccccc ─┘│                                              ',
    '            │                                        │──────────────────────────────────────────────',
    '            │ Recently ended (24h)             3 jobs│ > █                                          ',
    '            │  ✓⚖ bench-check · lantern-ui         9m│──────────────────────────────────────────────',
    '          » │ ⏎ inspect  g tab  r retry  q hide    ? │ harbor-api main ↑1 · ctx 42% · ?1 · ⚒2 ◈1    ',
  ],
  // Collapsed (100 × 24: fixed 13c rail + 87c terminal; stays 13c when calm — zero reflow)
  A3: [
    ' ?1 for you │  claude    tests   +                                                         2 hidden ',
    '┈┈┈┈┈┈┈┈┈┈┈┈│ > how is the dock-ux queue doing?                                                     ',
    '1 harbor-api│                                                                                       ',
    ' ╭───┬───╮  │ ● 01 landed. 02 failed at the gate.                                                   ',
    ' ✓01 ×02 ?03│ ● 03 asks whether push stays default.                                                 ',
    ' ├╌╌╌┴╌╌╌╯  │   Waiting for your answer.                                                            ',
    ' ○ review   │                                                                                       ',
    ' ○ accept   │ ● lantern-ui runs audit in space 2.                                                   ',
    '2 lantern-ui│                                                                                       ',
    ' ◐◈ audit   │                                                                                       ',
    '3 ○ scratch │                                                                                       ',
    ' +3 projects│                                                                                       ',
    '────────────│                                                                                       ',
    ' ○ claude   │                                                                                       ',
    ' ▸ ×⚒ ?⚒ 2  │                                                                                       ',
    '────────────│                                                                                       ',
    ' ◐ codex    │                                                                                       ',
    ' ✓⚖ check   │                                                                                       ',
    '────────────│                                                                                       ',
    ' ○ pi       │                                                                                       ',
    '            │───────────────────────────────────────────────────────────────────────────────────────',
    '            │ > █                                                                                   ',
    '            │───────────────────────────────────────────────────────────────────────────────────────',
    '          » │ harbor-api main ↑1 · ctx 42% · ?1 · ⚒2 ◈1 · WSL C14% M29%                             ',
  ],
  // Narrow (60 × 14: 2-row header with ?1 « + counts + run strips; opens zoomed)
  A4: [
    ' × harbor-api  tab claude · 1/2 · 2 hidden  ?1 «  │        ×',
    ' ×1 ◐2 ✓1 ○2 │ harbor [✓×?]╌○╌○  lantern ◐◈       │  switch ',
    ' > how is the dock-ux queue doing?                          ',
    '                                                            ',
    ' ● 01 landed. 02 failed at the gate.                        ',
    ' ● 03 asks whether push stays default.                      ',
    '   Waiting for your answer.                                 ',
    '                                                            ',
    ' ● lantern-ui runs audit in space 2.                        ',
    '                                                            ',
    '────────────────────────────────────────────────────────────',
    ' > █                                                        ',
    '────────────────────────────────────────────────────────────',
    ' harbor-api main ↑1 · ctx 42% · ?1 · ⚒2 ◈1 · WSL C14% M29%  ',
  ],
  // Expanded (100 × 24: 28c split-deck column + 72c terminal)
  B1: [
    ' spaces                    │  claude    tests   +                                          2 hidden ',
    ' × harbor-api      main ↑1▸│ > how is the dock-ux queue doing?                                      ',
    ' ◐ lantern-ui         main │                                                                        ',
    ' ○ scratch             dev │ ● 01 landed. 02 failed at the gate.                                    ',
    ' new                   menu│ ● 03 asks whether push stays default.                                  ',
    '───────────────────────────│   Waiting for your answer.                                             ',
    ' agents             grouped│                                                                        ',
    ' ▾ harbor-api            3░│ ● lantern-ui runs audit in space 2.                                    ',
    ' ├ ○ harbor-api · claude  ▐│                                                                        ',
    ' └─▸ dock-ux       ×⚒ ?⚒ 2░│                                                                        ',
    ' ▾ lantern-ui            2░│                                                                        ',
    ' ├ ◐ lantern-ui · codex   ░│                                                                        ',
    '═══ HUD ══════════════════▾│                                                                        ',
    ' [Home ?1] Proj Exec·2 Ctrl│                                                                        ',
    ' ?1 harbor-api · waits  14m│                                                                        ',
    ' Keep push as the default? │                                                                        ',
    ' #1 dock-ux         run 47m│                                                                        ',
    '  ╭───┬───╮                │                                                                        ',
    '  ✓01 ×02 ?03              │                                                                        ',
    '  ╰╌╌╌┴╌╌╌╯╌ ○rev ╌ ○acc   │                                                                        ',
    ' #2 ◐◈ audit        run 12m│────────────────────────────────────────────────────────────────────────',
    ' +3 other projects   a open│ > █                                                                    ',
    ' Today: ✓5 ⚒ · Sched: 1 due│────────────────────────────────────────────────────────────────────────',
    ' ⏎ open  ↕ deck           «│ harbor-api main ↑1 · ctx 42% · ?1 · ⚒2 ◈1 · WSL C14% M29%              ',
  ],
  // Deep HUD page open — Project › Tickets (100 × 24: 41c column [8r nav + 15r HUD] + 59c terminal)
  B2: [
    ' spaces                                 │  claude    tests   +                             2 hidden ',
    ' × harbor-api         main ↑1         ▸░│ > how is the dock-ux queue doing?                         ',
    ' ◐ lantern-ui         main             ▐│                                                           ',
    ' new                                menu│ ● 01 landed. 02 failed at the gate.                       ',
    '────────────────────────────────────────│ ● 03 asks whether push stays default.                     ',
    ' agents                          grouped│   Waiting for your answer.                                ',
    ' ├ ○ harbor-api · claude               ▐│                                                           ',
    ' └─▸ dock-ux (×⚒ ?⚒)                  2░│ ● lantern-ui runs audit in space 2.                       ',
    '═══ HUD ═══════════════════════════════▾│                                                           ',
    ' Home ?1  [Project]  Execution·2   Ctrl │                                                           ',
    ' harbor-api › Tickets        2 features │                                                           ',
    ' ? dock-ux/03 waits  Keep push default? │                                                           ',
    ' ━━━━━━────────── 3/7 done · dx 1/5     │                                                           ',
    ' For you ───────────────────────────── 1│                                                           ',
    '  ? dx 03 Dock mode default    waits 1/3│                                                           ',
    ' Working / Stalled ─────────────────── 2│                                                           ',
    '  × dx 02 Push dock width     ⚒ fail 2/4│                                                           ',
    '  ◐ au 01 Audit cache keys     ◈ 12m 0/2│                                                           ',
    ' to try ────────────────────────────── 1│                                                           ',
    '  ◇ dx 01 Left dock geometry         4/4│                                                           ',
    ' ▸ Queued (2) · ▸ Done (2)        f fold│───────────────────────────────────────────────────────────',
    ' Accept all                     1 to try│ > █                                                       ',
    '                                        │───────────────────────────────────────────────────────────',
    ' ⏎ checklist  o file  a accept  q min  «│ harbor-api main ↑1 · ctx 42% · ?1 · ⚒2 ◈1 · WSL C14% M29% ',
  ],
  // Collapsed (100 × 24: fixed 13c split rail [9r native + 14r HUD PTY] + 87c terminal)
  B3: [
    '1 × harbor  │  claude    tests   +                                                         2 hidden ',
    '2 ◐ lantern │ > how is the dock-ux queue doing?                                                     ',
    '3 ○ scratch │                                                                                       ',
    '────────────│ ● 01 landed. 02 failed at the gate.                                                   ',
    ' ○ claude   │ ● 03 asks whether push stays default.                                                 ',
    ' ▸ ×⚒ ?⚒ 2  │   Waiting for your answer.                                                            ',
    ' ◐ codex    │                                                                                       ',
    ' ✓⚖ check   │ ● lantern-ui runs audit in space 2.                                                   ',
    ' ○ pi       │                                                                                       ',
    '═══ HUD ════│                                                                                       ',
    ' ?1 for you │                                                                                       ',
    '┈┈┈┈┈┈┈┈┈┈┈┈│                                                                                       ',
    ' #1 dock-ux │                                                                                       ',
    ' ╭───┬───╮  │                                                                                       ',
    ' ✓01 ×02 ?03│                                                                                       ',
    ' ├╌╌╌┴╌╌╌╯  │                                                                                       ',
    ' ○ review   │                                                                                       ',
    ' ○ accept   │                                                                                       ',
    '┈┈┈┈┈┈┈┈┈┈┈┈│                                                                                       ',
    ' #2 lantern │                                                                                       ',
    ' ◐◈ audit   │───────────────────────────────────────────────────────────────────────────────────────',
    ' +3 projects│ > █                                                                                   ',
    '            │───────────────────────────────────────────────────────────────────────────────────────',
    '          » │ harbor-api main ↑1 · ctx 42% · ?1 · ⚒2 ◈1 · WSL C14% M29%                             ',
  ],
  // Narrow (60 × 14: zoomed split-deck overlay open)
  B4: [
    ' × harbor-api  tab claude · 1/2 · 2 hidden  ?1 »  │        ×',
    ' ×1 ◐2 ✓1 ○2 │ harbor [✓×?]╌○╌○  lantern ◐◈       │  close  ',
    ' spaces: [1 × harbor-api ↑1]  2 ◐ lantern-ui  3 ○ scratch  +',
    ' agents: ○ claude  ▸ dock-ux (×⚒ ?⚒)  ◐ codex  ✓⚖ check menu',
    '═══ HUD ═══════════════════════════════════════════════════▾',
    ' [Home ?1]   Project   Execution·2   Control                ',
    ' ?1 harbor-api › dock-ux                     work waits 14m ',
    '   Keep push as the default dock mode?                      ',
    ' × harbor-api ── ▸ dock-ux (+1) [✓01 ×02 ?03]╌○╌○       47m ',
    ' ◐ lantern-ui ── ▸ perf-audit   ◐◈ audit                12m ',
    ' ▸ 3 other projects · Today ✓5 ⚒ · Schedule 1 due  a expand ',
    '                                                            ',
    '                                                            ',
    '                           ⏎ open  q return to pane  ? help ',
  ],
  // Expanded (100 × 24: 28c run-tree sidebar + 72c terminal)
  C1: [
    ' ?1 harbor-api · waits  14m│  claude    tests   +                                          2 hidden ',
    ' Keep push as the default? │ > how is the dock-ux queue doing?                                      ',
    ' ◆ Home  Proj  Exec·2  Ctrl│                                                                        ',
    '───────────────────────────│ ● 01 landed. 02 failed at the gate.                                    ',
    ' spaces              +3 prj│ ● 03 asks whether push stays default.                                  ',
    ' × harbor-api      main ↑1▸│   Waiting for your answer.                                             ',
    ' ◐ lantern-ui         main │                                                                        ',
    ' ○ scratch             dev │ ● lantern-ui runs audit in space 2.                                    ',
    ' new                   menu│                                                                        ',
    '───────────────────────────│                                                                        ',
    ' agents             grouped│                                                                        ',
    ' ▾ harbor-api             3│                                                                        ',
    ' ├ ○ claude                │                                                                        ',
    ' └─▾ run dock-ux        47m│                                                                        ',
    '   ╭────┬────╮             │                                                                        ',
    '   ✓01  ×02⚒ ?03⚒          │                                                                        ',
    '   ├╌╌╌╌┴╌╌╌╌╯             │                                                                        ',
    '   ○ review ╌ ○ accept     │                                                                        ',
    ' ▾ lantern-ui             3│                                                                        ',
    ' ├ ◐ codex                 │                                                                        ',
    ' ├ ◐◈ run audit         12m│────────────────────────────────────────────────────────────────────────',
    ' └ ✓⚖ bench-check          │ > █                                                                    ',
    ' ▸ scratch              ○ 1│────────────────────────────────────────────────────────────────────────',
    '                          «│ harbor-api main ↑1 · ctx 42% · ?1 · ⚒2 ◈1 · WSL C14% M29%              ',
  ],
  // Deep HUD page open — ◆ HUD · Execution (100 × 24: full 28c sidebar untouched + 72c peeked workbench)
  C2: [
    ' ?1 harbor-api · waits  14m│  claude    tests    [◆ HUD · Execution]   +                   2 hidden ',
    ' Keep push as the default? │ Home ?1    Project    [Execution·2]    Control          harbor-api [ ] ',
    ' ◆ Home  Proj [Exec·2] Ctrl│ ? harbor-api › dock-ux · Keep push as the default?      work waits 14m ',
    '───────────────────────────│                                                                        ',
    ' spaces              +3 prj│ Active Workflows ──────────────────────────────────────────────────── 2',
    ' × harbor-api      main ↑1▸│  ◐ Queue dock-ux · harbor-api (main ↑1)                    running 47m ',
    ' ◐ lantern-ui         main │    ✓01─────────╮                                                       ',
    ' ○ scratch             dev │   >×02⚒╌╌╌╌╌╌╌╌┼╌╌◇ review╌╌╌╌╌╌☆ accept                               ',
    ' new                   menu│    ?03⚒╌╌╌╌╌╌╌╌╯                                                       ',
    '───────────────────────────│  ◐ Single audit · lantern-ui (main)                        running 12m ',
    ' agents             grouped│    ◐◈ audit                                                            ',
    ' ▾ harbor-api             3│                                                                        ',
    ' ├ ○ claude                │ Selected Station — 02 Push dock width ─────────────────────────────── 1',
    ' └─▾ run dock-ux        47m│┌─ ×⚒ imp · claude-sonnet-5 · wt/imp-02 ─────────────── failed 6m ago ─┐',
    '   ╭────┬────╮             ││ Gate failed: cargo test --locked dock_push_width (1 failure)         │',
    '   ✓01  ×02⚒ ?03⚒          ││ assertion left == right: expected pane width >= 41, got 39 at 100c   │',
    '   ├╌╌╌╌┴╌╌╌╌╯             ││ Tab: launch_8f2a (remain on non-zero exit) · Repair 1/2 ready        │',
    '   ○ review ╌ ○ accept     │└─ g peek worker tab · o diff · r retry repair · x stop ──── j02bbbbb ─┘',
    ' ▾ lantern-ui             3│                                                                        ',
    ' ├ ◐ codex                 │ Asking Owner — 03 Dock default mode ───────────────────────────────── 1',
    ' ├ ◐◈ run audit         12m│  ?⚒ imp · opus · "Keep push as the default dock mode?"  14m · j03ccccc ',
    ' └ ✓⚖ bench-check          │                                                                        ',
    ' ▸ scratch              ○ 1│ Today: ✓5 ⚒  ✓2 ⚖  ✓1 ◈ · failed 1 · Schedule: M3 acceptance due       ',
    '                          «│ ⏎ inspector  ←→ station  g peek tab  P pin HUD  q back to claude     ? ',
  ],
  // Collapsed (100 × 24: fixed 13c rail + 87c terminal; zero reflow)
  C3: [
    ' ?1 for you │  claude    tests   +                                                         2 hidden ',
    ' ◆ HUD pages│ > how is the dock-ux queue doing?                                                     ',
    '────────────│                                                                                       ',
    '1 × harbor  │ ● 01 landed. 02 failed at the gate.                                                   ',
    '2 ◐ lantern │ ● 03 asks whether push stays default.                                                 ',
    '3 ○ scratch │   Waiting for your answer.                                                            ',
    ' +3 projects│                                                                                       ',
    '────────────│ ● lantern-ui runs audit in space 2.                                                   ',
    ' ○ claude   │                                                                                       ',
    ' ╭───┬───╮  │                                                                                       ',
    ' ✓01 ×02 ?03│                                                                                       ',
    ' ├╌╌╌┴╌╌╌╯  │                                                                                       ',
    ' ○rev╌○acc  │                                                                                       ',
    '────────────│                                                                                       ',
    ' ◐ codex    │                                                                                       ',
    ' ◐◈ audit   │                                                                                       ',
    ' ✓⚖ check   │                                                                                       ',
    '────────────│                                                                                       ',
    ' ○ pi       │                                                                                       ',
    '            │                                                                                       ',
    '            │───────────────────────────────────────────────────────────────────────────────────────',
    '            │ > █                                                                                   ',
    '            │───────────────────────────────────────────────────────────────────────────────────────',
    '          » │ harbor-api main ↑1 · ctx 42% · ?1 · ⚒2 ◈1 · WSL C14% M29%                             ',
  ],
  // Narrow (60 × 14: 2-row header with switch live + ◆ HUD peeked below)
  C4: [
    ' × harbor-api  ◆ HUD · Execution · 2 hidden ?1 »  │        ×',
    ' ×1 ◐2 ✓1 ○2 │ harbor [✓×?]╌○╌○  lantern ◐◈       │  switch ',
    ' Home ?1   Project  [Execution·2]  Control                  ',
    ' ? dock-ux/03 · Keep push as the default?         waits 14m ',
    ' Workflow — harbor-api / dock-ux ───────────────────────── 1',
    '  ✓01───╮                                                   ',
    ' >×02⚒╌╌┼╌◇ review╌╌☆ accept                                ',
    '  ?03⚒╌╌╯                                                   ',
    '  × 02 Push dock width · cargo test failed             ⚒ 6m ',
    '  ? 03 Dock default · waiting on owner                ⚒ 14m ',
    ' Other active runs ─────────────────────────────────────── 1',
    '  ◐ lantern-ui / audit                        ◈ running 12m ',
    '                                                            ',
    ' ⏎ inspect  g peek tab  q return to claude       switch=nav ',
  ],
  // Minimal (100 × 24: today's 4c folded rail; HUD adds only ?N on top and a shape on folded runs)
  C5: [
    '?1 │  claude    tests   +                                                                  2 hidden ',
    '───│ > how is the dock-ux queue doing?                                                              ',
    '1 ×│                                                                                                ',
    '2 ◐│ ● 01 landed. 02 failed at the gate.                                                            ',
    '3 ○│ ● 03 asks whether push stays default.                                                          ',
    '───│   Waiting for your answer.                                                                     ',
    '  ○│                                                                                                ',
    '▸×2│ ● lantern-ui runs audit in space 2.                                                            ',
    '┈┈┈│                                                                                                ',
    '  ◐│                                                                                                ',
    ' ◐◈│                                                                                                ',
    ' ✓⚖│                                                                                                ',
    '───│                                                                                                ',
    '  ○│                                                                                                ',
    '   │                                                                                                ',
    '   │                                                                                                ',
    '   │                                                                                                ',
    '   │                                                                                                ',
    '   │                                                                                                ',
    '   │                                                                                                ',
    '   │────────────────────────────────────────────────────────────────────────────────────────────────',
    '   │ > █                                                                                            ',
    '   │────────────────────────────────────────────────────────────────────────────────────────────────',
    ' » │ harbor-api main ↑1 · ctx 42% · ?1 · ⚒2 ◈1 · WSL C14% M29%                                      ',
  ],
};
FRAMES.A5 = FRAMES.B5 = FRAMES.C5;

const STATES = ['expanded', 'deep page open', 'collapsed', 'narrow 60', 'minimal'];
const PAGES = { A2: 'Execution', B2: 'Project › Tickets', C2: '◆ HUD · Execution' };
const VARIANTS = [
  {
    key: 'A', title: 'Enriched Native Sidebar + Adjacent Slide-Out Blade (recommended)',
    idea: "herdr's Rust sidebar (28c expanded, 13c fixed collapsed rail) stays permanently at column 0 and absorbs HUD's ambient awareness: a ?N owner-request crown (0 rows when calm) and Home · Proj · Exec · Ctrl launcher sit above spaces; each project-backed workspace in spaces fuses its workspace row (branch ↑1, worktree ▸, drag-reorder) with a 1-line run strip (dock-ux [✓×?]╌○╌○), and +N prj folds other registered projects; in agents, hud_subgroup worker lists default to folded (└─▸ dock-ux ×⚒ ?⚒ 2) so steps are never shown twice unless unfolded. Clicking a page tab, +N prj, a headless/failed station (×02), or prefix+d / /hud slides out HUD's 40c DockSide::Left push blade beside the sidebar (x = 13..54 at 100c with transient 13c rail compaction; alongside the full 28c sidebar at >= 110c), keeping navigation, deep HUD, and terminal all live.",
  },
  {
    key: 'B', title: 'Single-Column Split Deck (Native Nav Crown + In-Column HUD PTY)',
    idea: "Never open a second horizontal column: keep one left column (28c ambient, widening in place to 41c when a deep HUD page opens; fixed 13c collapsed) split vertically by a draggable ═══ HUD ═══▾ divider. herdr's unmodified Rust render_sidebar paints spaces and agents in the upper deck (independent scrollbars, drag-reorder, worktree ▸/▾, new / menu, glued ◐⚒), while hud panel's PTY is blitted into the lower deck of that same column — showing ?N prose + #1 / #2 workspace-keyed mini-graphs in ambient use, and expanding to ~65% height for deep Project, Execution, or Control pages while spaces and agents stay scrollable in the top 8 rows.",
  },
  {
    key: 'C', title: 'Unified Run-Tree Sidebar + Peeked Center Workbench (◆ HUD)',
    idea: "Keep the left sidebar permanently at navigation width (28c expanded, 13c collapsed — never widening or compacting) by fusing the 2D miniature workflow graph directly into agents's hud_subgroup tree (└─▾ run dock-ux renders ╭────┬────╮ / ✓01 ×02⚒ ?03⚒ / ○ review ╌ ○ accept, where live-pane stations carry their role glyph and focus/peek their terminal on click, while headless/settled stations open Execution), and open deep HUD pages in the main surface as a peeked system tab [◆ HUD] (72c wide at 100c via hidden_tabs_peek semantics, HUD-FORK.md:36-40; optional push-split at >= 112c via P). The full 28c sidebar stays 100% visible during deep HUD use, and clicking any space or agent immediately focuses that terminal and auto-rehides ◆ HUD.",
  },
];

for (const [id, rows] of Object.entries(FRAMES)) {
  const [width, height] = id.endsWith('4') ? [60, 14] : [100, 24];
  if (rows.length !== height) throw new Error(`${id} has ${rows.length} rows, not ${height}`);
  rows.forEach((row, y) => {
    // The length check keeps one character per cell, which the colour spans below count on.
    if (visualLength(row) !== width || row.length !== width) {
      throw new Error(`${id} row ${y} is ${visualLength(row)} cells, not ${width}`);
    }
  });
}

// ------------------------------------------------------------------------------------------------------------- inks
try { applyDisplaySettings(runtimeSettings()); } catch { /* unreadable settings: the environment's theme stays */ }
const plain = displayConfig().theme === 'none';
const RESET = '\x1b[0m';
const sgr = (code) => (text) => (plain ? text : `\x1b[${code}m${text}${RESET}`);
/** A surface that survives the resets of the spans inside it. */
const surface = (rgb) => (text) => (plain ? text
  : `\x1b[48;2;${rgb}m${text.replaceAll(RESET, `${RESET}\x1b[48;2;${rgb}m`)}${RESET}`);
const ink = (rgb) => sgr(`38;2;${rgb}`);
const bold = (rgb) => sgr(`1;38;2;${rgb}`);

// herdr's rose-pine (herdr src/app/state.rs).
const ROSE = {
  base: '25;23;36', surface0: '31;29;46', row: '38;35;58', overlay0: '110;106;134', overlay1: '144;140;170',
  text: '224;222;244', subtext: '200;197;220', iris: '196;167;231', pine: '49;116;143', gold: '246;193;119',
  love: '235;111;146', foam: '156;207;216',
};
const ground = surface(ROSE.base), activeRow = surface(ROSE.row);
const H = {
  name: bold(ROSE.text), head: bold(ROSE.overlay0), sub: ink(ROSE.subtext), o0: ink(ROSE.overlay0),
  o1: ink(ROSE.overlay1), rule: ink(ROSE.row), accent: ink(ROSE.iris), working: ink(ROSE.gold),
  blocked: ink(ROSE.love), done: ink(ROSE.foam), idle: ink(ROSE.pine),
};
const tabInk = ink(ROSE.overlay1), tabGround = surface(ROSE.surface0);
const focusInk = bold(ROSE.base), focusGround = surface(ROSE.iris);
const chip = (text) => tabGround(tabInk(text));
const focusedChip = (text) => focusGround(focusInk(text));
const P = theme.board;

// ------------------------------------------------------------------------------------------------------------ zones
// A rule paints its first group, or the whole match; a later rule wins.
const ASK = /(?<![A-Za-z"])\?\d*/dg;
const HERDR = [
  [/^[─┈ ]*[─┈]{3}[─┈ ]*$/dg, H.rule],
  [/[├└│]─?|[▾▸░▐«»═]/dg, H.o0],
  [/▸(?= [^×]*×)/dg, H.blocked],
  [/▸(?= [^×◐○]*○)/dg, H.idle],
  [/^ ?[▾▸] ([\w-]+)/dg, H.name],
  [/^\s*(spaces|agents)\b/dg, H.head],
  [/(?<=═ )HUD/dg, H.name],
  [/\b(?:grouped|new|menu|dev)\b|(?<= )main\b(?: ↑\d)?|^[123](?= )/dg, H.o0],
  [/^[│ ]{3,}([a-z-]+) *$/dg, H.o0],
  [/tab claude(?: · 1\/2)?|(?:· )?\d hidden|· [\w-]+/dg, H.o0],
  [/× (harbor-api)  /dg, H.name],
  [/◆ HUD · \w+/dg, theme.accent],
  [/\+\d+ (?:prj|projects)/dg, P.muted],
  [/×\d*/dg, H.blocked], [/◐\d*/dg, H.working], [/✓\d*/dg, H.done], [/○\d*/dg, H.idle],
  [ASK, P.attention],
];
const HUD = [
  [/[─╌┈│╭╮╰╯├┤┬┴┼┌┐└┘[\]]+/dg, P.frame],
  [/^ ?([A-Za-z][^─│┌└]*?)(?= ─{3})/dg, theme.bold],
  [/·|\b\d+[mh]\b(?: ago)?|[▸▾«»☆◇]|\[ \]|\+\d+ (?:other )?(?:prj|projects)/dg, P.muted],
  [/◇(?= dx)/dg, P.identifier],
  [/◆/dg, theme.accent],
  [/━+/dg, P.success],
  [/\bfail(?:ed)?\b/dg, P.danger],
  [/\b(?:asking|waits|waiting)\b/dg, P.attention],
  [/\brunning\b|>(?=[×✓?])/dg, P.active],
  [/\bimp(?= ·)/dg, theme.roleInk.imp],
  [/×\d*/dg, P.danger], [/◐\d*/dg, P.active], [/✓\d*/dg, P.success], [/○/dg, P.muted],
  [ASK, P.attention],
  [/\[(?:Home|Project|Exec|◆ HUD)[^\]]*\]/dg, theme.tab],
];
/** Each zone's default ink and its rules, for the text of one segment of a row. */
const ZONES = {
  herdr: () => [H.sub, HERDR],
  // A row of key hints recedes as a whole: its `?` is the help key, not a question.
  hud: (text) => (text.includes('⏎') ? [P.muted, []] : [theme.value, HUD]),
  pane: () => [H.o1, [[/─+/dg, H.o0], [/█/dg, H.sub]]],
  bar: () => [H.o1, [[ASK, P.attention]]],
  tabs: (text) => [H.o0, [
    [/ claude /dg, text.includes('◆ HUD') ? chip : focusedChip],
    [/ tests | \+ /dg, chip],
    [/\[◆ HUD[^\]]*\]/dg, theme.tab],
  ]],
  button: () => [H.o1, []],
  edge: () => [H.rule, [[/[«»]/dg, H.o1]]],
};

// Where each frame's columns divide and which rows of the left column HUD draws; the rest of that column is herdr's.
// `split` is the sidebar's border column (none on narrow screens), `blade` the dock's, `body` what fills the main area
// instead of a terminal, `herdr` how many top rows of a narrow screen herdr draws.
const span = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const RAIL_A = [0, ...span(3, 7), 9, 11];
const TREE_C = [0, 1, 2, ...span(13, 17), 20];
const LAYOUT = {
  A1: { split: 27, hud: [0, 1, 2, 6, 8], focus: [5, 6] },
  A2: { split: 12, hud: RAIL_A, focus: [2], blade: 53 },
  A3: { split: 12, hud: RAIL_A, focus: [2] },
  A4: {},
  B1: { split: 27, hud: span(13, 23), focus: [1] },
  B2: { split: 40, hud: span(9, 23), focus: [1] },
  B3: { split: 12, hud: span(10, 22), focus: [0] },
  B4: { herdr: 5, body: 'hud' },
  C1: { split: 27, hud: TREE_C, focus: [5] },
  C2: { split: 27, hud: TREE_C, focus: [5], body: 'hud' },
  C3: { split: 12, hud: [0, 1, 6, ...span(9, 12), 15], focus: [3] },
  C4: { body: 'hud' },
  C5: { split: 3, hud: [0, 7], focus: [2] },
};
LAYOUT.A5 = LAYOUT.B5 = LAYOUT.C5;

/** The `[from, to, zone]` segments of row `y`. */
function segments(id, y) {
  const row = FRAMES[id][y], end = row.length;
  const { split, blade, hud, body = y === FRAMES[id].length - 1 ? 'bar' : 'pane', herdr = 0 } = LAYOUT[id];
  if (split === undefined) {
    if (y >= 2) return [[0, end, y < herdr ? 'herdr' : body]];
    // herdr's two-row narrow header: facts, HUD's run strips on the second row, then the buttons.
    const first = row.indexOf('│'), last = row.lastIndexOf('│');
    return [[0, first, 'herdr'], [first, first + 1, 'edge'], ...(last > first
      ? [[first + 1, last, 'hud'], [last, last + 1, 'edge'], [last + 1, end, 'button']]
      : [[first + 1, end, 'button']])];
  }
  const left = [[0, split, hud.includes(y) ? 'hud' : 'herdr'], [split, split + 1, 'edge']];
  if (y === 0) return [...left, [split + 1, end, 'tabs']];
  if (blade) return [...left, [split + 1, blade, 'hud'], [blade, blade + 1, 'edge'], [blade + 1, end, body]];
  return [...left, [split + 1, end, body]];
}

function paintRow(id, y) {
  const row = FRAMES[id][y], inks = Array(row.length), grounds = Array(row.length);
  for (const [from, to, zone] of segments(id, y)) {
    const text = row.slice(from, to), [base, rules] = ZONES[zone](text);
    inks.fill(base, from, to);
    for (const [pattern, paint] of rules) {
      for (const match of text.matchAll(pattern)) {
        const [start, stop] = match.indices[1] ?? match.indices[0];
        inks.fill(paint, from + start, from + stop);
      }
    }
  }
  // The focused workspace: herdr's row surface, its name and branch lifted.
  const { split, focus } = LAYOUT[id];
  if (focus?.includes(y)) {
    grounds.fill(activeRow, 0, split);
    const lifted = y === focus[0] ? [[/harbor(?:-api)?/dg, H.name], [/main(?: ↑\d)?/dg, H.accent]] : [];
    for (const [pattern, paint] of lifted) {
      for (const match of row.slice(0, split).matchAll(pattern)) inks.fill(paint, ...match.indices[0]);
    }
  }
  let out = '';
  for (let x = 0, next = 1; x < row.length; x = next++) {
    while (next < row.length && inks[next] === inks[x] && grounds[next] === grounds[x]) next++;
    const text = inks[x](row.slice(x, next));
    out += ground(grounds[x] ? grounds[x](text) : text);
  }
  return out;
}

// ----------------------------------------------------------------------------------------------------------- screen
let variant = 0, state = 0, info = false, open = true;

function wrap(text, width) {
  const lines = [''];
  for (const word of text.split(' ')) {
    const joined = lines.at(-1) ? `${lines.at(-1)} ${word}` : word;
    if (visualLength(joined) <= width) lines[lines.length - 1] = joined;
    else lines.push(word);
  }
  return lines.map((line) => truncateAnsi(line, width));
}

function render() {
  if (!open) return;
  const columns = process.stdout.columns || 100, rows = process.stdout.rows || 25;
  const { key, title, idea } = VARIANTS[variant], id = `${key}${state + 1}`, frame = FRAMES[id];
  const width = frame[0].length, need = frame.length + 1;
  const head = `Variant ${key} · ${STATES[state]} (${state + 1}/${STATES.length})`;
  const placed = []; // [row, column, text]
  if (columns < width || rows < need) {
    const lines = [head, `Terminal is ${columns}×${rows}; this frame needs ${width}×${need}.`,
      'Enlarge the window or zoom the pane. q quits.'].flatMap((line) => wrap(line, columns));
    lines.slice(0, rows).forEach((line, i) => placed.push([i, 0, line]));
  } else {
    // The footer keeps one width across states, so a narrow frame does not stretch the idea down the screen.
    const room = rows - need, footer = Math.min(columns, 100), left = Math.floor((columns - footer) / 2);
    let notes = info ? [`${STATES[state]}${PAGES[id] ? ` · ${PAGES[id]}` : ''} — ${title}`, ...wrap(idea, footer)] : [];
    if (notes.length > room) notes = room > 1 ? [...notes.slice(0, room - 1), '… a taller terminal shows the rest'] : [];
    const x = Math.floor((columns - width) / 2);
    const y = Math.max(0, Math.min(Math.floor(room / 2), room - notes.length));
    const hint = info && !notes.length ? 'a taller terminal shows the idea · q quit'
      : '1 2 3 variant · ←→ state · i idea · q quit';
    const fits = head.length + 3 + visualLength(hint) <= columns - x;
    placed.push([y, x, theme.bold(head) + (fits ? `   ${P.muted(hint)}` : '')]);
    frame.forEach((_, i) => placed.push([y + 1 + i, x, paintRow(id, i)]));
    notes.forEach((line, i) => placed.push([y + need + i, left, (i ? P.muted : theme.bold)(truncateAnsi(line, footer))]));
  }
  process.stdout.write(`${RESET}\x1b[2J${placed.map(([r, c, text]) => `\x1b[${r + 1};${c + 1}H${text}`).join('')}`);
}

function restore() {
  if (!open) return;
  open = false;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(`${RESET}\x1b[?7h\x1b[?25h\x1b[?1049l`);
}

function quit() {
  restore();
  process.stdout.off('resize', render);
  process.stdin.destroy();
}

function press(key) {
  const pick = '123'.indexOf(key) >= 0 ? '123'.indexOf(key) : 'abc'.indexOf(key);
  if (key === 'q' || key === '\x03') return quit();
  if (pick >= 0) variant = pick;
  else if (key === 'l' || key === '\x1b[C' || key === '\x1bOC') state = (state + 1) % STATES.length;
  else if (key === 'h' || key === '\x1b[D' || key === '\x1bOD') state = (state + STATES.length - 1) % STATES.length;
  else if (key === 'i') info = !info;
  else return;
  render();
}

process.on('exit', restore);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
// Alternate screen, no cursor, no autowrap: a frame never spills onto the next row.
process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
process.stdout.on('resize', render);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
// One chunk can carry several keys; an escape sequence counts as one.
process.stdin.on('data', (chunk) => {
  for (const [key] of chunk.matchAll(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)|[\s\S]/g)) if (open) press(key);
});
process.stdin.on('end', quit);
render();
