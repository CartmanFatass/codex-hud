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
| A 契约、探针与 facade | `docs/contracts/` 七份契约、`docs/probes/` 六份探针报告（A3 五份、A8 一份）、核心类型与 fixture、三接口与假实现、Codex facade、测试基建 | 已完成待 A9：契约 01–07（Oracle 三次裁决 C/D/E 已落实）、A3/A8 探针、前端信息设计 v1.0、A4 核心类型与 122 个契约 fixture（`c4c0950`、`651cd7c`）与隔离 A9 原型 21/21（`f8008e5`）、A5 四接口与假实现（`a7aa3a6`）、A6 Codex facade（`c215892`）、A7 测试基建（`145988c`）；A9 送 ChatGPT Pro 门禁评审 |
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
| ORACLE | Codex `gpt-6-astra`，effort max（herdr tab，一次性只读咨询） | 后端设计与架构：设计分叉、契约定稿前评审、实现中的架构问题（Jacob，2026-11-01） |
| ARCH | ChatGPT Pro（经 jev-ask） | 更高一级，只在关键节点：阶段边界评审（A9、B15）与 Oracle 上送的分叉 |
| REV | Codex reviewer，gpt-6.1-sol，effort **max** | 每个变更一个主审：首评与修复复核同一人，通过绑定最终 diff（规则见 delegation.md） |
| CORE | Codex implementer，gpt-6.1-sol，effort high（契约类可提到 max） | 核心任务：契约、账本、hud-mcp、hud-run、适配器、链接解析、状态模型、reader、Herdr 层 |
| ORD | pi implementer（DeepSeek V4.1 Flash，pi-roles） | 普通任务：探针脚本、测试基建、fixture、skill 与文档更新、基准脚本、改名。表现不佳即升级到 CORE |
| FED | Claude Code 子代理，Fable（`model: fable`，effort max） | 前端设计决策：信息展示、可视化、bar / panel / Inspector / statusline 的布局与信息层级，由它决定，产出 `docs/design/`（Jacob，2026-11-01） |
| FE | Claude Code 子代理 `frontend-implementer`（sonnet，xhigh） | bar / panel / Inspector / statusline 的渲染与文案 |
| HUI | Hermes computer use（Windows，grok-4.7，一次性运行 + 脚本） | 需要人类互动的测试：对话框、Windows Terminal 视觉验收、真实输入 |

约定：brief / role / report / review 放 `tmp/tasks/<WP>/`；检查命令 `npm test`、`npm run format:check`、`npm run test:visual`，以及 WP 自己列的命令；一个变更一个主审；编排者评审通过后才提交；代理用完即关。

**每份 brief 必含：** 输入（文件、契约章节、探针结论）、产出路径、验收命令与期望的状态断言、每条命令的超时、证据存放路径（日志、账本导出、截图）、Subagent plan 层级、所有权范围（允许修改的路径）。缺一项编排者不发。

**权威依赖表（谁对什么负责）：**

| 事项 | 权威工作包 | 消费者 |
|---|---|---|
| 身份回填与关系状态迁移 | B5（握手）+ B2 的 reconciler | B9 只投影，不写 |
| 五维状态归并、语义stateKey/stateSince/basis与终态谓词 | B16（边沿/纯函数）+ B12（同一ObservationCommit持久发布） | B10完整驻留渲染、B6最终status；不得各自判状态/另造存储 |
| 模型材料入口与外发授权 | B17（实现）+ A2 契约 07 | 所有模型功能 |
| 采集一致性（checkpoint 一致提交、租约接管、旧持有者失效） | B12 | D2 完整版、D3 statusline |
| 执行协议（幂等、槽、对账表） | A1 契约 02 → B2 / B4 | B6、B14 |
| 可见模式托管方案 | A8已接受关键证据 → 契约04前台约束 → B3b生产验收 | B7、B11 |
| 逐run启动上下文 / ledgerId / 内部只读访问 | 契约02/06 → B2（存储），B4（启动/本地resume） | B18导出、HUD投影；repoId不授身份 |
| 版本化本地委派元数据导出 | 契约07 → B18（producer），B11集成CLI | toktrack等consumer独立，不阻A4/A9/B15；本地白名单不授B17模型外发权 |

## 4. 工作包

### 阶段 A：契约、探针与 facade

| WP | 内容 | 产出 | 验收 | 角色 | 规模 | 依赖 |
|---|---|---|---|---|---|---|
| A1 | **P0 契约，分两批交付、共同审定**：第一批 ①调用者登记与绑定凭据（CallerId、OwnerKey、claim、握手状态机、核验范围、失效规则）②执行协议（幂等键范围与参数摘要、意图 + 槽同事务、`uncertain` 进入与对账表、禁止重试清单）；第二批 ③link / run / report 生命周期（两个状态机、每 SessionRef 单运行互斥、wait 游标与 runId 固定、resume 允许条件、转交）④运行托管（hud-run 职责、日志与退出回执格式、取消序列、心跳与 `uncertain`、父断连策略、方案甲 / 乙的接口留位） | `docs/contracts/01-identity.md`、`02-execution.md`（第一批）；`03-lifecycle.md`、`04-supervision.md`（第二批）；每份含数据模型、不变量、状态机、失败案例、测试清单；账本 schema v1 的 SQL 附在 02 | 每批 REV 评审通过后才写下一批；两批合起来由 ORCH 与 REV 共同审定一致性；ARCH 复核在 A9 | CORE（max） | L | 第二批依赖第一批定稿；04 的可见模式部分等 A8 结论 |
| A2 | **P1 契约**：⑤能力矩阵与宿主（支持组合、locator 校验、降级边界、argv / shell 两种启动契约）⑥观测（指标口径表、reader 预算、checkpoint 一致提交、采集租约接管）⑦外发与兼容（目的 × 接收方授权、snapshot / checkpoint / ledger 版本、旧命令与 `--json` 兼容 facade） | `docs/contracts/05-capabilities.md`、`06-observation.md`、`07-outbound-compat.md` | REV 评审通过；定稿需引用 A3 / A8 的结论（daemon 路径、env 可达性、可见托管方案） | CORE | M | A1 第一批；定稿依赖 A3、A8 |
| A3 | **探针**：Codex 的 MCP 服务器由 TUI 还是 daemon 启动、env 与 `_meta` 可达性；两个 Codex home 同 cwd 的会话隔离；`herdr tab create --env` 是否到达 pane 的 shell、agent 进程、MCP 服务器；pi `--session` resume 是续写还是新文件；cc 的 MCP 服务器 env 内容 | `docs/probes/*.md`：方法、原始观测（脱敏）、结论、对契约的影响；脚本放 `tests/probes/` | 每份探针有可重跑脚本；结论被 A1 / A2 引用 | ORD（升级规则适用） | M | 无，可与 A1 并行 |
| A4 | **核心类型、契约fixture与A9最小原型**：会话/运行/报告/五维状态及stateKey/stateSince/basis、WorkspaceContext/逐run冻结位置、ControlInitiator/local_user鉴权重放、ActionDescriptor、独立costUsd Metric、显示身份联合/freshness.state/launch_failed/共享终态谓词、双域快照戳、export v1类型/golden；另做隔离真实临时SQLite+合成进程，覆盖身份连续性、幂等/崩溃切点、scope恢复，不合入B生产代码 | src/core/types/*.ts、tests/fixtures/contracts/、tests/unit/contracts.test.ts；隔离原型 tests/prototypes/a9/（不被 src 引用）与结果 docs/probes/a9-prototype.md，原始日志 tmp/tasks/A4b/ | npm test全绿/合成数据；01–07新增A9反例含重启/缺历史/截止、同名intent绑定、worktree/clone/copy、包装改cwd/路径消失、ledger-b+观测-a；原型不宣称B生产恢复通过，三阻断组见A9/概念§16，consumer字段清单非前置 | CORE | M | A2定稿（含A3已评审/A8关键证据于8fdf4cf接受及本次D01–D13类型边界） |
| A5 | **三接口与假实现**：`RegistryProvider`、`HostAdapter`、`RunControl`、`HarnessAdapter`；`tests/fakes/` | 接口文件 + 假实现 + 用假实现跑的核心用例 | 核心套件无 Herdr 可跑 | CORE | S | A4 |
| A6 | **Codex facade**：`src/harness/codex/` 用现有 `SessionFinder` / `RolloutParser` / `subagent-tree` 实现 `HarnessAdapter`，不搬目录；`linkEvidence` 提取；`SCAN_VERSION` +1；snapshot v3 字段草案（加法） | facade 模块 + 现有调用点改走 facade | 现有 1038 + 47 测试与视觉基线全绿；`--json` 旧字段不变 | CORE | M | A4、A5 |
| A7 | **测试基建**：`npm run test:core`（无 Herdr，`HUD_HOME` 临时目录）、`npm run test:herdr`（仅 Herdr 套件）、CI 脚本、fixture 脱敏检查 | `package.json` 脚本、`tests/run-core.sh`、`.github/workflows` | 两套件各自可单独跑 | ORD | S | A5 |
| A8 | **hud-run可见模式探针**：已于8fdf4cf接受A8-fixB2关键证据，采用修订甲；同agent/session状态、实际context命令、父launcher退出后TTY前台输入/收尾；乙非MVP受管后端 | docs/probes/hud-run-visible.md，保留版本/形态、后台负对照和监督死亡故障语义 | 只限pane shell等待hud-run前台作业、harness为核验前台消费者；不把A8-fixB2混称工程WP B2或生产pass，真实父MCP故障矩阵/取消/复用/性能归B3b/B14 | ORD | S | A3（复用env/进程树方法）；关键证据已接受，A9仍待放行 |
| A9 | **阶段B门禁，第一级验收**：审七契约、支持/拒绝范围、fixture和A4最小SQLite/合成进程原型、已接受A3/A8关键证据，采纳后冻结类型/schema v1；不要求B生产代码先完成 | docs/reviews/<date>-pro-contracts.md | 三组阻断无P0：身份（唯一source/session、配置claim、fork/旧claim/原生子拒绝、切换失效/MCP重启连续）；执行（真实SQLite并发同键一次提交、异参/原子意图槽/重键重放/崩溃不重发）；恢复（甲的A8接受证据、活成员/取消未确认持槽、无旧receipt Q可达或缺证、恢复无执行权）。daemon-present/共享正向非前置；其余项可带条件 | ORCH + ARCH | S | A1–A8的A阶段产物；生产矩阵另在B14 |

### 阶段 B：MVP 纵向切片 cc → Codex

全部 B 工作包以 A9 冻结为门禁：A9 前只写 brief，不合入 B 代码。下表的"依赖"列是权威顺序，§5 的图只是示意。

| WP | 内容 | 产出 | 验收 | 角色 | 规模 | 依赖 |
|---|---|---|---|---|---|---|
| B1 | **hud-mcp 骨架**：stdio 服务器、工具注册、`delegate.json` 加载与校验、调用者登记（pid / ppid / procStart / harness 推断 / `HERDR_PANE_ID`）、SessionRef 解析器（cc sessions 文件、Codex pane 绑定、pi cmdline） | `packages/hud-mcp/` | cc 与 Codex 能加载并列出工具，登记行正确（pi 的加载在 C1） | CORE | M | A9 |
| B2 | **账本**：node:sqlite、WAL/user_version、事务助手、幂等/事件/游标、02运行槽、逐run不可变launch_cwd/nullable workspace_snapshot与project_origin、workspace.captured、私有单行ledgerId；hud link list/show及内部只读访问层，公开export归B18；collect租约仅06/B12观测存储，browser表留C4 | packages/hud-mcp/src/ledger/、src/core/ledger-read.ts | 并发双进程spawn/同键同参与异参；冻结启动上下文、一次快照捕获/事件、digest排除Git结果与写者时间、ledgerId初始化/恢复不变；只读层不承诺外部SQL接口 | CORE | L | A1（全部B另受A9门禁） |
| B3a | **hud-run 托管核心**：进程组、shell / argv 两种启动、headless 路径、日志、心跳、退出回执、取消序列、`orphan_policy`、`hud run status/logs/cancel/reconcile` | `bin/hud-run`、`src/core/run/` | 进程级单测：正常退出、被杀、托管自身死亡后对账、取消三段式、重复启动被槽拒绝 | CORE | L | A1 |
| B3b | **hud-run可见终端集成**：实现Oracle修订方案甲、TTY直通、真实harness PGID/完整scope控制、Herdr检测/context；原生退出结果可未知，shell status分列；乙managed与PTY延期 | src/core/run/visible-*.ts + tmux集成测试 | 生产验证scope结束/活成员阻终结、整组取消不退单PID、实例复用/短命/重启；父MCP断连continue仍前台可输入/收尾；supervisor死交互中断、uncertain持槽、禁自动input/focus/fg/恢复/resume，Q不依赖死人receipt；原型不是生产pass，性能依06 | CORE | M（A8后重估） | A9、A8关键证据接受、B3a |
| B4 | **spawn/resume与Codex档案**：四种模板、每轮claim注入/首条prompt、意图/槽、headless/tmux可见；逐run冻结启动目录/显式来源，事务外有界workspace捕获；01本地管理resume的typed initiator/actor审计、request-key/expected-run/mode及02重放顺序 | hud-mcp工具/同一受信CLI事务入口 + delegate.json示例 | 仅N证明未执行才failed，其余未知uncertain对账，超时不改状态；同owner/key重放原结果，local先鉴别再重放、新意图重验expected-run/全部门禁，不伪造旧父MCP；Git不入accepted热路径，未知不重启 | CORE | M | B1、B2、B3a |
| B5 | **握手**：`delegate_whoami`（env claim 自动 / 参数 claim）、单次有效与 TTL、fork 复制 claim 被拒、`pending → claimed → bound`、`delegate_report` 绑定 runId | 工具实现 + 单测 | fork 场景单测；无 env 的 claim 路径单测 | CORE | M | B4 |
| B6 | **wait/status/cancel**：≤120s事件游标、ledger关系/运行/报告/权限同读快照与观测双戳组合、取消经hud-run；最终status消费B16单一状态/连续性与终态谓词，父pane自动提示延期 | 工具实现 + 单测 | 超时不改状态；旧run迟报/摘要不补新轮；可先做ledger子集，最终验收等B16（其持久发布依B12），status/wait不采集/Git/reconcile/发布summary | CORE | M | B2、B3a、B16 |
| B7 | **Herdr 集成层**：`integrations/herdr/{registry,host,run-control}`、`herdr api schema` 版本校验、tab 可见布局、`--env` 注入、就绪探测、`sendInput` 经 `agent prompt`、降级边界（仅预检失败回退）、Herdr 套件 | 模块 + `tests/herdr/` | `HUD_HERDR=0` 时核心全部可用；schema 不符降级并记诊断；只有预检失败（启动确实未发生）才回退 | CORE | M | A5、B3b |
| B8 | **cc 最小适配器**：绑定（stdin > 注册表 > sessions 文件 > 候选）、预算 reader（类型白名单、`api-request-blob` 跳过、usage 按 message.id 去重、compact 边界）、`linkEvidence` 提取（`mcp__hud__delegate_*` 工具结果、首条用户消息）、`children` 占位 | `src/harness/claude/` + fixture | 100 MB 合成 transcript 增量 tick 预算内；coverage 标记正确 | CORE | L | A4、A6 |
| B9 | **HUD 链接解析**：读账本、约定范围核验（签发时间窗、harness 一致、唯一匹配）、冲突与候选、树投影（delegated 节点、经 Codex facade 读孙辈、深度 / 节点 / I/O 预算、visited） | `src/core/link/` | 单测：晚到、重复、冲突、fork、循环、关闭后保留 | CORE | M | B2、B8 |
| B10 | **渲染**：delegated/headless、intent稳定显示键与绑定后选择映射、日志/Open、Inspector链接/运行、bar delegated/冲突/父标识/中英；Resume/Reconcile按ActionDescriptor仅显示复制 | src/render/ + 视觉基线 | 规则§8/视觉审阅；只消费B16的freshness.state/stateKey/stateSince/basis/共享终态谓词，完整驻留读取等B12→B16发布；不按图标折历史，不在HUD起控制CLI | FE | M | B9、B16（完整连续性依B12） |
| B11 | **启动器**：hud claude档案/argv/shell/resume、hud run管理入口（含local_user resume完整参数与明确HUD_HOME安全复制命令）、B18版本化export CLI分派、最小hud panel、codex-hud兼容入口 | bin/hud + 文档 | tmux集成hud claude起bar/panel；管理resume只走B4既有writer/重验，不伪造父context，未验证能力不提供虚假命令；export不依赖HUD/B16/B17运行 | CORE | M | B4、B7、B10、B18 |
| B12 | **最小采集一致性**：collect:<SessionRef>租约/接管/旧代失效；checkpoint/parserState/summary/StateContinuity/notices及observationStamp同一ObservationCommit原子发布，B16复用不另造存储 | src/core/collect-lease.ts、src/core/checkpoint.ts | 并发panel/statusline、崩溃点无新旧混配、旧代迟写拒绝；stateKey/stateSince/basis重启续已知连续性、缺口不伪造；零逐tick年龄写/ledger显示列 | CORE | M | B2 |
| B13 | **skill 与角色模板**：`herdr-delegate-codex` 改为 `delegate_spawn / wait / status / cancel`；角色模板加 whoami / report 与旧问题通道；`delegate.json` 初版 | skill 文件 + `docs/delegate.example.json` | 用新 skill 跑一次真实委派 | ORD | S | B6 |
| B14 | **第二级生产验收与能力矩阵**：Herdr可见cc→Codex、headless后可见resume、活跃拒绝、HUD_HERDR=0/tmux；生产重验A9身份/幂等/恢复反例及全部声明能力/06基准；B18 producer快照、双source、晚绑定、两轮resume、handover、空值/隐私回归 | tests/integration/scenario-*.sh、tests/human/*.md、docs/capability-matrix.md及ledger/进程/receipt日志 | 逐格日志/版本，未测未验证；输入落点、nullable native/独立shell状态、完整scope取消/真实父MCP故障及无重复启动；性能/accepted→started/bound分计；导出行数/字节/墙钟/读事务寿命实测；toktrack消费端非A9/B15前置 | ORD + HUI | M | B4、B5、B11、B12、B13、B16、B17、B18 |
| B16 | **唯一五维归并器**：activity/pendingReason/lastTurnOutcome/liveness/freshness.state，语义优先/launch_failed/isRunTerminal、stateKey/stateSince/basis与episode连续性、双域stamp兼容、notice；B12持久发布共用ObservationCommit | src/core/status/merge.ts、契约06附录真值表、fixture | 每行fixture；重读/重启/新run/新episode/时钟截止/历史缺口一致，证据年龄另算；B10/B6不自判。可先纯归并，持久连续性与最终消费须等B12，不把部分实现当最终验收 | CORE | M | B2、B8、B12 |
| B17 | **统一模型材料入口**：所有模型功能（摘要、委派摘要、未来 Jev 路由）取材料只走一个入口；按 source 的外发授权；新来源默认不外发；负向测试 | `src/core/materials/`、`tests/unit/materials.test.ts` | 负向测试：未授权来源的任何文本不出现在外发 payload；迁移后新来源默认拒绝 | CORE | M | A2（契约 07）、B8 |
| B18 | **版本化本地委派导出**：07独立v1只读一致快照、ledgerId命名空间/逐run记录/完整SessionRef与nullable端点、scope/coverage、元数据白名单、--paths local、稳定排序/兼容；不依赖B16/B17/HUD运行 | 按需查询/序列化模块 + A4 golden与producer回归；CLI由B11集成 | 上限10000 run/16MiB/1000ms软预算，超限显式失败、完整JSON备妥才输出；记录行数/字节/墙钟/读事务寿命，不初始化/迁移/采集/Git/reconcile，不新增JSONL writer/daemon/后台全库同步；toktrack独立接入 | CORE | S | A9、B2 |
| B15 | **阶段评审**：MVP 演示材料 + 账本导出 + 场景日志 + 能力矩阵送 ARCH | `docs/reviews/<date>-pro-mvp.md` | 无阻断项 | ORCH + ARCH | S | B14 |

可并行（A9之后）：B2 ∥ B3a ∥ B8；B2后B12 ∥ B18，B18不等B16/B17；B7/B9/B17可按各自输入推进。B16纯逻辑可先做，最终连续性须B12，B6最终status须B16；B10→B11串行且B11集成B4/B18。B13在B6后；toktrack consumer不作为任何producer或A9/B15前置。规模标注"探针后重估"的（B3b、C4）在对应探针结论出来后由 ORCH 改规模。

### 阶段 C：pi 与 Jev 后端

| WP | 内容 | 角色 | 规模 | 依赖 |
|---|---|---|---|---|
| C1 | pi 适配器（绑定、reader、口径、`custom` 事件）+ `hud pi` + pi 的 MCP 加载 | CORE | L | B15 |
| C2 | cc / pi 的 resume 模板实测与能力矩阵更新；新文件归同一 SessionRef 的处理 | ORD | M | C1 |
| C3 | `herdr-delegate`（pi）改调 MCP；pi 角色模板 | ORD | S | C1 |
| C4 | Jev后端：定稿浏览器租约契约/DDL，真实resource/holder/generation、key/send/wait、uncertain对账、needs_human/混用；holderLabel?:string从lease owner/job在同一读取投影派生，无可公开显示名则省略，不另存所有权 | CORE | M（探针后重估） | B15 |
| C5 | JobRef节点渲染/卡片，消费C4派生holderLabel；改名只变显示，label不参与资源判等/generation/释放，needs_human/未知继续持有 | FE | S | C4 |
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
  A3 ─ A8 ──────────────────────────┼─ A2 定稿 ─ A4（类型/fixture+最小原型） ─ A5 ─┬─ A6 ─┐
                                    │                    └─ A7 ─┴─ A9（契约冻结 = 阶段 B 门禁）
阶段 B（全部在 A9 之后；+ 表示共同依赖）
  B1 + B2 + B3a ── B4 ── B5
  B3a ── B3b ── B7
  B2 ── B12 ──┐
  B2 + B8 ────┴─ B16
  B2 + B3a + B16 ── B6 ── B13
  B2 + B8 ── B9；B9 + B16 ── B10
  B2 ── B18（不等 B16/B17，consumer 独立）
  B4 + B7 + B10 + B18 ── B11
  B8 ── B17
  B4 + B5 + B11 + B12 + B13 + B16 + B17 + B18 ── B14 ── B15（MVP）
阶段 C
  C1 ─ C2 ─ C3 ─┐
  C4 ─ C5 ──────┴─ C6
阶段 D
  B12 ─ D2 ─┐
  D1 ───────┴─ D3 ─ D4 ─ D5（≥ 2 周观察）─ D6
E、F 按需
```

图只是示意，§4每行依赖列为权威；最终验收依赖为B6→B16→B12，B10完整驻留消费同受约束。B18只依A9+B2，由B11集成，B14含producer回归；B17仅模型材料/外发，不接管本地export、repoId或状态持续时间，两份白名单不混成全局授权。里程碑：M1 契约冻结（A9）；M2 MVP（B15）；M3 三后端同树（C6）；M4 statusline 切换（D6，含 D5 的两周观察）。

两级门禁的解释以本段与修订后的A4/A9/B3b/B14为准：A9前不合入B生产实现，但A阶段需要隔离的可执行事务规格、真实临时SQLite与最小合成进程原型，不能只审纸面fixture。A9不依赖B3/B4/B5/B14先通过；这些WP在冻结后对生产实现重验关键反例、完成声明的能力矩阵与06性能验收。§6“fixture不证明真实进程恢复”仍成立；A9的原型是另一份可行性证据，不替代生产验收。§4旧A1行中的甲/乙接口留位不构成实现两套后端的要求，B3b只实现Oracle修订甲。

当前证据状态：A3五份探针已评审、spoof完成且有界；daemon补测仅CLI0.166/daemon0.163在场默认direct-stdio，非共享支持/A9前置。A8首轮拒绝，A8-fixB2关键证据已于8fdf4cf接受：同agent/session状态、实际context命令、父launcher退出后的TTY前台输入/收尾；只限所测版本及pane shell等待hud-run的前台形态，后台形态负对照失败，supervisor死为已记录中断语义。A8-fixB2不等于工程WP B2或生产取消/复用/性能/真实父MCP故障矩阵已通过。D01–D13类型/边界及A4新增A9 fixture纳入本次契约收口，不构成A9放行；三阻断组不变。预算/唤醒/启动延迟归06，本地export归B18、toktrack接入独立；只承诺逐run有来源的启动位置/已确认边/可选declared来源，不承诺自动归属任意/tmp副本。

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
| hud-run 包住 harness 破坏 Herdr 检测或 herdr-context 包装 | 可见模式不可用 | A8 原型探针；已裁决（Oracle 第 1 次）：修订方案甲，hud-run 须为 pane 前台作业；方案乙（sidecar）不作 MVP 受管后端 | ORD → CORE |
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
