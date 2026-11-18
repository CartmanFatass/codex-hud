# 01: A bar notice says what the job is doing, not which model runs it

**Status:** done (41db1271)
**Blocked by:** none

**What to build:** The notice zone of all three bars (Claude statusline, Codex tmux bar, pi footer) names the work,
not the model. Owner, 2026-11-17: the subagent display is not good enough; drop the model first. Today an item is
`✓ oracle [6.2-astra · high]`; two imps collapse into `◐ imp ×2`.

- [ ] No model and no effort in any notice item, in every bar look (the Stacked look's second row included).
- [ ] A HUD job reads role + job title (the brief's heading, else the package), e.g. `◐ imp 状态栏TPS`.
- [ ] A Claude subagent reads its type + the short description its Agent call gave, e.g. `◐ Explore 找通知生成处`;
      a Codex subagent its name + task when known. Missing facts are left out, never guessed.
- [ ] A finished or failed item carries how long it ran, fixed at the moment it ended (`✓ imp 状态栏TPS 12m`);
      nothing in the zone ticks between refreshes.
- [ ] `×n` groups only items with the same kind and the same words; two different imp jobs show as two items.
- [ ] Narrow bars cut the title at a word before dropping the item; the role/type stays.
- [ ] Main-path tests per client with synthetic transcripts/jobs; frame snapshots updated only where intended.

## Comments
