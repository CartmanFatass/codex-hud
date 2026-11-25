# 16. Control “今日派发”按运行位置（harness / model）拆分的只读健康统计（§3.8a 精简版）

> **优先级**：P3（只读展示，owner 手动切换位置时有据可依） ｜ **类别**：面板 Control / 只读采集 / 渲染 ｜ **预估规模**：S（1 个垂直切片，源码 ~+60 / -5 行，测试 ~+70 行） ｜ **前置依赖**：无功能依赖，不需要新增记录。冲突风险：PRIMITIVES（提案 05）改 `control-radar.ts:34-58` 的有界读与 `control-view.ts:26` 的 `shortModel`；共享 job 索引（提案 08，如排期）会重写 `roleRadar` 的 job 扫描；MONITOR-STATE-01..04（提案 04）与 PRUNE-OBS-02..04 改 `src/render/` 与 `src/collectors/`，包括 `control-page.ts`。建议排在 PRIMITIVES-01..03 之后，或在面板 lane 空档期单独落地 ｜ **`docs/spec.md` 边界影响**：一处措辞扩展（spec:103 “today's per-role dispatch health” 改为 “today's per-role dispatch health, split by place”），需 owner 认可；不改变任何路由规则

---

## 1. 背景与现状证据

行号以 `f0baa540` 为准。

### 1.1 路由规则只认事实，不认“健康分”

spec:13 规定一个位置只有三种情况会被跳过：配额耗尽（到解析出的重置时间，或 1 小时）、启动在 worker 接受输入前失败（只跳过本次派发，并在结果中列出尝试过的位置），以及 owner 在控制面关闭它（`harnesses.json` 的 `disabled`）。同一行还规定 “Only facts end a CLI job”，安静 job 的 “fail” 选项只在屏幕引文是配额或限流消息时成立。owner 的长期原则是 HUD 只记录、不干预模型行为。因此原提案 §3.8 中“连续 2 次挂起或超时就自动降级到备用位置”与 spec 冲突，本提案不做。

### 1.2 现有“今日派发”只按角色汇总

- `src/collectors/control-radar.ts:11`：`RoleRadar { total, ok, failed, quietEscalated, avgMinutes }`。
- `:115-137` `roleRadar`：按出生时间取最近 200 个 job 目录（`:118`），读 `job.json` 与 `STATUS.json`，**只按 `row.role` 分组**；`:127` 读 `STATUS.quiet_decision.action` 计入 `quietEscalated`。
- `:140-143`：整次采集有 5 秒闸门；`:34-56` 的 `read` 按文件签名缓存解析结果。
- `src/render/control-view.ts:216-220` `roleToday` 与 `:221-238` `radarRows`：详情模式下在 “Dispatch today”（`src/render/i18n.ts:278` “今日派发”）小节下每个角色一行。
- 调用点：`src/render/control-page.ts:151`（Control 的 Usage 折叠区）、`:109`（角色详情的 `today` 行），以及 `src/render/split-project.ts:205`。

### 1.3 按位置拆分所需的数据都已记录

`job.json` 中已有（`src/mcp/thin-main.ts`）：

| 字段 | 定义 | 写入 | 含义 |
|---|---|---|---|
| `attempts[]` | `:62` `LaunchAttempt { index, place, reason? }` | `:1336` 创建，`:1375-1376` 写入 | 本次派发依次尝试的位置（`describePlace` 文本），失败的带 `reason` |
| `used_place` | `:98` | `:1377` | 实际接手 job 的位置 |
| `place` / `place_key` / `model` | `:91-92`（`model` 在 `:1344` 写入） | 派发时 | 早期没有 `attempts` 的 job 可由此回推位置 |
| `exhaustion_marked` | `:93` | `:765-768` | 该 job 的失败已把其位置标为配额耗尽 |

`src/roles/exhausted.ts:41-46` 的 `ExhaustedMark` 只记录**当前**被跳过的位置，不记录今天发生过几次。所以“今天哪个位置启动失败了几次、哪个位置跑的 job 失败或转交主会话最多”，这些数据都在磁盘上，只是没有显示出来。

### 1.4 为什么值得做

owner 在 Control 中手动切换预设或关闭位置（spec:13）。现在他只能看到“imp 今天 3✓ 2✗”，看不出失败集中在哪个位置，要逐个 `hud_read` 看 `attempts`。按位置拆分后，“该关掉哪个位置”有了直接依据，而决定仍由 owner 做。

---

## 2. 目标与非目标（Scope / Out of Scope）

### 目标（Scope）
1. 在 `RoleRadar` 中增加按位置的子统计：启动次数、启动前失败次数、结算为 ok 或 failed 的次数、转交主会话次数、配额标记次数。
2. 在 Control 的 “Dispatch today” 详情中，每个角色行下面列出各位置的子行。
3. 数据只来自 `roleRadar` 已经读取的 `job.json` / `STATUS.json`：不新增文件读取、不新增落盘、不新增定时器。

### 非目标（Out of Scope）
- **不改变路由**：不自动降级、不跳过、不调整预设顺序，`hud_create` / `hud_roster` / 选择位置的逻辑一律不动。
- 不算综合“健康分”，不设阈值告警，不加颜色警报，不发通知。
- 不做 24 小时滚动窗口，也不做跨天历史（沿用本节“今天”的口径）。
- 不调用 Decision API 或小模型。
- 不改紧凑模式（`radarRows` 非 detail 分支）和 `split-project.ts` 的一行摘要。

---

## 3. 核心设计方案

### 3.1 数据结构

```ts
// src/collectors/control-radar.ts
export interface PlaceRadar { launches: number; launchFailed: number; ok: number; failed: number; quietEscalated: number; quota: number }
export interface RoleRadar { total: number; ok: number; failed: number; quietEscalated: number; avgMinutes: number | null;
  places?: Record<string, PlaceRadar> }   // 键为 describePlace 文本，如 "cli/claude (opus)"
```

### 3.2 归属规则（在 `roleRadar` 的现有循环内）

对每个今天创建的 job：
1. **启动尝试**：遍历 `job.attempts`（最多取前 8 个），每个 `attempt.place` 的 `launches++`；带 `reason` 且不等于 `used_place` 的再记 `launchFailed++`。
2. **接手位置** `p = job.used_place ?? (job.attempts ? null : describePlace(job.place, job.model))`。旧 job 没有 `attempts` 时回推，并记一次 `launches`。
3. 若 `p` 存在：`row.display_state` 为 done 或 failed 时，`p.ok` 或 `p.failed` 加 1（与角色级口径相同）；`quiet_decision.action` 非空时 `p.quietEscalated++`；`job.exhaustion_marked` 为真时 `p.quota++`。
4. 所有尝试都启动失败（没有 `p`）的 job，只计入各位置的 `launchFailed`，不计入任何位置的 ok 或 failed；角色级统计保持原样。
5. 位置文本经 `monitorText` 渲染（外部文本只过一次，§8），采集端只截断到 64 字符。

`describePlace` 从 `src/roles/exhausted.ts:89` 导入，与 `attempts[].place` 的写法一致（`thin-main.ts:1336`）。

### 3.3 渲染（`control-view.ts` `radarRows` 详情分支）

在每个角色行之后，若该角色今天用过 2 个以上位置，或任一位置有 `launchFailed` / `quota` > 0，就输出缩进的位置子行，否则不输出（避免单一位置角色重复一遍同样的数字）：

```
 Dispatch today
  imp  5 jobs · 3 ok · 1 failed · avg 12m · quiet 1
    cli/claude (opus)    3✓ 0✗
    pi (deepseek-v4…)    0✓ 1✗ · quiet 1
    cli/agy (hydrogen)   launch ✗1 · quota 1
```

- 每行严格 `width` 列（`fit` / `visualLength`，§8 Rendering），位置名过长时用 `squeeze` 截断。
- 每个角色最多 4 个子行，按 `launches` 降序，超出显示 `+n`。
- 新增 i18n 键（EN/ZH，放在 `i18n.ts:278-285` 附近）：`'launch ✗{n}'` / `'启动 ✗{n}'`，`'quota {n}'` / `'配额 {n}'`；`'quiet {n}'` 复用现有键（`:285`）。
- 只用 `mark('✓','+')` / `mark('✗','x')` 等现有字形和主题色，不引入新颜色角色。

### 3.4 成本

`job.json` 本来就在 `roleRadar` 中读取并按签名缓存，新增的只是对每个 job 的 `attempts` 数组做内存遍历（最多 200 个 job × 8 次尝试）。I/O 次数与现在完全相同，5 秒闸门不变。

---

## 4. 垂直切片与实施路线（对齐 `docs/delegation.md`）

### Slice 1：按位置拆分的“今日派发”（单个 imp 会话可完成）
- **依赖**：无；与 PRIMITIVES-01..03、MONITOR-STATE 错开时间。
- **估行**：源码 ~+60 / -5，测试 ~+70。
- **改动文件**：
  1. `src/collectors/control-radar.ts`：`PlaceRadar`、`RoleRadar.places`，`roleRadar` 内按 §3.2 归属。
  2. `src/render/control-view.ts`：`radarRows` 详情分支输出子行（§3.3）。
  3. `src/render/i18n.ts`：2 个新键的 EN/ZH。
  4. `tests/unit/control-radar.test.mjs`：§5.1 采集用例；`tests/unit/control-tab.test.mjs`：渲染宽度与语言用例。
  5. 如 Control 快照包含 Usage 区：`npm run snapshots:update` 并检查差异只在 “Dispatch today”。
  6. `docs/reference.md` / `docs/reference.zh.md`：Control 的 Usage 说明补一句；`docs/spec.md:103` 按文首措辞修改（owner 认可后）。
- **完成标准**：`node --test tests/unit/control-radar.test.mjs tests/unit/control-tab.test.mjs` 全绿；现有 `:67-118` 用例（角色口径、quiet 计数、200 目录上限）不变。

---

## 5. 验证与验收方案

### 5.1 自动化单测（临时 `HOME` / `HUD_HOME`，合成 job 目录，不触碰 `~/.hud`）

沿用 `control-radar.test.mjs` 现有写法，在临时 `HUD_HOME/jobs/` 下手写合成 `job.json` / `STATUS.json`：

| # | 场景 | 断言 |
|---|---|---|
| 1 | `attempts: [{place:'cli/agy (h)', reason:'launch timed out'}, {place:'pi (m)'}]`，`used_place: 'pi (m)'`，状态 done | `places['cli/agy (h)']` 为 `{ launches:1, launchFailed:1, ok:0, … }`，`places['pi (m)']` 为 `{ launches:1, ok:1, … }` |
| 2 | 所有尝试都失败，没有 `used_place` | 各位置只增加 `launchFailed`；角色 `failed` 口径与现状相同 |
| 3 | 旧 job：没有 `attempts`，有 `place` + `model` | 按 `describePlace` 回推，`launches:1` |
| 4 | `exhaustion_marked: true` + failed | `quota:1`、`failed:1` |
| 5 | `quiet_decision.action: 'needs-human'` | 该位置 `quietEscalated:1`；普通提问不计入（同现 `:93` 用例） |
| 6 | 昨天创建的 job | 不计入 |
| 7 | 渲染：宽度 40 / 100，EN / ZH | 每行 `visualLength === width`；单一位置且无失败的角色不出现子行；超过 4 个位置显示 `+n` |
| 8 | 回归 | 紧凑模式输出与 `split-project.ts` 摘要逐字不变；`:102` 的有界扫描用例不变 |

全量：在 `tmp/env.sh` 隔离环境中跑 `npm test`。

### 5.2 Owner 试用清单

- [ ] 正常工作一天后打开 Control → Usage：“今日派发”下，用过多个位置的角色出现位置子行，数字与 `hud_read` 中各 job 的 `attempts` / `used_place` 一致。
- [ ] 只用一个位置且无失败的角色不出现子行，Usage 区没有明显变长。
- [ ] 某个位置今天出现启动失败后（例如 agy 启动超时），对应子行显示 `launch ✗n`；路由行为不变，下次派发仍按链条顺序尝试。
- [ ] 切换到中文，子行文字为中文；40 列窄面板不折行错位。

---

## 6. 需要 Owner 拍板的开放问题

| # | 问题与选项 | 推荐默认项及理由 |
|---|---|---|
| **1** | **时间口径**：A：沿用“今天”（本地日历日，与现小节一致）；B：滚动 24 小时。 | **A**。小节名就是“今日派发”，口径统一；B 需要另外的扫描窗口，而现有 200 目录上限已按今天过滤。 |
| **2** | **是否同时在角色详情的链条（Chain）位置行上加一行灰色注记**（如 “今天 启动 ✗1”）？ | **本片先不加**。owner 试用后若觉得要在切换位置的地方直接看到，再加一个约 15 行的小片。 |
| **3** | **子行显示条件**：A：仅当角色用过 2 个以上位置或有启动失败、配额标记时显示；B：总是显示。 | **A**。避免重复同样的数字，保持 Usage 区紧凑。 |
| **4** | **“挂起”是否单独计数？** 原提案想统计 silent hang。现有事实只有“转交主会话”（`quiet_decision`）和启动超时（`attempts[].reason`）。 | **不新增“挂起”判断**，只显示这两个已记录的事实；“挂起”不是 spec:13 所说的事实，推断它就违背“只记录、不干预”。 |
