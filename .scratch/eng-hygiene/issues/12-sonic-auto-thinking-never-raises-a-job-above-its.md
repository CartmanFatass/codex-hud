# 12: Sonic auto thinking never raises a job above its preset's thinking level

**Status:** wontfix
**Owner try:** no
**Blocked by:** none

**What to build:** With `sonicAutoThinking: true`, `src/mcp/sonic-thinking.ts` lets the Decision API pick any of none/low/high/max from the role's thinking choices, independent of the chosen preset. On 2026-11-25 every hmasd labelling job got `max` (thinking_source: decision) although all owner Sonic presets set `thinking: high` (`~/.hud/roles/sonic.json`: deepseek, haiku, luna high; fast low). On haiku, max produced ~13k reasoning tokens per turn, context overflow at ~296k tokens and pi compaction summaries (run at the session thinking level) that exceeded the stall window (see eng-hygiene/10). Owner decision 2026-11-25: haiku should run at high, not max. Make the preset's configured thinking the ceiling for automatic Sonic thinking: the decision may pick that level or lower, never higher; offer only levels ≤ the ceiling as choices (skip the decision call if only one remains). Record the ceiling in the job route/diagnostics so it is visible why a level was chosen. A preset without a thinking level keeps today's behaviour. Update docs/reference.md where Sonic thinking is described.

- [ ] A Sonic job on a preset with thinking `high` never runs above high under auto thinking; choices offered to the Decision API exclude higher levels.
- [ ] A preset with `low` caps at low; a preset without a level is unchanged.
- [ ] Job diagnostics show the ceiling.
- [ ] Tests cover the ceiling, a single remaining level (no decision call) and the unchanged path.
- [ ] Land gate passes.

## Comments

- 2026-11-25 owner: wontfix. Thinking level is a difficulty judgement and `max` stays selectable; capping it or rewriting the criteria because of context hands hard tasks to low thinking. The fault was task sizing: the hmasd chunks (120 KB) were too large for one job at `max`. Fix = split the input (now ≤60 KB per chunk). The imp job jf38b039b7ed84dad was stopped without commits.
