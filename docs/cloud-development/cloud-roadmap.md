# Universal HUD：C–F 云端交付计划

日期：2026-11-05。Oracle 调整方案，供编排者存入项目分支。

基线：`CartmanFatass/codex-hud`，`codex/delegation-integration@4899b3f5802657520509e5c0db1918395b031257`。这是本次核验时的远端 HEAD，不是以后工作的永久 HEAD。开始新工作时重新记录实际提交。

> 2026-11-05 后续交付：基于 `211f7e3` 增加 [云检查与本地包预览](checks-and-preview.md)，并保留本文最初 `4899b3f` 的状态记录。以下「尚未交付」表和立即队列是原始规划快照，不是把后续实现重新判为未完成；也不表示任何里程碑已整体通过。

## 1. 本次决定

目标是持续交付可以运行的通用 HUD，而不是把阶段 B 的所有历史验收循环重新做完以后才允许开发 C–F。

1. **研究、实现、普通回归和集成都可以在云端完成。** 使用官方文档、固定版本的上游源码、合成输入、真实临时 SQLite 和自有合成子进程。真实 Claude/Codex/pi 账号、用户本机、Herdr 或共享浏览器都不是 C–F 开发前置。
2. **实现进度与能力认证分开。** 文档符合、模拟通过、云端进程测试通过，不等于真实供应商验证。真实运行能力继续使用既有精确配置匹配与 fail-closed 规则；不得把模拟 manifest 复制进生产能力库。
3. **拆掉全局串行链。** 旧计划中的 `B14/B15 → C1/C4 → C6 → D1` 不再阻挡独立的观察、展示、CLI、迁移与工具开发。实际代码/API 依赖仍存在，逐项写在工作包中。
4. **不扩建阶段 B。** 既有失败和未完成资格记录保留。只有新交付实际依赖或引入的缺陷才进入当前工作包；不得以新的全量性能、真实账号或本地测试门槛无限延长它。
5. **先交付官方客户端适配。** Claude Code、Codex CLI 与 pi 的官方接口分别适配。CLI JSONL、statusLine stdin、hooks、SDK、app-server、磁盘会话格式不能因为都含 JSON 就共用未经证明的语义。
6. **不重做已有成果。** 当前基线已经含 pi reader/binding/projection、`hud pi inspect`、Claude background/todos/topology 与 reader v4→v5 的 fenced rebuild。活跃 C1、Claude panel 与 D3 工作继续由原负责人完成；新包接它们的实际产出。

本计划在 C–F 排期、开发环境和证据用途上替代旧工程计划的相反要求。契约 01–07 中的身份、授权、幂等、租约、取消、账本、外发及生产能力要求仍有效。原始测试失败不会改写为通过，旧的真实运行资格不会因本计划自动获得。特定执行器的访问拒绝或未清理进程也不能靠换一个工作目录绕过。

## 2. 已存在与尚未交付

以下是源码核验，不是新一轮测试通过声明。

| 项目 | 当前依据 | 下一步 |
|---|---|---|
| pi 只读适配器 | `src/harness/pi/{binding,index,projection,reader}.ts` | 接现有工作，不另起 reader 重写 |
| pi CLI | `tests/unit/pi-cli.test.ts`、`hud-pi-integration.test.ts` 已覆盖 `hud pi inspect` | 交付说明、示例与后续启动接口分开 |
| pi 管理能力 | `PiAdapter.capabilities = {}`，观察绑定不生成 managed run | 仍不等于启动、resume、MCP 或 wake 已可用 |
| Claude 投影基础 | `src/harness/claude/{background,todos,topology}.ts`；HEAD 含 fenced reader rebuild | 现有 panel 工作补齐用户可见消费链 |
| statusline | 已存在纯渲染组件；D3 分支正在工作 | 把 stdin 入口交付与安装/默认切换分开 |
| 云 CI | 现有 CI 仅 main push 和 PR；Node 18/20/22 的 test、22/24 的 core、20+tmux 的 integration | 新云开发 profile 是待实现，不声称已部署 |
| 历史阶段 B | 文档有大量旧失败、限制和生产资格 | 保留历史，当前队列只挂实际依赖 |

本次观察到的并行分支包括 `dots/c1-pi-adapter-20261105`、`dots/c1-pi-cli-delivery-20261105`、`dots/d1-claude-progress-20261105`、`dots/d3-stdin-statusline-20261105`。分支存在不表示已通过评审或已合入。开始整合前先核对原负责人、远端 SHA、独占文件和未提交工作。

## 3. 交付流与用户看得见的里程碑

里程碑按完成条件推进，不以测试次数或运行天数充当进度。多个流可并行，但同一共享文件只有一名写者。

### M0：可重复的云端开发入口

交付：固定来源的接口清单、合成 scenario 目录、独立运行目录、云端检查入口与结果清单。新执行者不需要登录任何供应商即可重现一个三 harness 展示场景。

完成条件：在声明的云环境中，从明确 SHA 构建并运行现有功能检查；列明 PASS/FAIL/SKIP/NOT_RUN；产出带输入来源和源码 SHA 的结果。CI 配置未运行时只能标记「配置已写，运行未确认」。

### M1：三 harness 的可观察 HUD

交付：pi inspect、Claude panel 信息、stdin statusline 的完整演示。展示会话身份、任务/子代理、tokens/cost/进度、来源和不完整状态。缺少官方字段时显示 unknown，不伪造精确值。

完成条件：真实项目入口消费合成文件或协议输入，产生可检查输出；至少包含正常、部分写入、未知字段和身份冲突场景；演示明确标为模拟。CLI/渲染有产出，不只增加底层测试。

依赖：现有 C1/D1/D3 原负责人的集成结果，必要的只读投影接口。**不依赖 C2 的真实 resume、Jev、B14 或 D5 两周观察。**

### M2：官方启动协议的可开发闭环

交付：明确区分 Claude print/stream-json、Codex exec JSONL、pi 已选版本接口的 protocol driver；启动计划、输入/输出、结束、错误、取消、resume 身份的云端测试。

完成条件：合成子进程通过实际 launcher/transport 接缝跑通；故障、截断、重复、超时和未知结果被保留；模拟进程证据不会提升生产能力格。缺少生产资格时可检查计划/输入，实际执行返回明确 refusal。

依赖：各协议接口和现有 supervision/authorization 接缝。CLI、SDK 与 app-server 只选当前产品真正需要的一个入口实现，其他入口记录为研究项，不为了覆盖所有官方表面扩张范围。

### M3：多源持久观察与统一 panel

交付：C6 三 harness 同树的云端场景、D2 多 reader/迁移/接管、E1 统一 panel 的宿主无关部分。Jev 先作为模拟 JobRef 消费者接入，不等待真实浏览器。

完成条件：从脚本事件到临时 SQLite、发布、panel/inspect 消费的端到端合成场景可重跑；崩溃恢复、过期租约、同名不同 source、乱序事件和多消费者不制造错误身份或完成状态。

### M4：可安装包与可恢复迁移

交付：版本兼容说明、迁移 preview/apply/restore 的临时 HOME 测试、构建产物、命令帮助、使用指南。旧命令兼容保留；产品改名可先加别名，目录大搬迁后置。

完成条件：在空的临时 HOME 安装/恢复演练不碰真实设置，重复运行可解释，失败能恢复或保守停止。实际安装到用户环境、发布包或切换默认值需要相应授权，不是此里程碑的自动副作用。

### M5：按实际需要交付 F 项

优先 pi footer，因为它直接增加可见价值；随后再选择确有需求的宿主事件订阅、Jev 路由或摘要。每个 feature 有独立接口与短 brief，不创建「先把 F 全部基础设施做完」的新阶段门。

## 4. 原 C–F 工作包的具体调整

| 工作包 | 云端交付范围 | 真正依赖 / 延后部分 |
|---|---|---|
| C1 | 复用已实现 pi reader/binding/inspect；补齐产品入口和所需连接层 | 不等 B15；pi MCP/extension 加载单独列能力，不假定原生支持 |
| C2 | 固定版本 resume 参数、同文件/新文件/分支身份的契约场景；合成进程测试 | 实机 resume 为后续资格证据，不阻 C3、D1、D3 |
| C3 | pi 角色/调用模板和 MCP bridge 的独立接缝 | 依赖已选 pi API 与身份机制；不改用户真实配置 |
| C4 | Jev lease、request key、uncertain、needs_human 的状态机和 fake backend | 真实 provider/browser 另选时再验证；不模拟成真实登录成功 |
| C5 | JobRef 卡片、holderLabel 缺省、未知/needs_human 状态 | 只依 C4 投影 DTO；label 不授所有权 |
| C6 | 三 harness + 模拟 JobRef 的端到端演示 | 不再是 D1 的前置，不称真实四后端认证 |
| D1 | 继续现有 Claude topology/todo/background 到 panel 的消费链 | 不等 C6；未记录的磁盘 transcript 字段标上游实现观察，不能称官方协议保证 |
| D2 | 临时 SQLite 下并发 reader、fencing、重启和版本迁移 | 按模块依赖 B12；只为使用该能力的后续包阻挡，不阻纯 stdin |
| D3 | 先交 stdin-only statusline，再加 read-only 摘要与有界 reader fallback | stdin-only 不等 D2；需要持久一致性的 fallback 再依 D2；不自动 tee 外发 |
| D4 | 与官方 statusLine 字段/本项目承诺的功能清单对照；必要的针对性基准 | 不要求读取本机 claude-hud 配置；已有性能契约按触及路径保留，不新开全局基准门 |
| D5 | opt-in 观察工具、安装/恢复逻辑、故障说明在临时 HOME 开发验证 | 两周真实观察只属于未来默认切换，不是开发、合入或发布 preview 的前置 |
| D6 | 明确列为默认替换/部署动作 | 云端开发不自动执行；真实观察未做就保持 opt-in/preview |
| E1 | 宿主无关 panel 完整交互；Herdr 接口用 fake contract 消费 | 真 Herdr 连接只影响其宿主声明 |
| E2 | 命令与 env 兼容别名、小范围改名 | 不顺带改包发布身份、不做高冲突大搬迁 |
| E3 | 版本化迁移、dry-run、备份/恢复、撤权不复活 | 不迁移真实用户 HOME；不把旧授权扩大到新来源 |
| E4 | 每次只做 list / close / send / ask 中一个端到端垂直切片 | 读功能可先交；写/交互功能保持现有授权、精确目标和幂等要求 |
| E5 | 随里程碑更新中英说明与已声明界面文案 | 日/韩可独立增量，不阻功能交付 |
| E6 | 暂缓可选 Codex 目录搬迁 | 只有影响实际维护时再做，避免扰动 active worktrees |
| F1 | Jev 路由 policy + fake sender | 真实外发仍走 B17/具体授权 |
| F2 | pi footer extension，固定 API 版本，snapshot/mock UI 测试 | 不要求有模型额度；缺事件走显式不支持/保守结束规则 |
| F3 | Herdr 事件 adapter 的重复/断线/恢复模拟 | 不把 fake server 视为真实宿主已验证 |
| F4 | delegated 摘要的材料过滤、缓存/撤权与 mock model | 真实模型调用与外发单独授权；不把摘要当身份或控制证据 |
| F5 | 每种新 kind 单独的观察与展示 adapter | 未知 kind opaque；不得自动获得 launch/control 能力 |

## 5. 开发验收与生产资格

### 开发验收

- 代码与明确的官方接口/仓库契约一致；假设有记录。
- 本包行为有真实断言，回归覆盖改动的输入和消费者；示例通过项目入口而非只调用测试辅助函数。
- 现有适用功能检查运行并保留失败。文档-only 改动检查 diff、路径、链接和内容一致性，不为没有代码变更的文档反复跑全部性能实验。
- 新包不会降低身份、权限、租约、幂等、证据和信息外发保护。
- 对 tick/reader 的改动执行已经适用的预算/回归检查。没有相关改动，不扩大为新的跨项目性能门。

### 生产资格

- 官方文档或模拟不能生成 `verified` 能力。
- 当前运行时需要的 executable/version/configuration/host/identity 证据不足时，敏感操作继续拒绝，原因可见。
- 无真实账号时可以完成实现、云端验证、review 和 opt-in 交付，并将特定真实集成项保留为 `NOT_RUN`。不能把整阶段标为「真实生产全通过」。
- 若将来需要放宽生产资格语义，必须单独提出明确契约变更，不藏进模拟工作。

## 6. 立即执行的队列

1. **DOC-CLOUD**：把本计划、开发手册与官方来源表提交到指定开发分支；在 `AGENTS.md`、`docs/handoff/STATE.md`、旧工程计划、cloud README/dots 的顶部链接当前入口，标明旧排期已被替代，保留历史证据。
2. **CLOUD-CI**：增加明确的 credential-free 云 profile，Node 22.13+/24，指定开发分支 push/PR/manual 入口，结果 artifact。保留旧版 legacy-only 范围；先核对脚本实际覆盖，禁止用「跳过」伪装绿色。
3. **INTERFACE-FIXTURES**：按官方表面建立版本化 scenario manifest，先复用现有 tests/fakes；首批只补缺口，不建立巨大新框架。
4. **C1/D1/D3 delivery**：由现有负责人继续，在统一基线上解决实际冲突并交付 M1。不要另起相同工作。
5. **C2 protocol + D2 consistency**：有了首个可运行产品交付后，推进协议闭环和持久性需求，各自独立验证。
6. **C4/C5 → M3，E2/E3/E5 → M4，F2**：随明确输入就绪开工；研究结果必须落到 fixture、代码、决策或删除一个不必要工作项。

## 7. 停止条件与长期续作

每个包完成 brief 的产出、适用检查、review 与远端读回后关闭。缺少真实账号不会让包无限等待：把该能力留在未认证状态，交付其余成果。

仅下列事情阻挡依赖它的动作：真实身份/权限缺口、不可恢复的数据风险、仍在运行且无法确认清理的自有进程、未解决的相关功能失败、实际代码冲突、需要用户决定的产品范围。其他独立包继续。

每个包最多两轮针对已发现缺陷的修复/复核；仍失败时记录可重现缺陷和最小下一步，不用反复更换测量档位寻找绿色。不得因为文档刷新、别的分支推进或一段时间经过而重新启动全量基准。

长时间工作按有限的 ready 队列推进。每次中断留下：当前 SHA、工作树状态、已完成用户功能、未完成项、测试结果与精确下一条命令。没有已授权且有输入的 ready 包时停止，不为保持忙碌而扩张任务。

## 8. 核验来源

- [固定基线](https://github.com/CartmanFatass/codex-hud/tree/4899b3f5802657520509e5c0db1918395b031257)
- [旧工程计划](https://github.com/CartmanFatass/codex-hud/blob/4899b3f5802657520509e5c0db1918395b031257/docs/universal-hud-engineering-plan.md)
- [pi 观察能力边界](https://github.com/CartmanFatass/codex-hud/blob/4899b3f5802657520509e5c0db1918395b031257/src/harness/pi/index.ts)
- [pi CLI 集成用例](https://github.com/CartmanFatass/codex-hud/blob/4899b3f5802657520509e5c0db1918395b031257/tests/unit/hud-pi-integration.test.ts)
- [Claude 持久 reader 升级](https://github.com/CartmanFatass/codex-hud/commit/4899b3f5802657520509e5c0db1918395b031257)
- [当前 CI](https://github.com/CartmanFatass/codex-hud/blob/4899b3f5802657520509e5c0db1918395b031257/.github/workflows/ci.yml)

官方接口资料与对应模拟边界见配套 [云开发手册](cloud-development.md)，其来源/版本仍需随实际采用的接口固定。
