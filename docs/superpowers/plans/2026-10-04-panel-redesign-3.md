# Panel redesign, round 3: a prefix key, no stolen keystrokes, real buttons

Date: 2026-10-04 · Branch: `hud-enhancements` (on top of `8ec5d7f`)

This follows rounds 1 and 2 (`2026-10-04-panel-redesign.md`, `-2.md`), which
are both implemented. The user approved everything in this document. Do all
of it in one run, commit each part on its own, and finish with the live
check in part 5. Do not stop to ask questions. Where a detail is open,
choose, and say which in the final report.

## The problem

**Keystrokes get stolen.**
- When the keyboard focus is in the side panel (after a click on a card,
  after `Shift+F12`, or after the bar handed it over), every letter the
  user meant for Codex becomes a panel command: `m a b r , ? 1–5 j k e f s
  z q x -` and so on.
- The user calls this hijacking.

**The control bar from round 2 is "neither fish nor fowl".**
- It shows key letters as if they were buttons: `b‖`, `a+32`, `,设置`, `?`,
  and the tabs `1 2 3 4 5`.
- The user wants **buttons drawn as words or icons, never as their
  shortcut keys**.

## The user's decisions

1. **Every panel command is `prefix` + key.**
   - The **default prefix is `Ctrl+]`**, configurable in Settings.
   - It is a tmux key table, so it works whether the focus is on the
     Codex pane or on the panel. Outside the prefix, the HUD takes no
     ordinary keys.
2. **`F12` (toggle the panel) and `Shift+F12` (give the panel focus) stay as
   direct keys**, exactly as today.
3. **With the focus on the panel, every key without the prefix goes to
   Codex.**
   - The panel takes no plain keys at all. That includes navigation: it is
     driven by the mouse and the prefix only.
   - **Exception: modal overlays.** While the settings page or the help
     overlay is open, it takes the keys it needs until `Esc` closes it, and
     then forwarding resumes. The filter `f` has no text field today; it
     cycles through statuses. So it is a plain command, not a modal.
4. **The control bar's controls are buttons:** words when there is room, icons
   when there is not. No key letters on screen at all. The shortcuts are
   documented only in the help overlay.

## 1. The prefix key table

File: `bin/codex-hud`, `install_session_input_policy`. It already builds the
session key table `codex-hud` and never touches the server's root table.
Keep it that way.

**Binding the prefix.**
- In `codex-hud`, bind the prefix to `switch-client -T codex-hud-prefix`.
- Pressing the prefix twice sends a literal prefix key to the focused pane
  (the standard tmux idiom).

**The `codex-hud-prefix` table.** Each key sends one command to the panel
process. Use the same letters as today's panel keys:

| Key | Command |
|---|---|
| `m` | main |
| `b` | brief pause/resume |
| `a` | older agents |
| `,` | settings |
| `?` | help |
| `r` | status level |
| `1`–`5` | panes |
| `x` | close pane |
| `-` | fold pane |
| `z` | zoom |
| `f` | filter |
| `s` | order |
| `q` | close panel |
| `o` | switch to selected |
| `Enter`/`v` | inspect |
| `e`/`Space` | open card |
| `g`/`G` | first/last |
| `Esc` | back |

Navigation:
- `j`/`k`/`Up`/`Down`/`PgUp`/`PgDn` are bound with **`-r` (repeat)**, so
  `Ctrl+] j j j` moves three rows inside tmux's `repeat-time`.
- Every other key in the table ends the prefix. Any key not in the table
  ends the prefix and does nothing.

**When the panel is closed.**
- A command that needs the panel opens it first, then runs: settings,
  help, brief, older agents, the pane keys and so on.
- This races against the new panel process creating its command channel.
  Queue the command, for example as a file in the state directory that the
  panel consumes on start, or retry for about 2 s. It must never be lost or
  run twice.
- `q` and the navigation keys do nothing.

**How commands reach the panel.**
- Choose a channel that cannot be confused with typed input. Either:
  - a per-panel FIFO or unix socket under the HUD state directory, or
  - `send-keys` of a private escape sequence that `WorkbenchInputDecoder`
    recognises, for example an OSC or DCS string with a fixed tag that a
    terminal never generates.
- Say which you chose and why.
- Commands must work when the panel is not focused. That rules out relying
  on the focused pane's stdin alone.

**Settings.**
- Add `prefixKey`. The default is `C-]`. Other candidates are `C-\`,
  `M-]` and `C-g`.
  - Check each candidate against Codex's own key bindings: the TUI's help
    or its `/keymap`, and the codex binary's strings if needed. Check it
    against tmux's default `C-b` as well.
  - Ship only the candidates you verified, and say what you checked.
- **Rebinding:** it applies when the key table is next installed. Make the
  toggle script reinstall it when the setting changes, if that is cheap.
  Otherwise the help states "takes effect on next launch".
- The value must reach `bin/codex-hud`. Read `hud-settings.json` the way the
  bash side already reads settings. If it reads none yet, use `node -e` with
  the built settings module, or a tiny `jq`-free parse.

**Existing sessions** keep their old table until relaunch. Mention this in
the final report.

## 2. Forward plain keys to Codex

File: `src/tree-page.ts` and the input decoder
(`src/utils/workbench-input.ts`, profile `monitor`).

**Forwarding.**
- **Today's decoder drops pastes.** `WorkbenchInputDecoder` throws away
  paste bodies: in paste mode it keeps only the last 5 bytes while it looks
  for the end marker. Change it to collect the whole paste body when
  forwarding.
- Any key or paste that reaches the panel's stdin goes to the main Codex
  pane, unless it is a prefix command (part 1), a mouse event or input for
  an open modal.
- **Keystrokes:** send the **exact bytes** with
  `tmux send-keys -t <main pane> -H <hex…>`, or an equivalent that is
  byte-exact.
- **Pastes:** do not use `send-keys`. Its hex form doubles the size and hits
  the command-line limit on a large paste. Instead, pipe the body into
  `tmux load-buffer -b codex-hud-fwd -`, then run
  `tmux paste-buffer -p -d -b codex-hud-fwd -t <main pane>` (`-p` keeps it
  a bracketed paste).
- **Ordering:** serialize the forwards. Keys typed faster than
  `select-pane` takes effect all land on the panel's stdin. Batch the bytes
  of one input chunk into one `send-keys`, and never run two forwards at
  once, or the keystrokes interleave.
- Move the focus to the main pane (`select-pane -t <main pane>`) at the same
  time, so the next keystrokes go there directly.
- Use `CODEX_HUD_MAIN_PANE`, or `@codex_hud_main_pane` on the session, as
  the main pane id. Go through `CODEX_HUD_TMUX_BIN` when it is set, so the
  test harness can redirect the call.

**Modals.**
- The settings page and the help overlay own the keyboard while open.
- `Esc`, or the modal's own close, returns to forwarding mode.
- Opening a modal through the prefix or a button selects the panel pane, so
  the keys reach it.

**Mouse.** Unchanged: clicks, the wheel and drags still work in the panel.

**Statusline-only mode** (panel closed): forwarding is irrelevant there, but
the prefix commands from part 1 still apply.

## 3. Buttons, not shortcuts, on the control bar

File: the control bar from round 2 (`monitor.ts` around the first frame row,
and wherever round 2 put it).

Every control is a **button**: a word, or an icon at narrow widths, on a
chip background (the palette's `bar` background with a slightly lighter
chip, for example 238 on 236 for `terminal`; Catppuccin equivalents).
**Show no key letters anywhere on the bar.**

| Control | Wide (≥ 48 cols) | Narrow |
|---|---|---|
| Back to main | `← 主会话` | `←` |
| Panes (tabs) | the pane names: 卡片 · 工作树 · 改动 · 检查器 · 时间线 (en: Agents · Trees · Changes · Inspect · Timeline). Open, closed, focused and folded states as round 2 drew them | one single-width icon per pane, chosen by you. Must be distinct from the glyphs the legend already uses (✓ ✗ ▸ ◈ ◎ ◷ …) and width 1 by `visualLength` |
| Brief pause/resume | `‖ 简报` / `▸ 简报` | `‖` / `▸` |
| Older agents | `+32 已收起` / `收起` | `+32` |
| Settings | `设置` | `≡`, or another width-1 glyph |
| Help | `帮助` | `?` |

**Squeeze order:** the tab names become icons first, then the other words
become icons, then closed panes' tabs drop, then the older-agents button.
`←`, settings and help stay.

**The help overlay (`?`)** gets a "Shortcuts" section. It lists
`Ctrl+] then …` (the configured prefix's name) for each command and states
that plain keys go to Codex.

**Also remove key-letter hints everywhere else:**
- `▾`/`▴` on cards are icons, so they are fine.
- Search the render code for any remaining `x key` hints, such as
  `b pause`, `Esc back`, `↑↓ select`, or the settings page footer
  `↑↓ select ←→ change s save r reset Esc back`. The settings page is a
  modal, so its keys stay valid, but present them the same way. Either:
  - keep a short help line, because inside the modal those keys are real;
    or
  - add `[保存] [重置] [返回]` buttons, which already exist as
    `[Back] [Save] [Reset]`.
  Keep the existing buttons and drop the duplicated key words.

## 4. Docs

Update `README.md` and `README.zh.md`, and the `?` legend:
- the prefix;
- that keys typed in the panel go to Codex;
- the new buttons;
- the `prefixKey` setting.

## Ground rules (as before)

- **Commits.**
  - First commit this plan file. Then commit parts 1, 2, 3 and 4
    separately, plus a fix commit after the live check if needed.
  - Subjects are imperative sentences in the repo's style.
  - End every message with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Do not push.
- **Checks.** `npm test` must pass at every commit. Do not make
  `format:check` worse than its 127-file baseline.
- **i18n.** English is the key, with zh for every new string.
- **Safety.**
  - **Never change anything on the user's default tmux server.** Their live
    Codex panes are `%0` and `%16`, and the HUD panes are `%8` and `%18`.
    Read-only `display -p` and `list-panes` are allowed.
  - `bin/codex-hud` calls `tmux` directly. For tests, put a wrapper dir
    first on `PATH`: `$S/tmuxbin/tmux` running `exec tmux -L hudui "$@"`.
    That way the key-table install only ever reaches the `hudui` server.
    **Verify that the wrapper is in effect before running any install
    code.**
  - Never write into `~/.codex` or `~/.codex-account2`.
  - Every harness launch puts `$S/fakebin` first on `PATH`.
  - Afterwards: `tmux -L hudui kill-server`, and no stray `sleep 900`.
- **Paths.** `$S` =
  `/tmp/claude-1000/-home-fires-codex-codex-hud/c4a91d06-e869-4633-8cf6-9b018adb87bc/scratchpad`.
  Harness: `$S/launch.sh`, `$S/ch`, `$S/ch2`, `$S/mkrun.py`, `$S/tmuxw`, and
  the PNG pipeline (`$S/prev/ansi2html.py` plus the Chrome under
  `~/.omp/puppeteer/…`), all from rounds 1 and 2.

## 5. Live check (required)

**Step zero: make sure nothing real can start.**
`bin/codex-hud` is the full launcher. Any path through it can start `codex`
with the user's home and auth.
- Create a fake `codex` in `$S/fakebin` that runs `exec cat -v`.
- Point `CODEX_HOME` at `$S/ch2`.
- Put **both** `$S/tmuxbin` (the tmux wrapper) and `$S/fakebin` first on
  `PATH` for every command that goes through `bin/codex-hud`.
- Before running any install or launcher code, verify that `which codex`
  and `which tmux` resolve to the fakes. Show that output in the report.

**Build a realistic two-pane session in the `hudui` server.**
- The left "main" pane runs `cat -v`, standing in for Codex, so forwarded
  bytes are visible.
- The right pane is the panel (`dist/tree-page.js` on `ch2`).
- Set `CODEX_HUD_MAIN_PANE`, the `@codex_hud_*` options and the
  `codex-hud` / `codex-hud-prefix` key tables through the real install code
  in `bin/codex-hud`, with both fakes on `PATH`. Do not hand-write
  bindings.
- `@codex_hud_main_pane` must point at the `cat -v` pane. Set it
  explicitly; do not leave it for the launcher to guess.

**Prove each of these, and capture the evidence into `$S/captures/r3/`.**
1. With the panel focused, typing `hello m a ,` plus `Enter` produces no
   panel action. The text appears in the `cat -v` pane, and the focus moves
   to it.
2. A bracketed paste into the panel arrives in the main pane as a paste.
3. From the **main** pane:
   - `Ctrl+] ,` opens settings;
   - `Ctrl+] ?` opens help;
   - `Ctrl+] b` toggles the brief;
   - `Ctrl+] 5` opens the timeline;
   - `Ctrl+] j j j` moves the selection three rows (repeat);
   - `Ctrl+] Ctrl+]` delivers a literal `^]` to `cat -v`.
4. Inside settings (a modal), the arrows and `Esc` work in the panel. After
   `Esc`, a typed letter forwards again.
5. `F12` and `Shift+F12` still toggle and focus the panel.
6. The control bar at 32, 40 and 56 columns shows no key letters: words
   when wide, icons when narrow. Clicking each button performs its action.
   Use `tmux -L hudui send-keys -M`, or the click-map unit tests if mouse
   injection is impractical; say which.
7. `prefixKey` set to `C-\` and reinstalled: the new key works, and the old
   one no longer reaches the HUD.
8. PNGs of the bar at 32, 40 and 56 columns, and the help overlay's
   Shortcuts section. Copy the bar PNG to
   `/mnt/c/Users/fires/OneDrive/图片/hud-r3-bar.png`.

## Final report

1. The commits.
2. The test counts.
3. The evidence for each item in part 5: paste the key `.txt` captures and
   give the PNG paths.
4. The command channel you chose.
5. The decisions made, and anything not done, with the reason.
6. What the user must do: relaunch `codexH` so that their sessions get the
   new key table.
