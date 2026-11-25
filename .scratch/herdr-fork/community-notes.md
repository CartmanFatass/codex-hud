# herdr community scan (2026-11-25, parked)

Owner, 2026-11-25: HUD stays a standalone package; its herdr-facing parts become a herdr plugin; missing core
capabilities go into the fork. Research is recorded here and parked; current work comes first.

Sources: sonic jdc6de7fe3f0bc0b5 (published projects) and j4d8e88ae3fd245d9 (user-built extras; Reddit blocked
with HTTP 403, not covered). Ecosystem size: ~2,226 repos with topic `herdr-plugin`, ~602 `herdr-layout`;
index: https://github.com/yigitkonur/awesome-herdr. Plugin manifest (`herdr-plugin.toml`) supports actions,
events, startup, panes (split/overlay/tab/popup), link handlers.

## Relevant to HUD

| Item | URL | Takeaway |
|---|---|---|
| herdr-radar | https://github.com/hhdebb/herdr-radar | who works / who waits on you per project; writes managed config blocks for sidebar, tab bar, theme |
| herdr-auto-title, herdr-bar | https://github.com/kryptamine/herdr-auto-title, https://github.com/jeffarese/herdr-bar | readable tab names from branch/process/session; fuzzy jump |
| herdr-claude-usage | https://github.com/aodanchenko/herdr-claude-usage | usage in the tab bar via a tab-bar status command (no fork) |
| herdr-reviewr | https://github.com/persiyanov/herdr-reviewr | diff review pane, comments back to the agent; `worktree.created` event |
| herdr-board, herdr-dagr | https://github.com/nelsonPires5/herdr-board, https://github.com/aemrebarut/herdr-dagr | kanban cards dispatch prompts; agent DAG with review gates |
| memex | https://github.com/nicosuave/memex | transcript search and token tracking (toktrack side) |
| herdr-ohmyzsh | https://github.com/robbyrussell/herdr-ohmyzsh | slow-command sidebar, done notifications |
| upstream asks | herdr issues #318 (attention-priority agent sort), #303 (status dots on tab labels), #1125 (floating popup panes for plugins), #394 (per-space setup: mise trust, direnv, .env) | |

Most common user pains: (1) not knowing which agent needs you, (2) rebuilding the workspace / worktree setup,
(3) keybinding muscle memory, (4) unreadable tab names, (5) leaving the desk / remote review. HUD covers (1);
(4) and (2) apply to HUD worker tabs and managed worktrees. Out of scope (spec: one owner, one machine): phone,
watch and remote relays.

## Parked follow-ups (after herdr-fork/01-04)

- HUD's herdr side as a herdr plugin: panel action + keybinding (split/overlay), watcher as a startup item tied
  to the herdr server, tab-bar status counts, event subscriptions; fork lifts plugin API limits where needed.
- Worker tab names: ticket ID + state instead of "imp Work ticket …".
- Managed worktree setup step (project-configured), replacing ad-hoc `tmp/env.sh` for imps.
- Attention order and status dots on tab labels in the fork (#318, #303).
- Optional: Reddit via `pro` (browser) if the owner wants that source covered.
- Earlier list (after 04): prompt delivery and turn-end events from herdr; per-pane cgroup for worker trees;
  push-only watcher.
