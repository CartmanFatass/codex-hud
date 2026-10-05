# Panel redesign, round 4: readable tabs, no key hints, human names for worktrees

Date: 2026-10-04 · Branch: `hud-enhancements` (on top of `1eb5ede`)

Rounds 1–3 are implemented (`2026-10-04-panel-redesign{,-2,-3}.md`). The user
looked at their live panel and asked for the changes below. Their screenshot
is `/mnt/c/Users/fires/OneDrive/图片/hud.png`: about 36 columns wide, with
the worktrees, changes, inspector and timeline panes open. Look at it
first. The user approved this direction.

Do it all in one run, commit each part on its own, and finish with the live
check. Do not stop to ask questions. Where a detail is open, choose and say
which in the final report.

The standing rule from round 3 still holds: commands go through the prefix
key, plain keys go to Codex, and **on-screen controls are words or icons,
never shortcut letters**. This round goes further: **icons have to be
self-evident.** When one isn't, use a word.

## 1. The control bar: readable, not tiny icons

In the screenshot, the pane tabs `▦ ⎇ ± ⌖ ⋮` render small and faint, and
nobody can tell which is which. The brief's `▸`/`‖` is also tiny.

**Pane tabs are words.**
- **Wide:** the full pane names. zh: 卡片 · 工作树 · 改动 · 详情 · 时间线
  (use whatever the pane titles say, so the two always match).
- **Narrow:** a **one-character CJK abbreviation**, which is still a word:
  卡 · 树 · 改 · 详 · 时.
- **English:** short words, Agents · Trees · Changes · Inspect · Timeline,
  narrowing to `Ag Wt Ch In Tl`.
- Draw each tab as a chip, with the round-2/3 states for open, closed,
  focused and folded. Every state must stay distinguishable at the narrow
  size and with no colour.
- Drop the five icons entirely.

**Brief button.** Use words: 暂停简报 / 继续简报 when wide, 暂停 / 继续 when
narrow (en: Pause brief / Resume brief, then Pause / Resume). No `‖` or `▸`
glyph on the bar.

**Older-agents button.** `+37 已收起` when wide, `+37` when narrow. When
they are shown: `收起` (en: Hide).

**Settings and help stay words:** 设置 · 帮助.

**Back button:** `← 主会话` when wide, `← 主` when narrow.

**Squeeze order:**
1. the tab words shorten to one character;
2. the closed panes' tabs drop;
3. the other buttons shorten;
4. the older-agents button drops.

Back, settings and help stay. At 32 columns everything that remains must be
legible. Check the PNG.

**Pane titles lose their digits.** `2 工作树`, `3 改动`, `4 详情` and
`5 时间线` show the shortcut digit, which breaks the rule. Draw only the
name.

## 2. No key hints anywhere outside the help

- `全部已完成 · 按 a 显示` (`'All finished · a shows'`, `monitor.ts` around
  line 509) becomes just `全部已完成`. The bar's `+37` button is the way to
  show them.
- **Sweep the whole render code** and every i18n string for any other text
  that tells the reader to press a key: "按 X", "X shows", "Esc back",
  "b pause", "Enter", key names in footers. Remove the hint, or turn it into
  a word button if the action has no other way in.
- Inside modals (settings, help) a short line of the modal's own keys is
  allowed, because there they are real.
- Add a unit test that scans the rendered frames of every pane, the bar and
  the status card for key-hint patterns. The settings and help modals are
  exempt.

## 3. Worktrees by name, not by hash

Data in the user's repo (`git -C /home/fires/atlas-wsl worktree list`):

```
/home/fires/atlas-wsl                                                             2a8bdfd43 [main]
/home/fires/atlas-wsl/.git/atlas-launch-sources/912d078ebb934b7b8d1a2cd31cc06082  c01e0d563 (detached HEAD) locked
/home/fires/atlas-wsl/.git/atlas-launch-sources/9c66524d1f824b6281dd3ac169fe8dde  6e5986ea4 (detached HEAD) locked
```

Today these render as `Ldetached` with the 32-hex directory under it. The
`L` (locked) mark is glued to the word, and the hash means nothing to a
person. Files: `monitor.ts` around lines 675–690 and 795, and
`src/collectors/worktrees.ts`.

**The name.**
- If there is a branch, use the branch.
- If the HEAD is detached, use a human name:
  - the worktree directory's basename, **unless it looks like an id**
    (hex of 7 or more characters, or a uuid);
  - in that case, the nearest ancestor directory that is not an id and is
    not `.git` (here `atlas-launch-sources`).
  - When two entries end up with the same name, tell them apart with the
    HEAD commit's subject (see below), never with the hash.

**The second line** (when it fits): the HEAD commit's subject,
`git log -1 --format=%s`, dim and clipped.
- Collect it in the worktree collector, cheaply: one `git log` per
  worktree, cached by HEAD sha.
- No hashes on screen, not even short ones.
- The detail/inspector view of a worktree follows the same rule. It shows
  the path relative to the repository root, where that is not an id path,
  and the subject.

**Locked** shows as the word `锁定` (en: locked), dim, after the status, for
example `atlas-launch-sources   干净 · 锁定`. Not as a glued `L`.

## 4. Other readability fixes seen in the screenshot

1. **Changes summary.** `2928Δ 0S 5U` is cryptic. Write words, leave out
   zero counts, and keep the order conflicts, staged, unstaged, untracked:
   `5 未暂存 · 2924 未跟踪`. At narrow widths keep the words but drop the
   least important count first, untracked before staged.
2. **Same file name twice.** The changes list shows `M SKILL.md` twice,
   because narrow widths show only the basename. Show the **shortest path
   suffix that tells the files apart**, for example
   `a/SKILL.md` / `b/SKILL.md`, and clip from the left (`…/SKILL.md`).
3. **Bare icons in the timeline.** `22h ⏎` on its own says nothing. A
   timeline line must carry a word as well:
   - `⏎ 回合结束` (×N when folded);
   - an agent run keeps its name;
   - `✗ exec` keeps the tool name.
   The icon stays; the word is added.
4. **Make the same check everywhere.** Any line or chip that is only an
   icon, apart from status glyphs that sit next to a name (`✓ name`), gets
   a word too. The `?` legend still lists the icons.

## Ground rules (as before)

- **Commits.**
  - First commit this plan. Then commit parts 1–4 separately, plus a fix
    commit after the live check if needed.
  - Subjects are imperative sentences in the repo's style.
  - End every message with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Do not push.
- **Checks.** `npm test` must pass at every commit. Keep `format:check` at
  its 127-file baseline.
- **i18n.** English is the key, with zh for every new string. `glyphs: text`
  and `theme: none` keep working.
- **Safety.**
  - Never change anything on the user's default tmux server: only
    read-only queries there.
  - Never write into `~/.codex`, `~/.codex-account2` or
    `/home/fires/atlas-wsl`. Read-only `git` queries against atlas-wsl are
    fine, and needed for part 3.
  - Every harness launch puts `$S/fakebin` (and `$S/tmuxbin` when going
    through `bin/codex-hud`) first on `PATH`.
  - Afterwards: kill the test tmux servers, and leave no stray `sleep 900`.
- **Paths.** `$S` =
  `/tmp/claude-1000/-home-fires-codex-codex-hud/c4a91d06-e869-4633-8cf6-9b018adb87bc/scratchpad`.
  Harness: `$S/launch.sh`, `$S/ch2` (cwd `/home/fires/atlas-wsl`, which has
  the three worktrees above), `$S/mkrun.py`, `$S/tmuxw`, and the PNG
  pipeline (`$S/prev/ansi2html.py` plus the Chrome under
  `~/.omp/puppeteer/…`).

## 5. Live check (required)

Reproduce the user's screenshot.
- Use `ch2` in `/home/fires/atlas-wsl` at **36×60**, and again at 32 and 56
  columns.
- Open the worktrees, changes, inspector and timeline panes, as in
  `hud.png`.
- Capture `.txt`, `.ansi` and PNG into `$S/captures/r4/`.

Show each of these:
1. The bar at 32, 36 and 56 columns, and in English at 36: tabs as words or
   one-character words, the brief button as a word, no icons, no key
   letters.
2. The worktree pane with the two detached, locked worktrees shown as
   `atlas-launch-sources` plus their commit subjects and `锁定`. No hash
   anywhere in the frame (grep for 7 or more hex characters).
3. The agents area with all agents hidden: just `全部已完成`.
4. The changes pane: the worded summary and the told-apart `SKILL.md` paths.
5. The timeline: `⏎ 回合结束`.
6. The key-hint scan test passing.

Copy the 36-column full-panel PNG to
`/mnt/c/Users/fires/OneDrive/图片/hud-r4-panel.png`, next to the user's
`hud.png`, for a side-by-side comparison.

## Final report

1. The commits.
2. The test counts.
3. The captures: paste the 36-column `.txt` capture inline, and give the PNG
   paths.
4. The decisions made, and anything not done, with the reason.

---

## Amendment A: real Nerd Font icons (user request, supersedes part 1's one-character words)

The user rejected the one-character CJK abbreviations (卡 树 改 详 时) as
"not intuitive either". They asked for **real icons**, rather than the
rendered Unicode symbols.

**Their terminal font is a Nerd Font.** Windows Terminal uses `MesloLGS NF`;
the files are under `/mnt/c/Users/fires/AppData/Local/Microsoft/Windows/Fonts/`,
and a copy is at `$S/meslo.ttf`. Its icon ranges include:
- Font Awesome `f000–f2e0`;
- Octicons `f400–f4a9`;
- Codicons `ea60–ebeb`;
- Devicons `e700–e7c5`;
- Material Design both old (`f500–fd46`) and new (`f0001+`).

I rendered candidates with that font in `$S/prev/icons.png`. All of them
draw cleanly.

**Use these glyphs**, in mostly Font Awesome's solid style, for one
consistent look:

| Control | Glyph | Codepoint |
|---|---|---|
| Main session (back) | home | `U+F015` |
| Agents pane | robot | `U+F06A9` (MD; a surrogate pair in JS) |
| Worktrees pane | git branch | `U+E725` |
| Changes pane | diff | `U+F440` |
| Inspector / details pane | info circle | `U+F05A` |
| Timeline pane | history | `U+F1DA` |
| Pause brief / resume brief | pause / play | `U+F04C` / `U+F04B` |
| Older agents: show / hide | eye / eye slash | `U+F06E` / `U+F070` |
| Settings | cog | `U+F013` |
| Help | question circle | `U+F059` |

**How they are drawn.**
- A Nerd Font icon takes **1 cell**, but draws wider than one cell. Always
  follow it with a space, or with its word.
- Make sure `visualLength`/`codePointWidth` counts BMP private use
  (`E000–F8FF`) and plane-15 private use (`F0000–FFFFD`) as width 1, and
  that truncation never splits a surrogate pair.
- **Wide:** icon plus word (` 设置`, ` 时间线`, `󰚩 卡片`).
- **Narrow:** icon only. The words drop before any button does.
- The pane titles in the pane frames may carry the same icon before the
  name.
- The open, closed, focused and folded tab states stay as round 2/3 drew
  them, by colour and chip, plus the no-colour variants.

**Settings.** Add an `icons` setting:
- `nerd` (default): the glyphs above;
- `text`: the words only, the part 1 behaviour without the one-character
  abbreviations, cut with `…` when narrow.

Put a help line on the setting: "Needs a Nerd Font in the terminal". The
existing `glyphs: text` mode implies `icons: text`.

**PNGs.** The PNG pipeline must load the user's font, or the icons render
as tofu boxes. Add `@font-face{font-family:M;src:url(file://$S/meslo.ttf)}`
and use it in `ansi2html.py`'s CSS (copy the script, don't break round 3's
captures). Pass `--allow-file-access-from-files` to Chrome.

**Live check additions.**
- The bar and the pane titles at 32, 36 and 56 columns with `icons: nerd`,
  rendered with the Meslo font.
- One capture with `icons: text`.
- Copy the 36-column one to `OneDrive/图片/hud-r4-panel.png`.

---

## Amendment B: no placeholder lines (user request, supersedes part 2's "全部已完成")

The user: "全部已完成 这样的提示也不要写，这种单独的占位提示不要占空间……这些其实直接能从底部的状态卡片就能看出来，你在做冗余设计。" In
English: don't write prompts like "all finished"; standalone placeholder
lines shouldn't take up space; the status card at the bottom already shows
this; this is redundant design.

**Rule:** a line that only says something is empty, done, clean or
waiting, and whose fact the reader can already see elsewhere (the status
card, the summary counts, the bar's `+N` button, the pane's own frame),
**is not drawn and takes no row**.

**Remove:**
- `全部已完成` / `All finished`, and every variant of the agents' empty
  text (`emptyAgentsText`): `No subagents yet` (还没有 subagent),
  `No matching agents`, and the rest. With no agents to list, the agents
  area is simply empty, and the summary row shows its counts, or nothing.
- **Empty-state lines in panes:**
  - `Working tree clean` / `干净`, when it is the only content: the pane
    shows no rows. Per-worktree status words in the worktree list stay,
    because there they are data.
  - `No worktrees recorded`.
  - `No selected worktree`.
  - `Reading worktrees…` / `Reading selected worktree…`, and other
    "reading…" placeholders. Show nothing until the data arrives.
  - Any other line of this kind you find. Sweep `monitor.ts`, `cards.ts`,
    `status-*.ts` and `i18n.ts`.
- **Keep** text that carries information found nowhere else: errors and
  warnings such as `No readable repository` with its reason, `Git
  incomplete`, the stale-read warning, and settings or health errors.
- A pane with no rows still shows its title rule, which the reader needs
  in order to find it. It may shrink to just that.

Add the placeholder strings to the hint-scan test from part 2, so that they
cannot come back. Live check: capture the agents area with every agent
hidden (no line at all), and a pane in its empty state.
