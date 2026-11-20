# 02: One meaning per key, no repeated status, 40-column rows keep the identifying part, one language

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** the owner's UI/UX review 2026-11-19, items 5–8.

- [ ] A key means one thing per page (today `n` flags and jumps to the next question; `+`/`-` resize Split and
  add/remove places); the footer shows the keys the selected row accepts.
- [ ] A row does not show its state twice (`提问中 … 提问中 0分钟`, `完成` twice).
- [ ] At 40 columns the identifying part survives: model short names, preset tags out of the role row, two lines
  before a middle cut (Control plane `gpt-6…sol`, `[defau…`; Home `评审中 ·…`).
- [ ] Fixed UI words follow the panel language (`Question:`, `unparseable JSON`, `雷达`, `（无 key）`); quota
  figures say used or left.

- [ ] Seen live after 01: a Home job row shows `[完成] 完成 7分钟` (a bracketed keyword mark plus the state word
  again); a briefed to-try row with a long ID keeps only ~8 characters of its sentence (`SUPERVISOR-MCP  修复了 CLI
  wo…`): give the sentence the room it needs (for example its own line under the ID) while the row stays compact.

## Comments
