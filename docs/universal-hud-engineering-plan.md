# 通用 Agent HUD 工程计划书（v1.1，2026-11-01）

状态：v1.1，**阶段 A 开工基线**。v1 与概念方案 v2.2 一起经 ChatGPT Pro 第三轮评审（[reviews/2026-11-01-chatgpt-pro-v22-plan.md](./reviews/2026-11-01-chatgpt-pro-v22-plan.md)），v1.1 吸收其全部修正：缺包（状态归并器 B16、材料入口 B17）、合拆（A1 分批共审、B3 拆托管核心与可见终端、D2 最小一致提交并入 B12）、顺序（A8 依赖 A3、A4 依赖 A2 定稿、B11 依赖 B10、全部 B 受 A9 门禁、B14 依赖 B4 / B5、pi 加载统一在 C1）、规模（B12 升 M、B3 / C4 探针后重估、D5 含两周观察）、验收（每份 brief 的要素、能力矩阵逐格、Hermes 证据规则）、权威依赖表。概念方案（[v2.3](./universal-hud-concept.md)）是"做什么、为什么"的事实来源；本计划书是"谁、按什么顺序、怎么验收"。两者冲突以概念方案为准，并在本文修订。

## 0. 怎么用这份计划

- 每个工作包（WP）写成可以直接变成 brief 的粒度：目标、输入、产出、验收命令、角色、规模、依赖。编排者按 §3 的工作流把 WP 发给对应执行者。
- 规模：S ≈ 半天内、M ≈ 一到三天、L ≈ 一周量级，都是单个实现者的估计，不是承诺。
- 阶段边界是评审点：阶段 A 结束、阶段 B 结束各送 ChatGPT Pro 一次；其余阶段按需。
- 执行中的决定写回概念方案 §15；本计划书只改 WP 的状态与顺序。

## 1. 范围与交付物

| 阶段 | 交付物 | 状态 |
|---|---|---|
| A 契约、探针与 facade | `docs/contracts/` 七份契约、`docs/probes/` 六份探针报告（A3 五份、A8 一份）、核心类型与 fixture、三接口与假实现、Codex facade、测试基建 | 进行中：A1 第一批（01、02）v0.1 主审通过；A3 待主审；A8、A1 第二批进行中 |
| B MVP 纵向切片 cc → Codex | `packages/hud-mcp`、`hud-run`、账本、Herdr 集成层、cc 最小适配器、链接解析、渲染、`hud claude`、最小 `hud panel`、skill 更新、能力矩阵、两个真实场景 | 待开工 |
| C pi 与 Jev 后端 | pi 适配器与 `hud pi`、resume 实测、Jev 后端与 JobRef、pi 的 MCP 加载 | |
| D cc 完整与 statusline | cc 原生子代理、checkpoint 与采集租约、`hud statusline`、对照清单与基准、三道门切换 | |
| E 整理 | herdr 宿主完整版、改名与迁移、v1.1 工具、文档 | |
| F 后续 feature | Jev 路由、pi footer、Herdr 事件、delegated 摘要、其他 kind | |

**MVP = A + B。** 每个阶段都可独立交付，阶段内 WP 可并行的在 §4 标出。

## 2. 目标仓库结构

```
bin/hud, bin/hud-run, bin/codex-hud（facade）
src/core/        types、SessionEvidence、AgentTree、link 解析、状态模型、RunControl、tmux 宿主、headless 启动
src/harness/     codex（facade 包住现有 collectors）、claude、pi
src/jobs/        jev（job 适配器）
src/integrations/herdr/   RegistryProvider、HostAdapter、RunControl 贡献、schema 校验、观察桥
src/render/      现有渲染 + delegated / run / Inspector 新节
src/collectors/  现有 Codex 采集（阶段 E 前不搬）
packages/hud-mcp/   stdio MCP：工具、账本、调用者登记、后端档案
docs/contracts/  七份契约；docs/probes/ 探针报告；docs/capability-matrix.md
tests/unit/      现有 + 契约 fixture；tests/herdr/ 单独套件；tests/integration/ tmux 与真实场景脚本；tests/human/ Hermes 脚本
```

## 3. 工作流与角色

路由规则与约定在 [delegation.md](./delegation.md)，摘要：

| 角色代号 | 执行者 | 用于 |
|---|---|---|
| ORCH | Claude Code 编排者（Herdr 内，opus medium） | 切分 WP、写 brief、验证报告、提交 |
| ARCH | ChatGPT Pro（经 jev-ask） | 架构难题、契约定稿前评审、阶段边界评审 |
| REV | Codex reviewer，gpt-6.1-sol，effort **max** | 每个变更一个主审：首评与修复复核同一人，通过绑定最终 diff（规则见 delegation.md） |
| CORE | Codex implementer，gpt-6.1-sol，effort high（契约类可提到 max） | 核心任务：契约、账本、hud-mcp、hud-run、适配器、链接解析、状态模型、reader、Herdr 层 |
| ORD | pi implementer（DeepSeek V4.1 Flash，pi-roles） | 普通任务：探针脚本、测试基建、fixture、skill 与文档更新、基准脚本、改名。表现不佳即升级到 CORE |
| FE | Claude Code 子代理 `frontend-implementer`（sonnet，xhigh） | bar / panel / Inspector / statusline 的渲染与文案 |
| HUI | Hermes computer use（Windows，grok-4.7，一次性运行 + 脚本） | 需要人类互动的测试：对话框、Windows Terminal 视觉验收、真实输入 |

约定：brief / role / report / review 放 `tmp/tasks/<WP>/`；检查命令 `npm test`、`npm run format:check`、`npm run test:visual`，以及 WP 自己列的命令；一个变更一个主审；编排者评审通过后才提交；代理用完即关。

**每份 brief 必含：** 输入（文件、契约章节、探针结论）、产出路径、验收命令与期望的状态断言、每条命令的超时、证据存放路径（日志、账本导出、截图）、Subagent plan 层级、所有权范围（允许修改的路径）。缺一项编排者不发。

**权威依赖表（谁对什么负责）：**

| 事项 | 权威工作包 | 消费者 |
|---|---|---|
| 身份回填与关系状态迁移 | B5（握手）+ B2 的 reconciler | B9 只投影，不写 |
| 五维状态归并与真值表 | B16 | B10 渲染、B6 status |
| 模型材料入口与外发授权 | B17（实现）+ A2 契约 07 | 所有模型功能 |
| 采集一致性（checkpoint 一致提交、租约接管、旧持有者失效） | B12 | D2 完整版、D3 statusline |
| 执行协议（幂等、槽、对账表） | A1 契约 02 → B2 / B4 | B6、B14 |
| 可见模式托管方案 | A8 探针 → A1 契约 04 → B3b | B7、B11 |

## 4. 工作包

### 阶段 A：契约、探针与 facade

| WP | 内容 | 产出 | 验收 | 角色 | 规模 | 依赖 |
|---|---|---|---|---|---|---|
| A1 | **P0 契约，分两批交付、共同审定**：第一批 ①调用者登记与绑定凭据（CallerId、OwnerKey、claim、握手状态机、核验范围、失效规则）②执行协议（幂等键范围与参数摘要、意图 + 槽同事务、`uncertain` 进入与对账表、禁止重试清单）；第二批 ③link / run / report 生命周期（两个状态机、每 SessionRef 单运行互斥、wait 游标与 runId 固定、resume 允许条件、转交）④运行托管（hud-run 职责、日志与退出回执格式、取消序列、心跳与 `uncertain`、父断连策略、方案甲 / 乙的接口留位） | `docs/contracts/01-identity.md`、`02-execution.md`（第一批）；`03-lifecycle.md`、`04-supervision.md`（第二批）；每份含数据模型、不变量、状态机、失败案例、测试清单；账本 schema v1 的 SQL 附在 02 | 每批 REV 评审通过后才写下一批；两批合起来由 ORCH 与 REV 共同审定一致性；ARCH 复核在 A9 | CORE（max） | L | 第二批依赖第一批定稿；04 的可见模式部分等 A8 结论 |
| A2 | **P1 契约**：⑤能力矩阵与宿主（支持组合、locator 校验、降级边界、argv / shell 两种启动契约）⑥观测（指标口径表、reader 预算、checkpoint 一致提交、采集租约接管）⑦外发与兼容（目的 × 接收方授权、snapshot / checkpoint / ledger 版本、旧命令与 `--json` 兼容 facade） | `docs/contracts/05-capabilities.md`、`06-observation.md`、`07-outbound-compat.md` | REV 评审通过；定稿需引用 A3 / A8 的结论（daemon 路径、env 可达性、可见托管方案） | CORE | M | A1 第一批；定稿依赖 A3、A8 |
| A3 | **探针**：Codex 的 MCP 服务器由 TUI 还是 daemon 启动、env 与 `_meta` 可达性；两个 Codex home 同 cwd 的会话隔离；`herdr tab create --env` 是否到达 pane 的 shell、agent 进程、MCP 服务器；pi `--session` resume 是续写还是新文件；cc 的 MCP 服务器 env 内容 | `docs/probes/*.md`：方法、原始观测（脱敏）、结论、对契约的影响；脚本放 `tests/probes/` | 每份探针有可重跑脚本；结论被 A1 / A2 引用 | ORD（升级规则适用） | M | 无，可与 A1 并行 |
| A4 | **核心类型与契约 fixture**：`SourceId`、`SessionRef`、`JobRef`、`CallerId`、`RunBinding`、`Link`、`Run`、`Report`、`Metric`、`SessionEvidence`、`ActivityState`；合成 fixture 覆盖 cc 共享 sessionId、cc 重复 usage、pi compaction / cache_warm、双 home、同 pane 换会话、同一关系两次运行、并发重试、启动中断、旧 run 迟报 | `src/core/types/*.ts`、`tests/fixtures/contracts/`、`tests/unit/contracts.test.ts` | `npm test` 全绿；fixture 只用合成数据；fixture 只证明类型与状态机在合成输入下的行为，不证明真实进程恢复（那是 B3a / B4 / B14 的事） | CORE | M | A2 定稿（含 A3 / A8 结论） |
| A5 | **三接口与假实现**：`RegistryProvider`、`HostAdapter`、`RunControl`、`HarnessAdapter`；`tests/fakes/` | 接口文件 + 假实现 + 用假实现跑的核心用例 | 核心套件无 Herdr 可跑 | CORE | S | A4 |
| A6 | **Codex facade**：`src/harness/codex/` 用现有 `SessionFinder` / `RolloutParser` / `subagent-tree` 实现 `HarnessAdapter`，不搬目录；`linkEvidence` 提取；`SCAN_VERSION` +1；snapshot v3 字段草案（加法） | facade 模块 + 现有调用点改走 facade | 现有 1038 + 47 测试与视觉基线全绿；`--json` 旧字段不变 | CORE | M | A4、A5 |
| A7 | **测试基建**：`npm run test:core`（无 Herdr，`HUD_HOME` 临时目录）、`npm run test:herdr`（仅 Herdr 套件）、CI 脚本、fixture 脱敏检查 | `package.json` 脚本、`tests/run-core.sh`、`.github/workflows` | 两套件各自可单独跑 | ORD | S | A5 |
| A8 | **hud-run 可见模式探针**：在 Herdr pane 里分别试方案甲（hud-run 用 `$SHELL -ic` 包住 `codex` 函数）与方案乙（harness 直接起、hud-run 作 sidecar 记录），验证 Herdr agent 检测、herdr-context 包装、TTY 直通、退出回执是否正常 | `docs/probes/hud-run-visible.md`，含两方案的对照表 | 结论写进 04-supervision 并决定 B3b 走哪条 | ORD | S | A3（复用其 env / 进程树方法） |
| A9 | **阶段评审（阶段 B 的门禁）**：汇总七份契约、六份探针与 fixture 送 ARCH；采纳后冻结类型与 schema v1 | `docs/reviews/<date>-pro-contracts.md` | 三项阻断项无 P0：身份回填与握手、幂等 / 执行协议、运行恢复与对账；其余项可带条件通过 | ORCH + ARCH | S | A1–A8 |

### 阶段 B：MVP 纵向切片 cc → Codex

全部 B 工作包以 A9 冻结为门禁：A9 前只写 brief，不合入 B 代码。下表的"依赖"列是权威顺序，§5 的图只是示意。

| WP | 内容 | 产出 | 验收 | 角色 | 规模 | 依赖 |
|---|---|---|---|---|---|---|
| B1 | **hud-mcp 骨架**：stdio 服务器、工具注册、`delegate.json` 加载与校验、调用者登记（pid / ppid / procStart / harness 推断 / `HERDR_PANE_ID`）、SessionRef 解析器（cc sessions 文件、Codex pane 绑定、pi cmdline） | `packages/hud-mcp/` | cc 与 Codex 能加载并列出工具，登记行正确（pi 的加载在 C1） | CORE | M | A9 |
| B2 | **账本**：`node:sqlite`、WAL、`user_version`、事务助手、幂等表、事件表与游标、租约表、`hud link list/show/export`、只读访问层给 HUD | `packages/hud-mcp/src/ledger/`、`src/core/ledger-read.ts` | 并发写单测（两个进程同时 spawn）；幂等同键同参 / 同键异参 | CORE | L | A1 |
| B3a | **hud-run 托管核心**：进程组、shell / argv 两种启动、headless 路径、日志、心跳、退出回执、取消序列、`orphan_policy`、`hud run status/logs/cancel/reconcile` | `bin/hud-run`、`src/core/run/` | 进程级单测：正常退出、被杀、托管自身死亡后对账、取消三段式、重复启动被槽拒绝 | CORE | L | A1 |
| B3b | **hud-run 可见终端集成**：按 A8 结论实现方案甲（包装）或方案乙（sidecar），TTY 直通、Herdr 检测与 herdr-context 保持、可见模式下的退出回执 | `src/core/run/visible-*.ts` + tmux 集成测试 | tmux 里起一个可见 Codex 并拿到退出回执；Herdr `agent list` 仍识别该 pane | CORE | M（A8 后重估） | A8、B3a |
| B4 | **spawn / resume 与 Codex 后端档案**：模板（launch / headless / resume / resumeHeadless）、claim 生成与注入、首条 prompt 组装、意图先行事务、headless 路径、tmux 可见路径 | hud-mcp 工具 + `delegate.json` 示例 | 仅证实未执行（启动前失败、有退出回执且无子进程）才 `failed`，其余一律 `uncertain` 进入对账；超时不改状态；同 OwnerKey 同 request_key 重试返回原结果 | CORE | M | B1、B2、B3a |
| B5 | **握手**：`delegate_whoami`（env claim 自动 / 参数 claim）、单次有效与 TTL、fork 复制 claim 被拒、`pending → claimed → bound`、`delegate_report` 绑定 runId | 工具实现 + 单测 | fork 场景单测；无 env 的 claim 路径单测 | CORE | M | B4 |
| B6 | **wait / status / cancel**：事件长轮询（≤120 s，游标）、状态聚合（关系、运行、报告、心跳、对账结果）、取消经 hud-run、可选父 pane 提示 | 工具实现 + 单测 | 超时不改状态；旧 run 迟报不满足新等待；status 的状态字段来自 B16 归并器 | CORE | M | B2、B3a |
| B7 | **Herdr 集成层**：`integrations/herdr/{registry,host,run-control}`、`herdr api schema` 版本校验、tab 可见布局、`--env` 注入、就绪探测、`sendInput` 经 `agent prompt`、降级边界（仅预检失败回退）、Herdr 套件 | 模块 + `tests/herdr/` | `HUD_HERDR=0` 时核心全部可用；schema 不符降级并记诊断；只有预检失败（启动确实未发生）才回退 | CORE | M | A5、B3b |
| B8 | **cc 最小适配器**：绑定（stdin > 注册表 > sessions 文件 > 候选）、预算 reader（类型白名单、`api-request-blob` 跳过、usage 按 message.id 去重、compact 边界）、`linkEvidence` 提取（`mcp__hud__delegate_*` 工具结果、首条用户消息）、`children` 占位 | `src/harness/claude/` + fixture | 100 MB 合成 transcript 增量 tick 预算内；coverage 标记正确 | CORE | L | A4、A6 |
| B9 | **HUD 链接解析**：读账本、约定范围核验（签发时间窗、harness 一致、唯一匹配）、冲突与候选、树投影（delegated 节点、经 Codex facade 读孙辈、深度 / 节点 / I/O 预算、visited） | `src/core/link/` | 单测：晚到、重复、冲突、fork、循环、关闭后保留 | CORE | M | B2、B8 |
| B10 | **渲染**：delegated / headless 行（模式、run 序号、状态）、"日志 / 打开"动作、Inspector "链接" 与 "运行" 节、bar `delegated` 模块、冲突行、顶部父标识、中英文案 | `src/render/` 改动 + 视觉基线更新 | 视觉基线审阅；规则 §8 清单；只消费 B16 的归并结果，不自己判状态 | FE | M | B9、B16 |
| B11 | **启动器**：`hud claude`（档案、argv / shell、`--resume`）、`hud run …`、最小 `hud panel`（在当前 Herdr tab split 开面板，只为验收场景）、`codex-hud` 兼容入口 | `bin/hud` + 文档 | tmux 集成测试：`hud claude -- claude` 起 bar 与 panel | CORE | M | B7、B10 |
| B12 | **最小采集一致性**：`collect:<session>` 租约、过期接管、旧持有者失效（接管后旧持有者的写入被拒）、checkpoint 与摘要的最小一致提交（同一事务 / 原子重命名）、多消费者只读已提交摘要 | `src/core/collect-lease.ts`、`src/core/checkpoint.ts` | panel + statusline 并发单测；接管后旧持有者写入被拒；崩溃点注入后摘要与 checkpoint 不会一个新一个旧 | CORE | M | B2 |
| B13 | **skill 与角色模板**：`herdr-delegate-codex` 改为 `delegate_spawn / wait / status / cancel`；角色模板加 whoami / report 与旧问题通道；`delegate.json` 初版 | skill 文件 + `docs/delegate.example.json` | 用新 skill 跑一次真实委派 | ORD | S | B6 |
| B14 | **验收场景与能力矩阵**：真实场景一（Herdr 可见模式 cc → Codex implementer）、场景二（headless → 结束后可见 resume；活跃时 resume 被拒）、`HUD_HERDR=0` 重跑场景二、tmux 首次可见启动、headless resume；`docs/capability-matrix.md` 逐格验证；Codex 信任对话框等人机步骤由 HUI 脚本处理 | `tests/integration/scenario-*.sh`、`tests/human/*.md`、矩阵文档 | 每个矩阵格有对应脚本与日志；未测的格标"未验证"，不标支持；身份、输入落点、退出、重复运行由脚本对账本 / 进程 / 回执核验 | ORD + HUI | M | B4、B5、B11、B12、B13、B16、B17 |
| B16 | **五维状态归并器**：activity / pendingReason / lastTurnOutcome / liveness / freshness 的归并规则与真值表（含 Herdr 事实与 transcript 事实冲突、心跳停但回执未到、关闭后保留），输出给渲染与 status 的单一结构 | `src/core/status/merge.ts`、`docs/contracts/06` 附录真值表、fixture | 真值表每行一个用例；B10 / B6 不再各自判状态 | CORE | M | B2、B8 |
| B17 | **统一模型材料入口**：所有模型功能（摘要、委派摘要、未来 Jev 路由）取材料只走一个入口；按 source 的外发授权；新来源默认不外发；负向测试 | `src/core/materials/`、`tests/unit/materials.test.ts` | 负向测试：未授权来源的任何文本不出现在外发 payload；迁移后新来源默认拒绝 | CORE | M | A2（契约 07）、B8 |
| B15 | **阶段评审**：MVP 演示材料 + 账本导出 + 场景日志 + 能力矩阵送 ARCH | `docs/reviews/<date>-pro-mvp.md` | 无阻断项 | ORCH + ARCH | S | B14 |

可并行（A9 之后）：B2 ∥ B3a ∥ B8；B3b 等 A8；B7 ∥ B9 ∥ B16 ∥ B17；B12 随时。B10 → B11 串行；B13 在 B6 后。规模标注"探针后重估"的（B3b、C4）在对应探针结论出来后由 ORCH 改规模。

### 阶段 C：pi 与 Jev 后端

| WP | 内容 | 角色 | 规模 | 依赖 |
|---|---|---|---|---|
| C1 | pi 适配器（绑定、reader、口径、`custom` 事件）+ `hud pi` + pi 的 MCP 加载 | CORE | L | B15 |
| C2 | cc / pi 的 resume 模板实测与能力矩阵更新；新文件归同一 SessionRef 的处理 | ORD | M | C1 |
| C3 | `herdr-delegate`（pi）改调 MCP；pi 角色模板 | ORD | S | C1 |
| C4 | Jev 后端：浏览器实例租约（generation）、key / send / wait、`uncertain` 对账、needs_human、混用规则检查 | CORE | M（探针后重估） | B15 |
| C5 | JobRef 节点渲染与卡片 | FE | S | C4 |
| C6 | 验收：三 harness + Jev 同树；Jev sent → answered 与 needs_human 两场景（needs_human 的登录 / 验证码留给用户，不交 HUI） | ORD + HUI | M | C1–C5 |

### 阶段 D：cc 完整与 statusline

| WP | 内容 | 角色 | 规模 | 依赖 |
|---|---|---|---|---|
| D1 | cc 原生子代理（meta + toolUseId）、后台任务、todo 投影 | CORE | M | C6 |
| D2 | 采集一致性完整版：多 reader 并发、跨进程接管的完整策略、checkpoint 版本迁移（最小部分已在 B12） | CORE | M | B12 |
| D3 | `hud statusline`：stdin 优先、摘要补充、预算 reader 回退、`COLUMNS` / tty 宽度处理、toktrack `tee` | CORE（逻辑）+ FE（外观） | M | D2 |
| D4 | 对照清单（按本机 claude-hud 实际启用项）+ 性能基准脚本（冷启动、增量、超大单行、无结尾换行、重写、宽树、多消费者） | ORD | M | D3 |
| D5 | opt-in 观察期工具（渲染耗时分位数与错误记录）、`--install` / `--restore`、故障标准；Windows Terminal 视觉验收由 HUI 执行；**观察期 ≥ 2 周**，期间故障标准未触发才算达标 | ORD + HUI | S（工具）+ ≥ 2 周日历时间 | D4 |
| D6 | 切换默认（三道门全过） | ORCH | S | D5 |

### 阶段 E：整理

| WP | 内容 | 角色 | 规模 |
|---|---|---|---|
| E1 | `hud panel` 完整版（herdr 宿主） | CORE | M |
| E2 | 改名 `agent-hud` / `hud`、`HUD_*` 变量与别名 | ORD | M |
| E3 | 迁移工具（扫描缓存重建；设置 / 授权按 source 分迁） | CORE | M |
| E4 | v1.1 工具：`delegate_list / close / send / ask`、资源 | CORE | M |
| E5 | 文档、i18n、README（中英日韩） | ORD | M |
| E6 | Codex 目录搬迁（可选） | CORE | L |

### 阶段 F：后续 feature

F1 Jev 路由（CORE + ARCH）、F2 pi footer（ORD）、F3 Herdr 事件订阅（CORE）、F4 delegated 节点模型摘要（CORE）、F5 其他 Herdr kind（ORD）。各自立项时再细化。

## 5. 顺序与里程碑

```
阶段 A
  A1 第一批(01,02) ─ A1 第二批(03,04) ─┐
  A3 ─ A8 ──────────────────────────┼─ A2 定稿 ─ A4 ─ A5 ─┬─ A6 ─┐
                                    │                    └─ A7 ─┴─ A9（契约冻结 = 阶段 B 门禁）
阶段 B（全部在 A9 之后）
  B1 ─ B2 ─┬─ B3a ─┬─ B4 ─ B5 ───────────────┐
           │       ├─ B3b(等 A8) ─ B7 ───────┤
           │       └─ B6 ─ B13 ──────────────┤
           ├─ B8 ─┬─ B9 ──┐                  ├─ B14 ─ B15（MVP）
           │      ├─ B16 ─┴─ B10 ─ B11 ──────┤
           │      └─ B17 ────────────────────┤
           └─ B12 ───────────────────────────┘
阶段 C
  C1 ─ C2 ─ C3 ─┐
  C4 ─ C5 ──────┴─ C6
阶段 D
  B12 ─ D2 ─┐
  D1 ───────┴─ D3 ─ D4 ─ D5（≥ 2 周观察）─ D6
E、F 按需
```

图只是示意，§4 每行的"依赖"列是权威。里程碑：M1 契约冻结（A9）；M2 MVP（B15）；M3 三后端同树（C6）；M4 statusline 切换（D6，含 D5 的两周观察）。

## 6. 测试与验收策略

| 层 | 内容 | 命令 / 位置 |
|---|---|---|
| 契约 fixture | 合成数据覆盖每份契约的测试清单 | `tests/unit/contracts.test.ts` |
| 单元 | 现有 1038 + 47 用例 + 新模块 | `npm test` |
| 核心无 Herdr | 用假实现跑全部核心用例 | `npm run test:core` |
| Herdr 套件 | 只测 `integrations/herdr/`，需要 Herdr 在跑 | `npm run test:herdr` |
| 集成 | tmux 启动、启动器、真实场景脚本 | `tests/integration/` |
| 视觉基线 | 渲染变更 | `npm run test:visual` |
| 性能基准 | 阶段 D 的七类基准，报告追加量、硬件、分位数 | `tests/bench/` |
| **人机交互** | 需要点对话框、真实输入、看 Windows Terminal 画面的验收 | `tests/human/`，由 HUI 执行 |

**人机交互测试的做法（参照 ux / JevFocus 项目）：** 脚本先把环境摆到待测状态（起 HUD、起子代理、制造对话框），再写一个一次性任务文件交给 Windows 侧的 Hermes（grok-4.7，`run.ps1 -PromptFile … -Toolsets computer_use`，一次性模式自动免审批），由它点击、输入、截图并回报。**证据规则：** usage JSON 只证明调用发生了，截图只证明某一瞬间的画面；身份、输入落点、退出、重复运行这些事实由脚本对账本 / 进程 / 回执核验，不以截图或模型自述为准。限制：Hermes 点不到任务栏；登录、验证码、Jev 的 NEEDS_HUMAN 留给用户，无人在场时只验证阻塞提示与锁持有；cua-driver 输入可能不走共享输入队列，绕过共享输入队列的路径在报告里标"未覆盖"。不与用户约手动测试。

**契约 fixture 的边界：** A4 的 fixture 证明类型与状态机在合成输入下的行为，不证明真实进程恢复；进程恢复由 B3a / B4 的进程级单测与 B14 场景证明。

**每份 brief 的验收段：** 输入、命令、期望的状态断言、每条命令的超时、证据路径（见 §3）。实现者报告必须贴命令的实际输出与证据路径，编排者按证据验收。

**验收案例（每阶段回归）：** 同 cwd 多会话与双 home；cc 根与多个子代理共 sessionId；同 pane 换会话 / resume；握手晚到、claim 过期、fork 复制 claim、链接重复、冲突、循环、关闭后保留；并发重试、启动中断、`uncertain` 对账、旧 run 迟报；stale / unknown 注册表；重复 usage 与压缩；panel / watch / statusline 并发；迁移后新来源仍未获模型外发授权；Jev needs_human 与重复 key。

## 7. 环境与前置

- Node 24（`node:sqlite`）、tmux、Herdr（当前 CLI 与 schema 版本记入 `integrations/herdr/VERSION`）、codex-cli 0.166、Claude Code 2.1.305、pi 1.4.0、jev-ask 包、Hermes（Windows）。
- 两个 Codex home（`~/.codex`、`~/.codex-account2`）都要在探针与双 home 用例里出现。
- 测试一律用临时 `HUD_HOME`，不碰 `~/.hud/`；fixture 只用合成数据（仓库公开）。

## 8. 风险登记册

| 风险 | 影响 | 缓解 | 负责 |
|---|---|---|---|
| Codex 由 daemon 启动 MCP，env 不可达 | 握手只剩 prompt claim 路径 | A3 探针先定型；契约 01 写两条路径 | CORE |
| hud-run 包住 harness 破坏 Herdr 检测或 herdr-context 包装 | 可见模式不可用 | A8 原型探针；备选：可见模式不包，只用 sidecar 记录 | ORD → CORE |
| cc transcript 体积 | tick 超预算 | 预算 reader、类型跳过、coverage；B8 基准 | CORE |
| 账本并发写丢更新 | 关系错乱 | SQLite 事务 + 幂等；B2 并发单测 | CORE |
| pi imp 质量不稳 | 普通任务返工 | 升级规则：两轮评审仍有 blocker 即转 CORE | ORCH |
| Herdr 升级改 CLI / schema | 集成层失效 | 版本校验 + 降级；只改一个目录 | CORE |
| 替换 claude-hud 功能缺口 | 用户日常体验退化 | 三道门；故障标准先写；一键回滚 | ORCH |
| 人机测试证据不可靠 | 误判通过 | usage JSON 证调用、截图证瞬间，其余由脚本对账本 / 进程 / 回执核验；输入队列限制注明 | HUI / ORCH |
| A9 前并行开工 B | 契约变动引发返工 | B 受 A9 门禁，A9 前只写 brief | ORCH |
| 多写者改账本 | 状态互相覆盖 | 写者只有 hud-mcp / hud-run / reconciler，HUD 只读；B2 并发单测 | CORE |

## 9. 变更控制

- 概念方案 §15 记决定；本计划书记 WP 状态；契约文档一旦冻结，改动需 REV 评审并在契约头部记版本。
- 阶段边界送 ARCH；阶段内的设计分叉也可随时送 ARCH，但不替代 REV。
- 评审归档 `docs/reviews/<date>-<who>-<topic>.md`。

## 10. 下一步

1. 并行开 A1 第一批（01 身份 + 02 执行协议，CORE max）与 A3（ORD）；A8（ORD）在 A3 结论后开，可与 A3 同一执行者串行。
2. A1 第一批 REV 通过后开第二批（03、04）；A2 在 A3 / A8 结论到位后定稿；A4 等 A2 定稿。
3. A9 的三项阻断项（身份回填与握手、幂等 / 执行协议、运行恢复与对账）无 P0 才冻结；下一次 ARCH 评审就是 A9，不再做第四轮概念评审。
