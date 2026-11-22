# Post-Change Load & Cost Evaluation (2026-11-22)

Follow-up measurement to `docs/llm/orch-load-2026-11-22.md`, `docs/llm/imp-load-2026-11-22.md`, `docs/llm/workers-load-2026-11-22.md`, and `docs/llm/imp-model-cost-2026-11-22.md`, evaluating all changes landed on `2026-11-22` (`ORCH-LEAN-01..05`, `IMP-LEAN-01..06`, `FLOWS-01..05`, `DOGFOOD-FIXES-01..13`, `SONIC-AUTO-THINKING`, `Not checked:` / unverified-facts `sonic` framing, and the `imp` default switch to `agy` `gemini-4-neon-high`).

**Scope & cutoff:** Frozen across:
- **Orchestrator:** `/home/fires/.claude/projects/-home-fires-projects-MyHUD/50360220-831c-4411-9bd4-14e2ebadbf35.jsonl` (`claude-opus-5-5`, `06:22:03Z`–`17:59:14Z`, `1,430` root API turns, `0` sidechain turns, `5` auto-compactions, `291.63M` prompt tokens, `$88.46` API-reconciled at `toktrack` Opus rates: `$2.00` in / `$0.20` cache-read / `$8.00` 1h-cache-write / `$20.00` out per MTok).
- **Workers & flows:** `242` MyHUD jobs in `~/.hud/jobs/*` (`237` created on `2026-11-22`: `218` parsed `pi` sessions incl. `147` MyHUD `sonic` jobs, `2` pre-session `pi` `imp` launch failures, `17` `cli:agy` sessions in `~/.gemini/antigravity-cli/conversations/<agent_session_id>.db`; `3` `2026-11-21` `sonic` startup failures in `~/.hud/archive/2026-11.jsonl`), `18` completed/failed land flows `≤17:59Z` in `~/.hud/flows/*.json`, `tmp/sonic-coverage/{coverage.py,out.json}` (`106` baseline vs `107` live `sonic`→`imp` pairs), and `toktrack daily --json --local-only`. **Per-session `agy` USD cost is not available yet** (`toktrack` reports machine-wide daily `gemini-4-neon` / `gemini-4-carbon` aggregates only; no per-job `agy` USD estimates are fabricated below).

---

## 1. Summary & Comparison Tables

### 1.1 Orchestrator Progression by Phase (`claude-opus-5-5`, `06:22Z`–`17:59Z`)

*Note on rollout timing:* Several `ORCH-LEAN` / `IMP-LEAN` / `FLOWS-01` commits landed during `12:41Z–14:33Z` (`P0b`), but as `DOGFOOD-FIXES-03` discovered, the live `hud` MCP server ran pre-change code until `d8b1f67b` + reconnect around `~14:33Z` (while `.claude/settings.local.json` + `/reload-plugins` took effect at the `13:03Z` compaction). Both `S1 (<12:09Z)` and pooled `Pre-14:30Z` are shown alongside the post-`14:30Z` phases; **`P4 (16:30–17:59Z)`** represents the steady state with `hud_land`, `agy neon`, `ORCH-LEAN-04/05`, and `DOGFOOD-FIXES-09..13` active at normal mid-session context (`203.6k` mean).

| Phase (UTC) | Span | Root Turns (`turns/h`) | Prompt Tok (`MTok/h`) | Mean Ctx | Compacts | Re-est. USD (`$/h`) | Chore Turns `%` (`Tok %`) | Worker Slices Landed | Orch Turns / Slice | Orch Prompt / Slice | Orch USD / Slice |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`P0a: S1` (`<12:09Z`, report baseline)** | `5.61h` | `796` (`141.9/h`) | `164.68M` (`29.4M/h`) | `206.9k` | `3` | `$51.29` (`$9.14/h`) | `72.4%` (`70.4%`) | `38` | `20.9` | `4.33M` | `$1.35` |
| **`P0b: Rollout` (`12:09–14:30Z`, stale MCP)** | `2.31h` | `348` (`150.4/h`) | `79.25M` (`34.3M/h`) | `227.7k` | `1` | `$23.27` (`$10.06/h`) | `67.0%` (`67.0%`) | `16` | `21.8` | `4.95M` | `$1.45` |
| **All Baseline (`<14:30Z` pooled)** | **`8.12h`** | **`1,144` (`140.8/h`)** | **`243.93M` (`30.0M/h`)** | **`213.2k`** | **`4`** | **`$74.56` (`$9.18/h`)** | **`70.7%` (`69.3%`)** | **`54`** | **`21.2`** | **`4.52M`** | **`$1.38`** |
| **`P1` (`14:30–15:15Z`, lean `hud_read` + reload)** | `0.71h` | `62` (`87.8/h`) | `13.71M` (`19.4M/h`) | `221.1k` | `1`\* | `$3.94` (`$5.58/h`) | `56.5%` (`48.1%`) | `3` | `20.7` | `4.57M` | `$1.31` |
| **`P2` (`15:15–15:35Z`, `hud_land` initial)** | `0.30h` | `75` (`246.9/h`) | `6.96M` (`22.9M/h`) | `92.8k` | `0` | `$2.46` (`$8.09/h`) | `66.7%` (`66.4%`) | `3` | `25.0` | `2.32M` | `$0.82` |
| **`P3` (`15:35–16:30Z`, `neon` default + `DF-09`)** | `0.77h` | `62` (`80.4/h`) | `9.32M` (`12.1M/h`) | `150.3k` | `0` | `$2.75` (`$3.56/h`) | `64.5%` (`63.5%`) | `5` *(+1 tiny)* | `12.4` *(10.3)* | `1.86M` | `$0.55` |
| **`P4` (`16:30–17:59Z`, `ORCH-LEAN-04/05` steady)** | **`1.49h`** | **`87` (`58.5/h`)** | **`17.71M` (`11.9M/h`)** | **`203.6k`** | **`0`** | **`$4.76` (`$3.20/h`)** | **`50.6%` (`50.4%`)** | **`10`** | **`8.7`** | **`1.77M`** | **`$0.48`** |
| **All Post-`14:30Z` (`14:30–17:59Z` pooled)** | **`3.49h`** | **`286` (`82.0/h`)** | **`47.70M` (`13.7M/h`)** | **`166.8k`** | **`1`\*** | **`$13.90` (`$3.98/h`)** | **`59.1%` (`54.7%`)** | **`21`** | **`13.6`** | **`2.27M`** | **`$0.66`** |
| **All `hud_land` Era (`15:15–17:59Z` pooled)** | **`2.74h`** | **`224` (`81.8/h`)** | **`33.99M` (`12.4M/h`)** | **`151.7k`** | **`0`** | **`$9.96` (`$3.64/h`)** | **`59.8%` (`57.3%`)** | **`18`** | **`12.4`** | **`1.89M`** | **`$0.55`** |
| **`P4` Steady State vs. `<14:30Z` Baseline** | — | **`-58.5% / h`** | **`-60.3% / h`** | `-4.5%` | `0` in `2.9h` | **`-65.1% / h`** | **`-20.1 pp`** | `+1.1% / h` | **`-59.0%`** | **`-60.8%`** | **`-65.2%`** |

*\*Compaction #5 fired at `15:05:24Z` from context accumulated mostly during `13:03Z–14:45Z` (`Seg 4`); zero compactions occurred over the remaining `2.90h` (`15:05Z–17:59Z`). `P1` and `P2` each contain only `N=3` landed slices, so per-slice ratios inside `P1`/`P2` alone carry high small-sample variance.*

---

### 1.2 Orchestrator Activity Buckets & Tool Payloads (`orch-load` §3.1 Method)

| Bucket / Metric | `P0a (<12:09Z)` (`796` turns) | `Pre-14:30Z` (`1,144` turns) | `Post-14:30Z` (`286` turns) | `P4 (16:30–17:59Z)` (`87` turns) | Change (`Pre-14:30Z → P4`) |
| --- | ---: | ---: | ---: | ---: | --- |
| **1. Code/doc/diff/ticket search & `codegraph`** | `281` (`35.3%` / `31.6%` tok) | `372` (`32.5%` / `29.4%` tok) | `59` (`20.6%` / `18.4%` tok) | `15` (`17.2%` / `15.5%` tok) | **`3.25 → 1.50` turns/slice (`-54%`)** |
| **2. Worktrees, `cherry-pick`, gates, `hud_land`** | `107` (`13.4%` / `20.3%` tok) | `161` (`14.1%` / `21.0%` tok) | `44` (`15.4%` / `21.7%` tok) | `15` (`17.2%` / `26.6%` tok) | **`2.98 → 1.50` turns/slice (`13` `hud_land` + `2` cleanup)** |
| **3. `STATE.md` & `.scratch/` ticket upkeep** | `76` (`9.5%` / `4.9%` tok) | `106` (`9.3%` / `4.5%` tok) | `26` (`9.1%` / `1.4%` tok) | `12` (`13.8%` / `0.9%` tok) | `STATE` automated; manual `tickets: claim` `sed+commit` remains |
| **4. Reading worker reports (`hud_read` / `report.md`)** | `73` (`9.2%` / `10.1%` tok) | `104` (`9.1%` / `9.7%` tok) | `22` (`7.7%` / `6.9%` tok) | **`1` (`1.1%` / `1.9%` tok)** | **`1.93 → 0.10` turns/slice (`-95%`)** via digest notices |
| **5. Misc `Bash` inline scripts (`python3` / `node -e`)** | `39` (`4.9%` / `3.6%` tok) | `66` (`5.8%` / `4.7%` tok) | `18` (`6.3%` / `3.9%` tok) | **`1` (`1.1%` / `1.0%` tok)** | **`1.22 → 0.10` turns/slice (`-92%`)** |
| **Subtotal: Outsourceable Chores (1–5)** | **`576` (`72.4%`)** | **`809` (`70.7%`)** | **`169` (`59.1%`)** | **`44` (`50.6%`)** | **`15.0 → 4.4` chore turns/slice (`-71%`)** |
| **6. Core dispatch & steering (`hud_create`/`send`/`respond`)** | `87` (`10.9%` / `12.5%` tok) | `141` (`12.3%` / `13.3%` tok) | `46` (`16.1%` / `19.3%` tok) | `17` (`19.5%` / `20.4%` tok) | `2.61 → 1.70` turns/slice (`-35%`; batch `jobs[]` still `0`) |
| **7. Owner decisions, grilling & chat status text** | `133` (`16.7%` / `17.1%` tok) | `194` (`17.0%` / `17.4%` tok) | `71` (`24.8%` / `28.5%` tok) | `26` (`29.9%` / `33.7%` tok) | `3.59 → 2.60` turns/slice (`9/26` still `≤240`-char blurbs) |
| **Tool payload & config telemetry:** | | | | | |
| `Bash` calls (`total output KB` / `sleep` polls) | `527` (`723 KB` / `15`) | `748` (`928 KB` / `23`) | `133` (`102 KB` / `1`) | `34` (`32 KB` / **`0`**) | `Bash` KB/h: `114 KB/h → 21 KB/h` (**`-81%`**); `0` `sleep` polls |
| Raw `report.md` `Bash`/`Read` bypasses | `21` | `38` | **`0`** | **`0`** | **`-100%` (fixed by `DOGFOOD-FIXES-06`)** |
| `hud_read` calls (`mean chars` / `mode: "full"` / `batch`) | `57` (`4,612 ch` / `0` / `0`) | `72` (`4,654 ch` / `1` / `1`) | `19` (`3,014 ch` / `8` / `0`) | `1` (`153 ch` / `0` / `0`) | Default digest `<1 KB`; task notices carry 1-line summary |
| `<task-notification>` chars (`med / mean`, `report.md` refs) | `497 / 804 ch` (`53/111`) | `489 / 758 ch` (`71/138`) | `458 / 476 ch` (`2/59`) | `454 / 468 ch` (`0/24`) | **`-38%` mean chars**; report-file path leak eliminated |
| `hud_create` (`isolation:"worktree"` / `context_files` / `jobs[]` / `brief_file` / `scout`) | `61` (`0 / 0 / 0 / 0 / 0`) | `93` (`13 / 14 / 0 / 0 / 0`) | `31` (`25 / 25 / 0 / 0 / 0`) | `15` (`13 / 14 / 0 / 0 / 0`) | `worktree` `0%→87%`, `context_files` `0%→93%`; **`jobs[]`/`brief_file`/`scout` `0%`** |
| `codegraph_explore` / `Monitor` / native `Agent` calls | `7` / `3` / `3` | `7` / `3` / `3` | **`0` / `0` / `0`** | **`0` / `0` / `0`** | **`-100%` across all three** |

---

### 1.3 Orchestrator Compaction Segments (`Seg 0`–`Seg 5`)

| Segment | Window (UTC) | Active Schema Config | Turns | Start → End Ctx | Segment Prompt | `+tok/turn` (`mean / med`) | Compaction Pause |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `Seg 0` | `06:22Z–07:15Z` | Full built-ins + 49 skills (`106.9k` tool ch) | `197` | `57.6k → 366.9k` | `40.20M` | `+1,578 / +1,007` | `73.2s` |
| `Seg 1` | `07:16Z–09:18Z` | Full built-ins + 49 skills (`106.9k` tool ch) | `235` | `73.4k → 366.7k` | `51.72M` | `+1,254 / +942` | `66.5s` |
| `Seg 2` | `09:20Z–10:37Z` | Full built-ins + 49 skills (`106.9k` tool ch) | `211` | `68.7k → 367.1k` | `47.25M` | `+1,421 / +1,098` | `60.5s` |
| `Seg 3` | `10:38Z–13:02Z` | `+Monitor/SendMessage` (`121.0k` tool ch) | `236` | `69.9k → 366.1k` | `52.40M` | `+1,261 / +880` | `73.4s` |
| **`Seg 4`** | **`13:03Z–14:45Z`** | **`.claude/settings.local.json` + `/reload-plugins` (`35.5k` tool ch)** | **`300`** | **`41.0k → 367.2k`** | **`64.67M`** | **`+1,091 / +790`** | **`84.2s`** *(at `15:05Z`)* |
| **`Seg 5`** | **`15:05Z–17:59Z`** | **Lean schemas + `hud_land` (`36.8k` tool ch)** | **`253`** | **`42.5k → 239.4k`** | **`35.89M`** | **`+781 / +634`** | **None (`129k` below cap after `2.9h`)** |

---

### 1.4 Implementer (`imp`) & Non-`sonic` Worker Cohorts (`2026-11-22`, MyHUD Only)

*`IMP-LEAN-01/03` landed at `13:41Z`, `IMP-LEAN-02/04/05` at `13:48Z–13:52Z`, `IMP-LEAN-06` at `14:33Z`, and `imp` switched to `agy` `gemini-4-neon-high` at `15:27Z` (`astra` retained for multi-module/hard slices). Excludes `2` pre-11:00Z `pi` launch failures (`agent_pane_busy`, `pi-role ENOENT`) and `2` jobs started after `17:51Z` still running at cutoff. Dedicated `sonic` tables follow in §2.*

| Role & Cohort | `N` | Turns (`med / mean`) | Model Time (`med / mean`) | Wall Time (`med / mean`) | `s/turn` (`out tok/s`) | `$/job` (`med / mean`) | Turn-0 Tok (`med`) | Wasted T1 | Unasked `STATE` / `archv` | `codegraph` Fails | `sonic` `0`-Polls (`starts`) | 1-Tool `%` (`tc/t`) | `test:mjs` Runs (`jobs`) | Edit Err `%` | `hud_ask` / Job | Report KB (`med`) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `imp`: `pi` `sol-fast` **Pre-`13:41Z`** | `42` | `36.5 / 46.8` | `7.6m / 8.2m` | `10.7m / 11.4m` | `10.5s` (`45.6`) | `$0.74 / $0.94` | `5,889` | `42/42` | `42/42` / `19/42` | `49/49` | `74` (`43`) | `78.3%` (`1.96`) | `84` (`38/42`) | `2.5%` | `0.43` (`18`) | `3.26` |
| `imp`: `pi` `sol-fast` **Post-`13:41Z`**\* | `6` | `44.0 / 50.3` | `7.9m / 9.1m` | `18.0m / 17.5m` | `10.9s` (`41.3`) | `$0.74 / $0.92` | **`4,082`** | **`0/6`** | **`0/6` / `0/6`** | **`0`** | **`1`** (`16`) | **`65.0%` (`2.28`)** | `5` (`3/6`) | `2.1%` | `0.50` (`3`) | `3.31` |
| `imp`: `pi` `astra` **Pre-`13:41Z`** | `14` | `42.5 / 45.4` | `8.3m / 10.4m` | `11.7m / 14.2m` | `13.8s` (`24.4`) | `$2.39 / $3.03` | `5,892` | `14/14` | `7/14` / `3/14` | `4/4` | `14` (`22`) | `80.4%` (`1.83`) | `24` (`12/14`) | `0.0%` | `0.86` (`12`) | `2.34` |
| `imp`: `pi` `astra` **Post-`13:41Z`**\* | `10` | `47.0 / 52.3` | `12.2m / 13.7m` | `15.5m / 18.2m` | `15.7s` (`24.0`) | `$3.36 / $3.72` | **`4,086`** | **`3/10`**\*\* | **`1/10` / `0/10`** | **`0`** | **`4`** (`29`) | **`75.1%` (`2.28`)** | `5` (`5/10`) | `2.7%` | **`1.20`** (`12`) | `3.93` |
| **`imp`: `agy` `neon-high` Post-`15:27Z`** | **`13`** | **`31.0 / 27.9`** | **`10.8m / 12.3m`** | **`15.2m / 15.0m`** | **`26.4s` (`68.6`)** | **N/A per job**\*\*\* | `9,912` | **`0/13`** | **`0/13` / `0/13`** | **`0`** | **`0` (`0`)** | **`47.4%` (`2.71`)** | `18` (`13/13`) | `0.0%` | **`0.08` (`1`)** | `4.35` |
| `reviewer`: `pi` `sol max` (`<14:30Z` only; **`0` post**) | `1` | `25.0 / 25.0` | `13.1m` | `14.1m` | — | `$1.18` | `5,583` | `1/1` | `1/1` / `1/1` | `0/2` | `0` | `64.0%` (`2.52`) | `0` | — | `0` | `7.59` |
| `oracle`: `pi` `astra high` (`<14:30Z` only; **`0` post**) | `2` | `18.0 / 18.0` | `5.1m` | `5.2m` | — | `$1.74` | `5,858` | `2/2` | `2/2` / `1/2` | `2/2` | `0` | `58.3%` (`2.14`) | `0` | — | `0` | `10.92` |
| `general`: `agy` `carbon-high` (`<14:33Z`, studies) | `2` | `35.5 / 35.5` | `28.1m / 28.1m` | `36.0m / 36.0m` | `47.5s` (`88.5`) | N/A per job | `10,198` | **`2/2`**\^ | `2/2` / `0/2` | `0` | `0` (`0`) | `35.7%` (`2.71`) | `0` | — | `0` | `11.64` |

*\*Small-sample note: `sol-fast` post (`N=6`) and `astra` post (`N=10`, routed exclusively to harder multi-module slices) have wide per-slice variance; differences in turn count, `$/job`, and edit error (`2.1%` vs `2.7%`) reflect task hardness/noise, whereas structural step changes (`Turn-0` `-31%`, `T1 brief` `100%→8%` post-`13:52Z`, `STATE`/`archive` reads `88%→3%`, `codegraph` `53→0`, `sonic` zero-polls `88→5`, `sleep` loops `58→0`) are deterministic.*
*\*\*All `3/10` post-`13:41Z` `astra` `T1 brief` reads occurred between `13:41Z` and `13:52Z`, before `IMP-LEAN-02` (`6fc6d5a3`) landed; after `13:52Z`, `pi` `T1 brief` was `1/13` (`>16 KB` brief).*
*\*\*\*Per-session `agy` cost is not available yet. Transcript token counts across the `13` settled `neon` `imp` jobs averaged `4.11M` prompt tokens/job (`0.26M` uncached input + `3.85M` cache-read = `93.8%` cache hit) and `50.6k` output tokens/job (incl. thinking); see §1.6 for `toktrack` daily totals.*
*\^Across all `22` pre-`14:33Z` settled CLI worker sessions on this machine (`2` MyHUD + `20` secondary workspace), `22/22` (`100%`) spent Turn 1 reading only `instructions/<role>.md` + `jobs/<id>/brief.md`; across `13` settled post-`15:27Z` MyHUD `neon` `imp` jobs (`IMP-LEAN-06`), `0/13` (`0%`) wasted Turn 1.*

---

### 1.5 Integration & `hud_land` Intervention Audit (`2026-11-22`)

| Integration Regime | Window (UTC) | Slices Attempted | Zero-Touch Lands (`0` Orch Turns After Call) | Auto Flake Reruns (`DF-09`) | Auto Worker Repairs (`FLOWS-02`) | Auto `main`-Move Replays (`DF-13`) | Orch Interventions Required & Cause |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| **1. Manual `orch` integration** | `06:22–12:55Z` | `39` | `0 / 39` (`0%`) | `0` | `0` | `0` | **`39 / 39` (`100%`)**: manual `cherry-pick`, `Bash` test gate + `sleep` polls, manual `STATE`/ticket commit, manual worktree delete |
| **2. `sonic` gate (`ORCH-LEAN-01`)** | `12:55–15:05Z` | `17` *(14 gates)* | `0 / 17` (`0%`) | `0` | `0` | `0` | **`17 / 17` (`100%`)**: `sonic` ran tests (`$0.006`), but `orch` still fast-forwarded `main`, edited `STATE`/tickets, rebased `HP-02`, and deleted `wt-new` checkouts |
| **3. `hud_land` early rollout** | `15:06–16:40Z` | `9` *(11 calls)* | **`3 / 9` (`33%`)** | `2` | `0` | `0` | **`6 / 9` (`67%`)**: `FLOWS-04` flake + stale-flow retry bug (`DF-09`); `FLOWS-02/03` manual land on `base_head..source` bug (`DF-09`); `DF-09` + `8084d45c` manual lands; `DF-10` & `ORCH-LEAN-04` false `cleanup` failures after push (`DF-11`, `2` manual `git worktree remove`s) |
| **4. `hud_land` post-`DF-11` (`P4`)** | **`16:40–17:59Z`** | **`10` *(11 calls)*** | **`9 / 10` (`90%`)** | **`3`** | **`1`** (`fc62305c`) | **`2`** (`f527e55c`, `f8ea9649`) | **`1 / 10` (`10%`)**: `f97322bb` failed `fast-forward` when `orch` committed `tickets: claim` mid-gate (`1` retry call → `DF-13`). **After `DF-13` landed (`17:24Z`), `4/4` (`100%`) pre-cutoff (+ `2/2` at `18:03–18:05Z` = `6/6`) landed zero-touch.** |

---

### 1.6 Machine-Wide Daily Token & Cost Context (`toktrack daily --json --local-only`)

*Includes all local projects on this machine (`MyHUD` + secondary workspaces); `gemini-4-*` costs in `toktrack` are local list-rate estimates across all `agy` conversations, not per-HUD-job invoices.*

| Date | `claude-opus-5-5` (`reqs / prompt / $`) | `gpt-6.2-sol` + `sol-fast` (`reqs / prompt / $`) | `gpt-6.2-astra` (`reqs / prompt / $`) | `deepseek-v4-1-flash` (`reqs / prompt / $`) | `gemini-4-neon` (`reqs / prompt / toktrack $`) | `gemini-4-carbon` (`reqs / prompt / toktrack $`) | Machine Total `$` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `2026-11-18` | `680` / `142.7M` / `$46.64` | `1,728` / `137.4M` / `$37.94` | `146` / `18.1M` / `$14.75` | `0` / `0` / `$0.00` | `214` / `26.9M` / `$13.66` | `103` / `20.0M` / `$9.27` | `$166.90` |
| `2026-11-20` | `1,255` / `259.5M` / `$83.49` | `2,202` / `233.6M` / `$67.22` | `218` / `22.7M` / `$20.55` | `1,134` / `59.4M` / `$1.67` | `360` / `73.4M` / `$29.56` | `0` / `0` / `$0.00` | `$247.68` |
| `2026-11-21` | `1,186` / `222.0M` / `$73.51` | `2,712` / `256.8M` / `$90.31` | `223` / `24.1M` / `$21.56` | `1,855` / `98.4M` / `$2.59` | `393` / `74.9M` / `$30.98` | `14` / `2.5M` / `$2.63` | `$268.86` |
| **`2026-11-22` *(to ~18:05Z)*** | **`1,378` / `285.0M` / `$85.30`** | **`1,924` / `184.6M` / `$76.10`** | **`1,176` / `98.2M` / `$81.94`** | **`3,542` / `156.6M` / `$4.86`** | **`494` / `81.4M` / `$39.15`** | **`20` / `2.4M` / `$2.67`** | **`$289.64`** |

---

## 2. Dedicated `sonic` Evaluation (`IMP-LEAN-03/04`, Auto-Thinking, `Not checked:`, `from_jobs`, `scout` & Parent Re-Reads)

Changes under test for `sonic` (`mistral/deepseek-v4-1-flash-1017`):
- **`IMP-LEAN-03` (`3048f0d9`, `13:41Z`):** Pushes child `sonic` ready notices into parent `pi` sessions via `custom_message` and removes `"0 checks once"` from `hud_sonic` schema; instructs `imp` to assign non-overlapping reads.
- **`IMP-LEAN-04` (`d647091e`, committed `13:48Z`, landed `~14:06Z`):** Strips `hud_sonic` from `sonic` workers; instructs batched read-only turns (`~20`-turn soft budget, `≤60`-line report); instructs callers to give narrow, named-file briefs; coupled with `IMP-LEAN-02` (`6fc6d5a3`, `13:52Z`) Turn-1 brief inlining and `--no-mcp` startup.
- **`SONIC-AUTO-THINKING` (`f0baa540`, enabled live by `~14:00Z`):** Decision API selects `thinking` (`low` / `high` / `max`, recorded as `thinking_source: "decision"` in `job.json` / `effort_source: "decision"` in `STATUS.json`).
- **`FLOWS-04` (`f1de3c93`, `15:16Z`) & `FLOWS-05` + `Not checked:` (`937a88c1` `15:29Z`, `98150a6e` `15:43Z`):** `hud_create({ scout })` pre-attaches a `sonic` dossier; `sonic.md` requires ending every report with `Not checked:`; `from_jobs` prefixes `sonic` reports with the one-line unverified-facts warning.

### 2.1 `sonic` Performance, Turn Budget, Auto-Thinking & Report Hygiene (`2026-11-22`, MyHUD `N=147`)

*Splitting `child_survey` (read-only code/doc reconnaissance for `imp`) from `child_test` (running `npm run test:mjs` for `imp` near end of slice) and `orch_gate` / `orch_lookup` separates LLM exploration changes from 2.5-minute test-shell wait times.*

| `sonic` Cohort | `N` | Auto-Think (`decision`) & Split (`low/high/max`) | Turns (`med / mean / max`) | `≤20`-Turn Budget | Model Time (`med / mean`) | Wall Time (`med / mean`) | `$/job` (`med / mean`) | Turn-0 (`med`) & T1 Brief | 1-Tool `%` (`tc/t`) | `bash / read / grep` per Job | Report Lines (`med / max`, `≤60L`) | `Not checked:` (`any` / `last line`) |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | --- |
| **All `sonic` `<14:00Z`** | `98` | `6%` (`3 / 88 / 7`) | `29.5 / 31.6 / 109` | `37%` (`36/98`) | `139s / 150s` | `165s / 180s` | `$0.042 / $0.042` | `6,711` (`98/98`) | `55.5%` (`1.44`) | `39.8 / 4.5 / 0.0` | `35.5 / 122` (`93/98 = 95%`) | `1/98` (`1%`) / `0/98` (`0%`) |
| **All `sonic` `≥14:00Z`** | **`49`** | **`100%` (`22 / 25 / 2`)** | **`14.0 / 17.2 / 55`** | **`61%` (`30/49`)** | **`51s / 79s`** | **`141s / 166s`** | **`$0.023 / $0.024`** | **`4,111` (`1/49`)** | **`35.2%` (`1.65`)** | **`25.6 / 1.6 / 0.0`** | **`26.0 / 49` (`48/49`\* `0 >60L`)** | `19/49` (`39%`) / `16/49` (`33%`) |
| **All `sonic` `≥15:30Z`** *(post-`937a88c1`)* | **`17`** | **`100%` (`8 / 7 / 2`)** | **`12.0 / 16.4 / 41`** | **`65%` (`11/17`)** | **`50s / 70s`** | **`124s / 120s`** | **`$0.025 / $0.024`** | **`4,092` (`0/17`)** | **`32.1%` (`1.68`)** | **`24.3 / 1.8 / 0.0`** | **`26.0 / 45` (`16/17`\* `0 >60L`)** | **`16/17` (`94%`) / `15/17` (`88%`)** |
| **`child_survey` `<14:00Z`** | `64` | `6%` (`1 / 61 / 2`) | `37.0 / 42.2 / 109` | `6%` (`4/64`) | `184s / 207s` | `191s / 217s` | `$0.052 / $0.059` | `6,804` (`64/64`) | `51.6%` (`1.48`) | `55.7 / 5.5 / 0.0` | `37.5 / 122` (`59/64 = 92%`) | `0/64` (`0%`) / `0/64` (`0%`) |
| **`child_survey` `≥14:00Z`** | **`27`** | **`100%` (`4 / 22 / 1`)** | **`22.0 / 22.9 / 55`** | **`41%` (`11/27`)** | **`118s / 110s`** | **`127s / 164s`** | **`$0.039 / $0.035`** | **`4,083` (`0/27`)** | **`17.8%` (`1.83`)** | **`38.6 / 2.2 / 0.0`** | **`32.0 / 49` (`27/27 = 100%`)** | `11/27` (`41%`) / `10/27` (`37%`) |
| **`child_survey` `≥15:30Z`**\* | **`9`** | **`100%` (`1 / 7 / 1`)** | **`27.0 / 22.4 / 32`** | **`44%` (`4/9`)** | **`118s / 95s`** | **`123s / 104s`** | **`$0.041 / $0.034`** | **`4,072` (`0/9`)** | **`14.9%` (`1.86`)** | **`37.9 / 2.6 / 0.0`** | **`35.0 / 45` (`9/9 = 100%`)** | **`9/9` (`100%`) / `9/9` (`100%`)** |
| **`child_test` `<14:00Z`** | `9` | `22%` (`2 / 7 / 0`) | `13.0 / 12.8 / 24` | `89%` (`8/9`) | `38s / 45s` | `138s / 128s` | `$0.006 / $0.010` | `6,811` (`9/9`) | `84.1%` (`1.16`) | `12.0 / 1.6 / 0.0` | `26.0 / 51` (`9/9 = 100%`) | `0/9` / `0/9` |
| **`child_test` `≥14:00Z`** | **`14`** | **`100%` (`14 / 0 / 0`)** | **`5.0 / 5.2 / 9`** | **`100%` (`14/14`)** | **`13s / 17s`** | **`147s / 146s`** | **`$0.004 / $0.004`** | **`4,112` (`1/14`)** | **`97.2%` (`1.03`)** | **`4.0 / 0.4 / 0.0`** | **`22.5 / 39` (`13/14`\*)** | `6/14` (`43%`) / `5/14` (`36%`) |
| `orch_lookup` `<14:00Z` / `≥14:00Z`\*\* | `16 / 3` | `6%` → `100%` | `11.0 → 23.0` med | `100% → 33%` | `46s → 130s` | `68s → 139s` | `$0.019 → $0.034` | `6,691 → 4,453` | `71% → 59%` | `7.8 → 26.0` bash | `33 → 15` med (`100% ≤60L`) | `1/16` → `1/3` |
| `orch_gate` (`12:55–14:37Z` interim) | `14` | `36%` (`5` post `low`) | `12.5 / 13.4 / 23` | `93%` (`13/14`) | `36s / 40s` | `206s / 190s` | `$0.006 / $0.006` | `5,645` (`9/14`) | `93.6%` (`1.06`) | `11.3 / 2.0 / 0.0` | `11.0 / 19` (`14/14 = 100%`) | `0/14` / `0/14` |

*\*One `child_test` job had an empty `0`-line `report.md` (`0/49` post-`14:00Z` `sonic` jobs exceeded 60 lines, down from `5/98` up to `122` lines pre-`14:00Z`). `child_survey ≥15:30Z` has `N=9` (all spawned by `pi` `astra` `imp`s, since `agy neon` `imp`s spawned `0` child `sonic`s).*
*\*\*`orch_lookup ≥14:00Z` has `N=3` (noise: three broad multi-directory checks vs quick morning lookups).*

---

### 2.2 Parent `imp` Wait Overhead & Post-Report Re-Read Coverage (`tmp/sonic-coverage/coverage.py` Rerun)

*`coverage.py` measures what repo paths a parent `pi` `imp` reads via `read`/`bash` **after** its child `sonic`'s `report.md` settles (`t0`), comparing against paths cited in `sonic`'s report (`ncited`): `ninter` = cited paths re-read by the parent after `t0`; `nunc` = uncited paths read by the parent after `t0`. Pre-`t0` concurrent overlap is shown alongside.*

| Window / Cohort | Pairs `N` | Cited Paths (`med / mean`) | Pairs Where Parent Re-Read Cited (`ninter > 0`) | Re-Read Cited Paths `ninter` (`med / mean`, `% of cited`) | Uncited Paths Read Post-`t0` `nunc` (`med / mean`) | Pre-`t0` Concurrent Overlap (`% of cited`) | Report Flagged `unchecked` | Parent `0`-Polls (`poll LLM s`) | Parent Blocking Tool Wait (`med/call`, `mean/imp`) |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| `out.json` earlier snapshot (`11-21..11-22 15:27Z`) | `106` | `27.0 / 26.9` | `64 / 106` (**`60.4%`**) | `1.0 / 2.0` (`7.5%`) | `1.0 / 3.2` | — | `10 / 106` (`9%`) | — | — |
| **Live All Pairs `<14:00Z`** | `67` | `31.0 / 30.4` | `40 / 67` (**`59.7%`**) | `1.0 / 2.1` (`7.1%`) | `1.0 / 2.7` | — | `0 / 67` (`0%`) | **`89` (`746s` LLM)** | `2.0s` med / `12.8s` per `imp` (`N=59`) |
| **Live All Pairs `≥14:00Z`** | `40` | `16.0 / 17.7` | `28 / 40` (**`70.0%`**) | `2.0 / 2.4` (`13.7%`) | `7.5 / 6.8` | — | `25 / 40` (`63%`) | **`4` (`46s` LLM, `0` after `14:05Z`)** | **`0.0s` med** / `100.3s` per `imp`\* (`N=13`) |
| **Survey-Only Pairs `<14:00Z`** | `58` | `32.5 / 32.5` | `37 / 58` (**`63.8%`**) | `1.0 / 2.4` (`7.3%`) | `1.0 / 2.9` | `31.4%` (`592/1,885`) | `0 / 58` (`0%`) | — | — |
| **Survey-Only Pairs `≥14:00Z`** | **`26`** | **`23.5 / 24.5`** | **`21 / 26` (`80.8%`)** | **`3.5 / 3.4` (`13.8%`)** | **`10.0 / 9.9`** | **`25.7%` (`164/637`)** | **`17 / 26` (`65%`)** | — | — |
| **Survey-Only Pairs `≥15:30Z`**\*\* | **`9`** | **`31.0 / 32.4`** | **`8 / 9` (`88.9%`)** | **`5.0 / 4.3` (`13.4%`)** | **`12.0 / 12.8`** | — | **`9 / 9` (`100%`)** | — | — |

*\*Why median blocking `hud_sonic` tool wait dropped to `0.0s` while mean/imp rose (`12.8s → 100.3s`): after `IMP-LEAN-03`'s `custom_message` push (`37` pushes across `13` `pi` `imp`s), survey collections returned instantaneously (`0.0s` med), whereas `14/40` post-`14:00Z` child `sonic`s were `child_test` full-suite runners (`~147s` wall) where `imp` intentionally blocked at slice end waiting for `npm run test:mjs`. Meanwhile `agy neon` `imp` (`N=13`) spawned `0` child `sonic`s (`0s` wait).*
*\*\*Small sample (`N=9`, all `astra` parents on multi-module slices).*

---

### 2.3 `sonic` Per-Change Scorecards (`Before → After → Verdict`)

1. **`IMP-LEAN-04` (`d647091e`): No `hud_sonic` tool, batched read-only turns, `~20`-turn soft budget & `≤60`-line report cap**
   - **Before (`<14:00Z`, `N=98` total / `N=64` `child_survey`):** `hud_sonic` exposed to `sonic`; `100%` wasted Turn 1 on `brief.md`; `51.6%` single-tool turns (`1.48` calls/turn) with `55.7` tiny `bash` calls/survey; `child_survey` took **`37.0` med / `42.2` mean turns** (max `109`, only **`6%` `≤20` turns**), `184s` med model time, `$0.052` med/job, and `5/64` reports exceeded 60 lines (max `122`).
   - **After (`≥14:00Z`, `N=49` total / `N=27` `child_survey`):** `hud_sonic` removed (`0` calls); Turn-1 brief reads dropped **`100% → 2%` (`1/49`)**; single-tool turns on `child_survey` plunged **`51.6% → 17.8%`** (`1.83` calls/turn); `child_survey` turns fell **`-41%` (`37.0 → 22.0` med, max `55`; `32` max after `15:30Z`)** with `≤20`-turn compliance jumping **`6% → 41%`** (`61%` across all `sonic`s); model time fell **`-36%` (`184s → 118s` med; `-63%` overall `139s → 51s`)**; cost/job fell **`-46%` overall (`$0.042 → $0.023` med)**; and **`0/49` (`100%`) exceeded 60 lines** (max `49`). Still uses `38.6` `bash` calls vs `2.2` `read` / `0.0` `grep` per survey.
   - **Verdict:** **`improved` (major: ~2× faster & cheaper, 100% `≤60` lines, batching active; `child_survey` sits right at `22` med turns vs `~20` target)**.

2. **`SONIC-AUTO-THINKING` (`thinking_source: "decision"` live)**
   - **Before (`<14:00Z`, `N=98`):** Only `6/98` (`6%`) used `decision`; `88/98` (`90%`) ran at `high` (including `7/9` mechanical `child_test` runners taking `13.0` med turns / `38.3s` model time).
   - **After (`≥14:00Z`, `N=49`):** **`49/49` (`100%`) routed via `thinking_source: "decision"`** (`22` `low` [`45%`], `25` `high` [`51%`], `2` `max` [`4%`]). It routed **`14/14` (`100%`) `child_test` jobs to `low`**, cutting their turns **`13.0 → 5.0` med (`-62%`)** and model time **`38.3s → 13.4s` med (`-65%`)**. On `child_survey`, however, Decision API still picked `high` **`22/27` (`81%`)** of the time (`low` `4/27`).
   - **Verdict:** **`fixed` for mechanical/test `sonic`s; `improved` overall** *(survey classifier remains conservative toward `high`).*

3. **`Not checked:` closing line (`937a88c1`, landed `15:29:20Z`)**
   - **Before:** `<14:00Z`: `1/98` (`1%`) contained `Not checked:` (`0/98` as final line); `14:00–15:30Z`: `3/32` (`9%`).
   - **After (`≥15:30Z`, `N=17` total / `N=9` `child_survey`):** **`16/17` (`94%`) contained `Not checked:` (`15/17 = 88%` as the exact final line)**, and **`9/9` (`100%`) of `child_survey` reports ended with `Not checked:`** (the sole omission was a `child_test` suite runner).
   - **Verdict:** **`fixed`**.

4. **`from_jobs` unverified-facts prefix (`98150a6e`, `15:43Z`) & scouted dispatch `hud_create.scout` (`f1de3c93`, `15:16Z`)**
   - **Before:** `0` `scout` flows; `1` `from_jobs` use on `2026-11-21` without an unverified-facts header.
   - **After:** Both features passed unit/integration gates, **but saw `0 / 31` live MyHUD dispatches** post-`14:30Z` (`orch` passed `context_files` directly on `25/31` dispatches and switched `imp` default to `agy neon`, which reads target files directly on Turn 1).
   - **Verdict:** **`unchanged` / untested live (`N=0` dispatches)**.

5. **`sonic` startup failures & timeouts (`workers-load` §3.1 + `IMP-LEAN-02/04`)**
   - **Before:** `4` pre-`14:00Z` `sonic` startup failures across `24h` (`3` `timed out waiting for agent startup` in `archive/2026-11.jsonl` + `1` `agent_pane_busy` at `09:30Z`); Turn-0 prompt was `6,711` tokens with `pi-mcp-adapter` spawning on every `sonic`.
   - **After (`≥14:00Z`, `N=49`):** `--no-mcp` + stripped `hud_sonic` cut Turn-0 tokens **`-39%` (`6,711 → 4,111`)**; **`0 / 49` (`0%`) startup failures or timeouts** (`0` timeout entries in `watch.log`).
   - **Verdict:** **`fixed`**.

6. **Parent `imp` wait & `timeout_s: 0` polling overhead (`IMP-LEAN-03`)**
   - **Before (`N=59` `pi` `imp`s `<14:00Z`):** `89` `timeout_s: 0` polls wasting **`746.4s` (`12.4m`) of parent LLM time** (`71` poll-only turns); `2.0s` med blocking tool wait.
   - **After (`N=13` `pi` `imp`s `≥14:00Z` + `N=13` `agy neon` `imp`s):** `37` `custom_message` push notices delivered; zero-polls dropped **`89 → 4` (`-96%`, `0` after `14:05Z`, `zpoll` LLM wait `746s → 46s`)** and median `hud_sonic` collection call wait hit **`0.0s`**. Residual blocking tool wait (`100.3s` mean across `13` `pi` `imp`s) is intentional end-of-slice waiting on `child_test` full-suite runs; `agy neon` incurred **`0s`** wait (`0` `sonic`s spawned).
   - **Verdict:** **`fixed`**.

7. **Parent `imp` re-reading files `sonic` already covered (`coverage.py` rerun)**
   - **Before (`<14:00Z`, `N=58` survey pairs):** Concurrent pre-`t0` file overlap was `31.4%` (`592/1,885` cited paths), and **after `sonic` settled (`t0`), `37/58` (`63.8%`) of parent `imp`s still re-read `sonic`-cited files** (`1.0` med / `2.4` mean files, `7.3%` of cited) plus `1.0` med uncited file.
   - **After (`≥14:00Z`, `N=26` survey pairs; `≥15:30Z`, `N=9`):** Pre-`t0` concurrent overlap dipped slightly (`31.4% → 25.7%`), **but post-`t0` parent re-reading rose to `21/26` (`80.8%`) (`8/9 = 88.9%` `≥15:30Z`), averaging `3.5` med re-read cited files (`13.8%` of cited) plus `10.0` med uncited files!** Why: (a) `20/26` post-`14:00Z` survey pairs had `astra` parents on complex slices that verify every file before editing (matching `FLOWS-05`'s rule *"read yourself any code you base a decision on"*); and (b) shorter ~22-turn `sonic` surveys left `unchecked` paths on `65%–100%` of reports, prompting parents to open both unchecked and cited files. By contrast, `agy neon` skipped `hud_sonic` completely (`0/13`) and finished in `31.0` med turns vs `47.0` on `astra`.
   - **Verdict:** **`worse` (`63.8% → 80.8%` post-report re-reading on `pi` `imp`)** — *demonstrates that routine slice `hud_sonic` surveys are structurally redundant when strong `imp` models verify code directly (see §4 Rank 4).*

---

## 3. Per-Problem Evaluation: Orchestrator, `imp` & Other Roles (`Before → After → Verdict`)

### 3.1 Orchestrator Problems (`orch-load-2026-11-22.md`)

1. **Manual slice integration, `cherry-pick`, test-gate polling & worktree cleanup (`orch-load` Rank 1)**
   - **Before:** `19.8%` of turns (`51.34M` prompt tok pre-`14:30Z`), `23` `Bash` `sleep` polls, `0/61` `isolation: "worktree"` before `12:09Z`, `100%` manual `orch` integration (`21.2` turns / `$1.38` per slice).
   - **After:** Deterministic `hud_land` (`FLOWS-01..03` + `DF-09, 11, 13`) drove `P4` (`N=10` slices) to `87%` `isolation: "worktree"`, `0` `sleep` polls, `9/10` (`90%`) zero-touch lands (`6/6 = 100%` post-`DF-13`), and **`8.7` orch turns / `1.77M` tok / `$0.48` per slice (`-65%` USD/slice)**.
   - **Verdict:** **`fixed`**.

2. **Codebase/doc/diff searching, `codegraph_explore` & native `Agent` subagents (`orch-load` Rank 2)**
   - **Before:** `35.3%` of `S1` turns (`51.99M` tok), `7` `codegraph_explore` calls (`6.27M` tok-turns), `3` native `Agent` subagents, `0%` `context_files`.
   - **After:** Global `codegraph` hook removed; `codegraph_explore` and `Agent` dropped to **`0`**; `context_files` reached **`93%` (`14/15` in `P4`)**; search turns/slice fell **`-54%` (`3.25 → 1.50`)** and `Bash` KB/h fell **`-81%`**. Manual `Bash` browsing of `.scratch/` tickets still remains.
   - **Verdict:** **`improved`**.

3. **Turn-0 / post-compaction fixed schema & skill overhead (`orch-load` Rank 3)**
   - **Before:** Post-compaction floor **`68.7k–73.4k` tokens**, `tools` schemas `106.9k–121.0k` chars (`Artifact` + 6 unused built-ins + 49 skills).
   - **After:** `.claude/settings.local.json` + `/reload-plugins` at `13:03Z` cut `tools` schemas **`-70%` (`121.0k → 36.8k` chars)** and post-compaction floor **`-41%` (`70k → 41.0k–42.5k` tok)**, with `+tok/turn` down **`-45%` (`~1,378 → +781`)** and `0` compactions over the final `2.9h`. `Monitor` (`~7.6k` ch, `0` calls) and global plugin MCPs (`~18k` tok) remain.
   - **Verdict:** **`improved`**.

4. **Full worker report reads, bloated `hud_read({})` listings & raw `report.md` `cat`s (`orch-load` Rank 4 + `DF-04, 06`)**
   - **Before:** `38` raw `report.md` bypasses, `hud_read` averaging `4,654` chars, `~130` child `sonic`s in compact listings, `1.93` report-read turns/slice.
   - **After:** Digest `hud_read` + lean listings + pathless notices cut raw `report.md` reads **`38 → 0` (`-100%`)** and `P4` report-reading turns **`1.93 → 0.10` turns/slice (`-95%`)**.
   - **Verdict:** **`fixed`**.

5. **MCP ↔ Panel disconnect (`taskClient`) & mid-wave chat status blurbs (`orch-load` Rank 5 / `ORCH-LEAN-04`)**
   - **Before:** Panel actions skipped `taskClient` sessions; `171` pre-`14:30Z` text-only turns (`40` `≤240` chars).
   - **After:** `ORCH-LEAN-04` (`16:28Z`) wired panel actions and `r`/`m` intents to `taskClient` (`Monitor` = `0`), though `0` owner panel intents were pressed before `17:59Z`, and `SKILL.md:15` still prompts per-job ID blurbs (`9/26` `P4` text-only turns `≤240` chars).
   - **Verdict:** **`improved`**.

6. **Singular-only MCP mutations & inline briefs (`orch-load` Rank 6 / `ORCH-LEAN-05`)**
   - **Before:** `0` batch `hud_create.jobs` / `hud_tickets.updates`, `0` `brief_file`.
   - **After:** `ORCH-LEAN-05` landed at `16:49Z`, **but had `0%` adoption in `P4`** (`0/15` `jobs[]`, `0/15` `brief_file`) because `DF-03` hot-reload does not emit `notifications/tools/list_changed` (leaving `15:05Z` schemas cached in Claude Code) and `SKILL.md` still teaches singular `hud_create`.
   - **Verdict:** **`unchanged` in live load**.

7. **Premature wake before `checks` & `<task-notification>` bloat (`orch-load` Rank 7 / `ORCH-LEAN-03`)**
   - **Before:** Woke before checks finished; `<task-notification>` mean `804` chars.
   - **After:** Held until checks settle; `<task-notification>` mean **`468` chars (`-38%`)**.
   - **Verdict:** **`fixed`**.

8. **Bloated `docs/handoff/STATE.md` (`orch-load` Rank 8)**
   - **Before:** `52.5 KB`, `45` manual `S1` turns.
   - **After:** Slimmed at `12:42Z` and automated by `FLOWS-03`, but `FLOWS-03` appended `15+` lines + `Record landing` commits today, regrowing `STATE.md` to **`29.1 KB`**.
   - **Verdict:** **`improved`**.

---

### 3.2 Implementer, Model-Cost & Other Non-`sonic` Worker Problems (`imp-load`, `imp-model-cost`, `workers-load`)

9. **Unrequested repo & archived doc reads (`imp-load` Rank 1 / `IMP-LEAN-01`)**
   - **Before (`N=56` `pi` `imp`):** `STATE.md` `88%`, `delegation.md` `61%`, `docs/archive/*` `39%`, `spec.md` `77%`, `ARCHITECTURE.md` `93%`.
   - **After (`N=29`: `16` `pi` + `13` `neon`):** **`STATE.md` `3%` (`1/29`)**, **`delegation.md` `3%` (`1/29`)**, **`docs/archive/*` `0%` (`0/29`)**, **`spec.md` `34%`**. `ARCHITECTURE.md` stayed `100%` (`29/29`) because `AGENTS.md`/`.hud/brief.md` require reading §8.
   - **Verdict:** **`fixed`** *(minor residual on `ARCHITECTURE.md` §8).*

10. **Model unit-cost shock: `astra` vs `sol-fast` vs `agy neon` (`imp-load` Rank 2 & `imp-model-cost`)**
    - **Before:** `astra` averaged `$3.40/job` (`N=18`) vs `sol-fast` `$0.91/job` (`N=45`).
    - **After:** `agy gemini-4-neon-high` (`N=13` settled post-`15:27Z`) landed **`13/13` (`100%`) slices** in **`31.0` med / `27.9` mean turns** (`-34%` to `-47%` fewer turns than `sol-fast` `44.0` and `astra` `47.0`), **`2.71` calls/turn** (`47.4%` 1-tool vs `75.1%` `astra`), **`0` child `sonic`s**, and **`0.08` `hud_ask`/job vs `1.00`/job on `astra`**. Per-session `agy` USD is unavailable (`toktrack` daily `neon` = `$39.15` across `494` reqs / `~35` machine-wide jobs); post-change `astra` (`N=10` hard slices) averaged `$3.36` med / `$3.72` mean.
    - **Verdict:** **`improved`**.

11. **Broken CodeGraph MCP in worktrees & Turn-1 `brief.md` waste (`imp-load` Ranks 3 & 6 / `IMP-LEAN-02, 06`)**
    - **Before:** `53/53` (`100%`) worktree CodeGraph failures; `100%` Turn-1 `brief.md` waste on both `pi` (`56/56`) and CLI (`22/22`); `pi` Turn-0 `5,890` tok.
    - **After:** `codegraph` calls **`53 → 0`** (+ emptied user MCP config); `pi` Turn-0 **`5,890 → 4,085` (`-31%`)**; Turn-1 `brief.md` reads **`8%` (`1/13` `>16 KB`) on `pi`** and **`0/13` (`0%`) wasted Turn 1 on `agy neon`** (`CLI` scoped to `5` `hud` MCP tools). `agy` still reads `implementer.md` + `.hud/brief.md` on Turn 1 alongside target files.
    - **Verdict:** **`fixed`**.

12. **`git` raw diff dumps (`imp-load` Rank 4 / `IMP-LEAN-01`)**
    - **Before:** `9.9` `git` calls/job (`30.4 KB`/job output, `1.32` dumps `≥4 KB`/job).
    - **After:** **`5.4` calls/job (`pi`) / `5.2` (`neon`)**, **`8.1 KB`/job (`-73%`)**, `0.19` dumps `≥4 KB`/job.
    - **Verdict:** **`fixed`**.

13. **Full `npm run test:mjs` load, bash `sleep` loops & worker wall time (`imp-load` Rank 7 / `IMP-LEAN-01` + `5330454e`)**
    - **Before:** `58` bash `sleep` loops; `1.93` `test:mjs` runs/job; `10.7m–11.7m` med wall time.
    - **After:** `sleep` loops hit **`0`**, **but** `implementer.md:36` mandated running the full suite in `imp` (`13/13 = 100%` on `neon`, `18` runs) on top of **two** `test:mjs` runs in `hud_land`'s gate (`3–4` full-suite runs/slice), pushing median wall time **up to `15.2m–18.0m`** and causing load-induced test flakes (`DF-02, 07, 09, 12`).
    - **Verdict:** **`fixed` for `sleep` loops; `worse` for redundant full-suite test load & wall time**.

14. **`reviewer` `<150k` context (`IMP-LEAN-05`), `oracle` thinking & `frontend-imp` preset (`workers-load` §3.2–3.4)**
    - **Before:** `reviewer` `249.3k` peak (`$1.18`); `oracle` implicit thinking (`$1.74`); `frontend-imp.json` defaulting to `claude-sonnet-5-5`.
    - **After:** `reviewer.md` updated (`IMP-LEAN-05`) and `oracle.json` pinned to `high` (`N=0` post-change runs for either role today); `frontend-imp.json` still lacks `"active_preset": "neon"`.
    - **Verdict:** **`unchanged` / untested live (`N=0`)**.

---

## 4. Ranked Unconstrained Recommendations (From Current State)

Baseline now is **`P4` (`8.7` orch turns / `1.77M` Opus tok / `$0.48` orch USD per slice) + `agy neon` / `astra` workers + `hud_land`**. Ranked by net gain vs cost:

| Rank | Scope | Recommendation | Implementation Cost | Expected Gain |
| ---: | --- | --- | --- | --- |
| **1** | **Workflow + `implementer.md` + `.hud/project.json`** | **Stop running full `npm run test:mjs` 3–4× per slice.** Revert `implementer.md:36` (and `general.md`/`frontend-implementer.md`) to `docs/delegation.md:24`'s rule: workers run `npm run build && npm run build:test` + **targeted tests for touched paths only** (`test:mjs` only when the brief explicitly asks). In `.hud/project.json` `land.gate`, run `npm run test:mjs` **once** instead of twice (`DOGFOOD-FIXES-09` already reruns failing test files once automatically, and `FLOWS-02` auto-repairs real regressions via the source worker). | **~10 LOC** across 4 doc/JSON files (`0` code LOC; no spec change) | **`-4 to -6 min` wall time per `imp` job (`-30%`)**, **`-1.5 to -2 min` per `hud_land` (`-45%` gate time)**, **`-65%` machine CPU test contention** (eliminating load-18 test flakes and `child_test` `sonic` waits), and `-2 to -4` worker turns/job. |
| **2** | **Workflow + `hud_tickets` + `SKILL.md`** | **Abolish git-committed `tickets: claim` commits (and post-land `git pull`) on `main`.** `HOME-PROGRESS-02` (`037a8bd9`) already derives live claimed/active ticket state from running HUD jobs at read time, and `hud_land` commits `ready-for-human` + SHA on land. Stop running `Bash` `sed -i 's/ready-for-agent/claimed/' && git commit` before dispatches and `git pull --ff-only` after local `hud_land`. Add `hud_tickets({ op: "ready" })` returning unclaimed, unblocked ticket paths + 1-line summaries directly for `brief_file`. | **~35 LOC** in `src/mcp/local-tickets.ts` + 6 lines in `delegation.md` / `SKILL.md` | Eliminates `P4`'s #1 remaining `Bash` chore (`12/87` turns = **`-14%` of remaining `orch` turns**, saving `~1.2` turns/slice, `~$3–$4/day`) and removes **100% of mid-gate `main`-moved collisions**. |
| **3** | **MCP Reload (`DF-03`) + `SKILL.md`** | **Activate `ORCH-LEAN-05` batch `hud_create({ jobs, brief_file })` & silence per-job chat IDs.** (a) Emit MCP `notifications/tools/list_changed` when the stdio reload proxy (`d8b1f67b`) swaps to a newer `dist/` build stamp so Claude Code refreshes tool schemas without `/mcp` reconnect. (b) Update `integrations/skills/hud-delegate/SKILL.md` to use `hud_create({ jobs: [{ role, ticket, brief_file, isolation: "worktree" }] })` for multi-slice waves and drop line 15's *"Tell the user in one line: role, job id"* when the panel is active. | **~25 LOC** in `packages/hud-mcp` stdio proxy + 15-line `SKILL.md` edit | Cuts `P4`'s dispatch + chat-blurb turns (`43/87` turns) by **`~35%–45%`**, bringing `orch` from **`8.7 → ~5.5` turns/slice (`~1.1M` tok / `~$0.30` per slice, `-$4 to -$6/day`)**. |
| **4** | **Roles + `implementer.md` + `spec.md` §2.1.4** | **Formalize `agy neon` → `sol-fast` → `astra` routing, restrict `imp → hud_sonic` to wide haystack searches (`>15` files), and record per-job `agy` tokens.** (a) Update `spec.md` §2.1.4 & `delegation.md:89` to make `neon` primary (`31` med turns, `0.08` questions/job, `13/13` green), `sol-fast` fallback (`$0.74` med), `astra` for hard slices (`<15%`), and set `"active_preset": "neon"` in `frontend-imp.json`. (b) Because `coverage.py` shows `pi` `imp` re-reads cited files on **`80.8%`** of post-`14:00Z` `sonic` surveys anyway (while `neon` needed `0` `sonic`s), change `implementer.md:25` from *"Start `hud_sonic` for facts from files you won't edit"* to *"Use native `grep`/batched `read` when `context_files` or `<10` files cover the slice; start `hud_sonic` only for broad repo-wide caller sweeps"*. (c) Parse `agy` `transcript.jsonl` token totals into `archive/YYYY-MM.jsonl` on close. | **~45 LOC** in CLI archive + 8 lines in `implementer.md`, `spec.md`, `delegation.md`, `frontend-imp.json` | Saves **`~$2.20–$2.60/job`** vs `astra` + **`~1.5` Opus Q&A turns/job**, eliminates redundant `sonic` spawn + post-report re-read cycles on routine `pi` slices (`-4 to -6` `imp` turns + `-$0.04` `sonic`), and gives exact per-job `agy` token accounting. |
| **5** | **`dispatchCli` + `.hud/brief.md`** | **Inline `instructions/<role>.md` + `.hud/brief.md` into Turn-0 user message for CLI workers lacking `--append-system-prompt`, and inline `ARCHITECTURE.md` §8's 30-line checklist into `.hud/brief.md`.** Removes `13/13` `agy` Turn-1 reads of `implementer.md` + `.hud/brief.md` and `29/29` routine worker reads of `docs/ARCHITECTURE.md`. | **~25 LOC** in `src/mcp/thin-main.ts` (`dispatchCli`) + 25 lines in `.hud/brief.md` | Saves **`-0.3M to -0.6M` prompt tok/job (`-8%` to `-12%` worker context residency)** across both `agy` and `pi` workers. |
| **6** | **Claude Code Config + `CLAUDE.md`** | **Finish Turn-0 schema pruning (`41k → ~22k` tokens).** Add `"Monitor"` to `.claude/settings.local.json` `permissions.deny` (redundant after `ORCH-LEAN-04`), disable unused global MCP plugins (`Claude_Docs`, etc.) for this repo, and remove `<claude-mem-context>` (`CLAUDE.md:1-12`). | **5 min config/doc edit** (`0` code LOC) | Saves **`~15k–18k` prompt tokens on every Opus turn** (`-9%` to `-11%` of `P4` context, **`~$2–$3/day`**). |
| **7** | **Spec §2.2.4 / §5 + `hud_land` (`FLOWS-03`)** | **Retire per-slice `STATE.md` appends and the separate `Record landing` commit.** Fold `.scratch/<slug>/issues/<NN>.md` `ready-for-human` + `Landed: <sha>` into the landed slice commit, read `Progress` / `TryBriefs` directly from `.scratch/` tickets (extending `HOME-PROGRESS-02`), and checkpoint `STATE.md` (`<5 KB`) only at milestone boundaries. | **~80 LOC** in `land-runner.ts` + `state-ledger.ts`; **touches `docs/spec.md` §2.2.4 & §5** | Halves `main` commit churn (`1` commit/land instead of `2`), stops `STATE.md` regrowing (`29.1 KB` already), and eliminates `STATE.md` merge conflicts permanently. |
| **8** | **`sonic` Instructions & Feature Pruning (`FLOWS-04`)** | **Switch `sonic.md` to native `grep`/`read` over `bash` (`38.6` `bash` vs `0.0` `grep` today), tune `SONIC-AUTO-THINKING` prompt so narrow caller lookups pick `low` (`81%` of surveys still pick `high`), and remove `hud_create.scout` (`FLOWS-04`) if still `0%`-used after 1 week.** | **10 lines** in `sonic.md` + auto-thinking prompt (optional **`-180 LOC` removal** if `scout` retired; **touches `spec.md` §2.1.4**) | Cuts remaining `sonic` survey latency another **`~40%–50%` (`118s → ~50–65s`)** and removes unused flow/card code if `context_files` completely supersedes `scout`. |

---

## 5. Open Questions for the Owner

1. **Single-gate testing (Rank 1):** Revert `implementer.md:36` to targeted tests + `build` in `imp` and cut `.hud/project.json` `land.gate` from two `npm run test:mjs` runs to **one** (relying on `DF-09`'s targeted flake rerun)?
2. **Narrowing `imp → hud_sonic` (Rank 4):** Given `coverage.py` shows `pi` `imp`s re-read `sonic`-cited files on `81%` of post-`14:00Z` surveys (while `neon` needed `0` `sonic`s), restrict `implementer.md`'s `hud_sonic` guidance to broad repo-wide sweeps (`>10–15` candidate files) instead of every slice?
3. **Zero-commit ticket claiming & single-source `STATE.md` (Ranks 2 & 7 — `docs/spec.md` §2.2.4, §5):** Drop `tickets: claim` git commits immediately, and fold landing metadata into the slice commit while retiring per-slice `STATE.md` `try` rows?
4. **`imp` & `frontend-imp` model policy (Rank 4 — `docs/spec.md` §2.1.4):** Make `agy gemini-4-neon-high` the documented `imp` and `frontend-imp` default (`sol-fast` fallback, `astra` for hard slices)?
5. **Silent waves & `hud_create.scout` (Ranks 3 & 8 — `docs/spec.md` §2.1.4):** Drop `SKILL.md:15` per-job ID chat blurbs during waves, and keep `scout` (`0/31` uses today) for another week or remove it in favor of `context_files`?
