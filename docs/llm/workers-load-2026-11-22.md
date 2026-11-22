# Non-`imp` Workers Load & Optimization Study: `sonic`, `reviewer`, `oracle`, `frontend-imp`, `general` (2026-11-22)

Companion study to `docs/llm/orch-load-2026-11-22.md` and `docs/llm/imp-load-2026-11-22.md`. Aggregate analysis of all non-`imp` HUD worker sessions across the same ~24h window (`116` parsed `sonic` jobs [`24` orchestrator-dispatched + `92` child-of-`imp`], `5` `reviewer` jobs, `2` `oracle` jobs, `1` `frontend-imp` job, `2` `general` jobs, plus failed startups) cross-checked against 5-day historical MyHUD sessions (`2026-11-18` to `2026-11-22`). Contains aggregates and categories only.

## 1. Executive Summary

- **Aggregate 24h non-`imp` `pi` worker footprint (`123` parsed `pi` sessions):**
  - **`sonic` (orchestrator-dispatched, `N=24`, `deepseek-v4-1-flash`):** Lean and fast — median **`12.0` turns**, **`69s` wall time**, **`15.4k` peak context**, **`$0.009/job`** (`$0.37` total), `1.9 KB` median report, **`0` unrequested repo doc reads**.
  - **`sonic` (child-of-`imp`, `N=92`, `deepseek-v4-1-flash`):** Bloats by **3×–7×** — median **`35.5` turns** (mean `40.9`, max `109`), median **`210s` wall time** (mean `251s` = `4.2m`, max `706s` = `11.8m`), median **`74.2k` peak context** (max `206k`), **`197.80M` prompt tokens** (`$5.31` total), `6.8 KB` median report. Slow child `sonic`s directly trigger `imp`'s `92` empty polling turns.
  - **`reviewer` (`N=5`, `gpt-6.2-sol max`):** Context-bound and slow — median **`231.0k` peak context** (`246k`–`249k` on MyHUD, right below the `272k` 2× tier cliff), **`2` compactions**, **`4` cache drops (`$0.56`)**, **`91.8%` cache hit** (**`51.5%` of spend is uncached input**), median **`843s` (`14.1m`) wall time** (`93.6%` LLM thinking), **`$1.18` median / `$1.39` mean** (`$6.95` total).
  - **`oracle` (`N=2` in 24h, `N=8` in 5-day history, `gpt-6.2-astra`):** Most expensive per token (`$8 / $0.40 / $40` per MTok) — 5-day median **`$1.91`** at `high` (`n=5`, `18` turns, `331s`) and **`$3.56`** at `max` (`n=3`, `26` turns, `573s`). **`50.4%` of spend is uncached input** because short sessions do direct `read`/`git_read` instead of receiving pre-packed `sonic` facts.
  - **`frontend-imp` (`N=1`) & `general` (`N=2`):** Ran via `cli:agy` (`gemini-4-neon-high` / `gemini-4-carbon-high`); `frontend-imp.json` still defaults to `cli:claude claude-sonnet-5-5 xhigh` (inheriting Claude Code's `~57k` fixed schema overhead if invoked without `preset: neon`), and CLI workers incur a mandatory Turn-1 double-read of `<instructions.md>` + `<brief.md>`.
- **Four shared platform changes** (root `AGENTS.md` / `CLAUDE.md` cleanup, automatic `--no-mcp` when `cwd/.codegraph` is absent + role tool filtering, short `brief.md` Turn-1 inlining, and child `sonic` completion push via `custom_message`) optimize **`imp` and every non-`imp` role simultaneously**.

---

## 2. Cross-Role Load Comparison

### 2.1 24h Non-`imp` `pi` Worker Summary

| Role | `N` | Model (`thinking`) | Turns (`med / mean`) | Wall s (`med / mean`) | LLM Share | Mean Prompt / Med Peak | Cache Hit | `$/job` (`med / mean`) | Total `$` | Med Report |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `sonic` (`from orch`) | 24 | `deepseek-v4-1-flash` (`high`/`max`/`low`) | `12.0 / 11.8` | `69 / 84` | `63.9%` | `0.32M / 15.4k` | `93.3%` | `$0.009 / $0.015` | `$0.37` | `1.9 KB` |
| `sonic` (`child of imp`) | 92 | `deepseek-v4-1-flash` (`high` 84) | `35.5 / 40.9` | `210 / 251` | `86.3%` | `2.15M / 74.2k` | `97.1%` | `$0.053 / $0.058` | `$5.31` | `6.8 KB` |
| `reviewer` | 5 | `gpt-6.2-sol` (`max`) | `25.0 / 33.6` | `843 / 807` | `93.6%` | `4.39M / 231.0k` | `91.8%` | `$1.184 / $1.391` | `$6.95` | `7.4 KB` |
| `oracle` | 2 | `gpt-6.2-astra` (`high`) | `18.0 / 18.0` | `314 / 314` | `97.6%` | `1.31M / 106.6k` | `91.7%` | `$1.735 / $1.735` | `$3.47` | `11.2 KB` |

### 2.2 5-Day Historical MyHUD `reviewer` / `oracle` / `sonic` Cohorts (`2026-11-18` – `2026-11-22`)

| Role | Model | Thinking | `N` | Turns (`med / mean`) | Mean Prompt | Med Peak Ctx | Med LLM s | `$/job` (`med`) | Total `$` |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `oracle` | `gpt-6.2-astra` | `high` | 5 | `18.0 / 19.0` | `1.25M` | `101.2k` | `331s` | `$1.912` | `$8.27` |
| `oracle` | `gpt-6.2-astra` | `max` | 3 | `26.0 / 24.3` | `2.80M` | `188.0k` | `573s` | `$3.555` | `$10.58` |
| `reviewer` | `gpt-6.2-sol` | `max` | 2 | `36.5 / 36.5` | `5.38M` | `248.1k` | `964s` | `$1.602` | `$3.20` |
| `reviewer` | `gpt-6.2-sol` | `xhigh` | 10 | `31.5 / 31.1` | `3.60M` | `197.2k` | `557s` | `$1.015` | `$9.60` |
| `sonic` | `deepseek-v4-1-flash` | `high` | 91 | `32.0 / 35.6` | `1.78M` | `67.8k` | `163s` | `$0.047` | `$4.52` |
| `sonic` | `deepseek-v4-1-flash` | `low` | 6 | `4.0 / 12.7` | `0.32M` | `7.3k` | `14s` | `$0.003` | `$0.08` |
| `sonic` | `deepseek-v4-1-flash` | `max` | 10 | `10.5 / 34.8` | `2.23M` | `9.1k` | `27s` | `$0.005` | `$0.46` |

---

## 3. Per-Role Forensics & Specific Recommendations

### 3.1 `sonic` (Latency, Turn Explosion & Startup Reliability)

**Observed inefficiencies:**
- **Tiny sequential `bash` loop explosion in child `sonic`s:** The `92` child-of-`imp` `sonic` jobs executed **`4,768` `bash` calls (`51.8`/job, `75.4%` of residency)** — `3,984` small `sed -n` / `ls` / `wc -l` / `grep` shell calls (`3,671s` cumulative) — vs only `503` `read` calls and `3` native `grep` calls. The worst run hit `109` turns, `140` `bash` calls, `206k` peak context, and `706s` (`11.8m`), with `17` upstream `fetch failed` error turns across the cohort.
- **Unscoped research briefs from `imp`:** Unlike `orch`'s targeted briefs (`12` turns, `69s`, `1.9 KB` report), `imp` often hands `sonic` broad open-ended surveys, yielding `6.8 KB` median reports (nearly `3.6×` `sonic.md`'s 60-line cap) and `74.9%` file-read overlap with the parent `imp`.
- **Unused tool & MCP overhead + startup timeouts:** `sonic` registers `hud_sonic` despite being forbidden from spawning children (`"Sonic cannot start children"`), still loads `pi-mcp-adapter` + `codegraph` (`0/6` succeeded in worktrees), starts at `6,710` Turn-0 tokens, wastes `116/116` (`100%`) Turn 1s reading `brief.md`, and suffered **`4` startup failures** in 24h (`3` `timed out waiting for agent startup`, `1` `agent_pane_busy`).
- **Fixed `thinking: high`:** `~/.hud/roles/sonic.json` forces `high` on every job; historical `low` runs completed in **`14s` median** vs **`163s`** at `high`.

**Recommendations:**
1. **Strip unusable tools & dead MCP on `sonic`:** Omit `hud_sonic` from `workerTools()` when `job.role === 'sonic'` (`packages/hud-mcp/bin/worker-tools.mjs`), and pass `--no-mcp` when `cwd/.codegraph` does not exist (`src/mcp/thin-main.ts`) to cut startup latency and timeout failures.
2. **Batch commands & cap turn budget (`packages/hud-mcp/instructions/sonic.md`):** Instruct `sonic` to batch read-only inspections (parallel `read`/`grep` or one compound shell command per turn instead of 100 tiny `sed`/`ls` turns), enforce a soft `~15–20` turn budget (report gathered facts + unchecked paths if exceeded), and keep reports strictly ≤60 lines.
3. **Narrow `imp → sonic` briefs (`packages/hud-mcp/instructions/implementer.md`):** Pass explicit files/symbols/questions rather than whole-repo archaeology, or split into 2 narrow parallel `sonic`s.
4. **Enable `SONIC-AUTO-THINKING` (or route mechanical lookups to `low`):** Cuts child `sonic` wall time from `3.5–11m` down to `~30–90s`, directly shrinking parent `imp` wait & poll overhead.

---

### 3.2 `reviewer` (Context Ceiling, Compaction & High-Context Polling)

**Observed inefficiencies:**
- **231k–249k peak context ceiling:** Both MyHUD milestone/focused reviews peaked at `246k`–`249k` tokens — just below `gpt-6.2-sol`'s `272k` 2× tier cliff — and `2/5` reviews triggered compaction (`246k → 17k` at T16; `231k → 39k` at T34) plus `4` cache drops (`$0.56`). Cache hit fell to `91.8%`, leaving **`51.5%` (`$3.58 / $6.95`) of spend in uncached input**.
- **Raw diff ingestion + boilerplate docs:** `5` reviews ran **`118` `git_read` calls (`23.6`/review, `41.9%` residency)** pulling multi-commit diffs directly into one context, `265` `read` calls (`45.8%` residency, `11` duplicate reads), and still read `CLAUDE.md` (`13`), `docs/archive/cloud/*` (`7`), `STATE.md` (`4`), `AGENTS.md` (`4`), and `delegation.md` (`3`). *(Positive signal: in the main checkout, `mcp__codegraph__codegraph_explore` succeeded **`16/16` (`100%`)**, contributing `8.3%` useful residency.)*
- **Expensive `hud_sonic` polling:** `19` `timeout_s: 0` polls across `5` reviews (**`3.8` wasted turns/review**, executed at `~150k–230k` context).
- **`thinking: max` latency vs `xhigh`:** In 5-day MyHUD history, `gpt-6.2-sol` at `max` took **`964s` (`16.1m`) / `$1.60`** vs **`557s` (`9.3m`, `-42%`) / `$1.02` (`-37%`)** at `xhigh`.

**Recommendations:**
1. **Fan out milestone diff inspection to parallel `hud_sonic` scouts (`packages/hud-mcp/instructions/reviewer.md`):** Supply `git diff --stat` + one-line design intent per slice in the review brief; have `reviewer` launch `2–4` parallel `sonic` scouts by subsystem/axis (spec checks, caller impact, test assertions) and read only the core changed files itself, keeping peak context `<150k` (avoiding compaction and the `272k` 2× tier).
2. **Tier review thinking/speed (`~/.hud/roles/reviewer.json`):** Use `gpt-6.2-sol-fast` or `gpt-6.2-sol` `xhigh` for focused reviews and post-repair re-reviews (`~40%` faster, `~35%` cheaper); keep `max` for full milestone reviews.
3. **Apply shared fixes:** Clean root `AGENTS.md`, inline `brief.md` (`5/5` Turn-1 waste), and eliminate `hud_sonic` `timeout_s: 0` polling.

---

### 3.3 `oracle` (`$8/MTok` Direct Reads & Implicit Thinking Level)

**Observed inefficiencies:**
- **Half of spend (`50.4%`, `$1.75 / $3.47`) is `$8/MTok` uncached input:** Despite `oracle.md:26` stating *"Your tokens are the dearest: have `hud_sonic` collect `file:line` facts"*, the `2` 24h `oracle` jobs still did `36` direct `read` calls (`64.1%` residency) + `21` `git_read` calls (`35.1%` residency), including unrequested `docs/archive/cloud/*` (`3`), `STATE.md` (`2`), and `delegation.md` (`2`) reads at `$8/MTok`.
- **Worktree & startup friction:** `2/2` Turn-1 `read(brief.md)`, `2/2` failed CodeGraph MCP calls in worktrees, `2` `hud_sonic` polls, and `3/8` `hud_sonic` calls failed mid-build prior to `BUILD-DEDUP-04` (`withDistLock`).
- **Implicit thinking configuration:** `~/.hud/roles/oracle.json` omits `thinking` (inheriting `pi_role: architect` defaults, causing `high` [`$1.91` med] vs `max` [`$3.56` med] drift).

**Recommendations:**
1. **Pre-gather facts via `sonic` + pass `from_jobs` / `context_files`:** Before invoking `oracle`, run a `$0.015` `sonic` scout to assemble a concise `file:line` dossier and attach it via `from_jobs`, cutting `oracle`'s direct `read`/`git_read` spend by **`~40%–50%`** (`$1.9–$3.6 → $0.9–$1.8`).
2. **Pin `~/.hud/roles/oracle.json` explicitly:** Set default `thinking: "high"` with an explicit `max` preset for hard root-cause/architecture forks.
3. **Apply shared fixes:** Clean root `AGENTS.md`, `--no-mcp` in unindexed worktrees, Turn-1 brief inlining, and `hud_sonic` completion push.

---

### 3.4 `frontend-imp`, `general` & CLI Workers (`agy` / `claude` / `codex`)

**Observed inefficiencies:**
- **Default preset mismatch (`~/.hud/roles/frontend-imp.json`):** Default `run` points to `cli:claude claude-sonnet-5-5 xhigh` — which inherits Claude Code's `~57k` Turn-0 fixed schema/skills overhead unless stripped by `.claude/settings.json` — whereas recent UI slices were explicitly routed to `preset: neon` (`cli:agy gemini-4-neon-high`).
- **CLI Turn-1 double-read (`src/mcp/thin-main.ts:746`):** `dispatchCli` sends `"Read <instructions.md> and then <brief.md> and do exactly what the brief asks."`, costing `1–2` startup turns on every CLI worker (`agy`, `claude`, `codex`).
- **Same doc-read trap in instructions:** `packages/hud-mcp/instructions/frontend-implementer.md:11` and `general.md:12` repeat the `AGENTS.md / CLAUDE.md` full-doc-chain and `.codegraph` prompts.

**Recommendations:**
1. Set `"active_preset": "neon"` in `~/.hud/roles/frontend-imp.json` if `agy` `gemini-4-neon-high` is the intended default (or strip global plugins/schemas on Claude Code CLI workers via repo settings / `--strict-mcp-config`).
2. Pass CLI worker instructions via `--append-system-prompt` (where supported) and inline short briefs (`<16 KB`) in `dispatchCli` to remove the 1–2 startup read turns.
3. Align `frontend-implementer.md` and `general.md` with the tightened `implementer.md` doc-read and `git diff --stat` rules.

---

## 4. Shared Cross-Worker Platform Fixes (Fix Once, Benefit All Roles)

| Rank | Tag | Platform Change | Roles Benefiting | Quantified Impact | Files Touched |
| ---: | :---: | --- | --- | --- | --- |
| **1** | **(b)** | **Archive obsolete root `AGENTS.md`, split orchestrator vs worker read lists in `CLAUDE.md`, inline `ARCHITECTURE.md` §8 in `.hud/brief.md`, tighten role `Before you ...` lines** | `imp`, `reviewer`, `oracle`, `frontend-imp`, `general` | Eliminates unrequested `STATE.md`, `cloud/*`, `delegation.md`, full `spec.md` reads across every paid role (`~20%` prompt saved on `imp`; removes `$8/MTok` doc tax on `oracle` & compaction pressure on `reviewer`) | `AGENTS.md`, `CLAUDE.md`, `.hud/brief.md`, `packages/hud-mcp/instructions/{implementer,reviewer,oracle,frontend-implementer,general}.md` |
| **2** | **(a)** | **Auto-pass `--no-mcp` in `dispatchPi` when `cwd/.codegraph` is absent + omit `hud_sonic` from `sonic` workers** | `imp`, `sonic`, `oracle` *(keeps working main-repo CodeGraph on `reviewer`)* | Eliminates `98.6%` (`imp`) and `100%` (`sonic`, `oracle`) worktree CodeGraph failures; speeds up `sonic` startup and cuts `timed out waiting for agent startup` failures | `src/mcp/thin-main.ts:418-420`, `packages/hud-mcp/bin/worker-tools.mjs:204-224` |
| **3** | **(a)** | **Inline short `brief.md` (`<16 KB`) on Turn 1 for `pi` (and instructions+brief for CLI workers where supported)** | All `pi` & `cli` workers | Removes `100%` wasted Turn-1 brief reads (`186` turns/24h across `imp` 63 + `sonic` 116 + `reviewer` 5 + `oracle` 2 — `~8%` of turns on short `orch` `sonic`s) | `src/mcp/thin-main.ts:494,746`, `integrations/pi/package/extensions/hud.mjs` |
| **4** | **(a)+(b)** | **Push child `sonic` completion via `custom_message` + remove `"0 checks once"` from `hud_sonic` tool description** | `imp`, `reviewer`, `oracle`, `frontend-imp` | Eliminates `113` empty poll turns/24h (`92` in `imp`, `19` in `reviewer` at `~200k` context, `2` in `oracle` at `$8/MTok`) | `packages/hud-mcp/bin/worker-tools.mjs:219`, `integrations/pi/package/extensions/hud.mjs` |

---

## 5. Open Decisions for the Owner

1. **Child `sonic` turn/report budget & auto-thinking:** Enforce a soft `~15–20` turn budget + batched read-only commands in `sonic.md`, and turn on `SONIC-AUTO-THINKING` (so simple lookups drop from `~163s` to `~15–30s`)?
2. **`reviewer` tiering:** Default focused/re-reviews to `gpt-6.2-sol-fast` or `gpt-6.2-sol` `xhigh` (`-40%` wall time, `-35%` cost), keeping `max` for milestone reviews?
3. **`oracle` pre-packing & explicit thinking:** Require a `$0.015` `sonic` fact dossier via `from_jobs` before `oracle` runs, and pin `~/.hud/roles/oracle.json` to explicit `thinking: "high"` (with a `max` preset)?
4. **`frontend-imp` default preset:** Make `neon` (`agy gemini-4-neon-high`) the active preset in `~/.hud/roles/frontend-imp.json`, or keep `cli:claude` with stripped repo-scoped Claude settings?
