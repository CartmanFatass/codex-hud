<!-- Oracle consult 1 (Codex gpt-6-astra, effort max), session 01a1987e; brief: tmp/tasks/ORACLE1/brief.md (git-ignored). Archived verbatim. Relative links point into tmp/ and are not in the repo. -->

# ORACLE1：通用 Agent HUD 架构裁决

评审基线：HEAD `7017db2`；概念 v2.3、工程计划 v1.1、契约 01/02 v0.2、03/04 v0.1。已纳入本轮追加的 [A8-fixB1 报告](../A8-fixB1/report.md)与对应原始证据；没有把它当成 A8 全部通过。本文是架构裁决，不代替实现主审或 A9 放行。

**裁决：保留事务账本、明确身份、每会话运行槽与每次运行的 supervisor；收缩尚未使用的协议。Codex 采用每次启动的 MCP 配置 env 注入作为主运输路径；B3b 采用修订后的方案甲，允许原生退出结果未知，并明确 supervisor 死亡会中断可见交互。当前仍不能冻结 A9。** 必须修改的契约共 **14 项（C01–C14）**，集中列于后文。不另行上送 Pro；按既定 A9 里程碑统一评审即可。

## 1. 九项编排者裁决

**结论：修改。** 概念 §15 的这一组包含八项实质设计，以及架构裁决路由；路由按 brief 不再表决。

| §15 决定 | 裁决与具体边界 | 理由 |
|---|---|---|
| `provisional:<runId>` | **追认。** 只用于明确创建全新会话的首次 spawn；resume/predecessor 必须用真实 ref。绑定与换槽同事务；真实槽冲突保留两份占有、两 run 进入 uncertain，并以真实 ref 阻断后续操作，直到冲突解决。 | 新会话的原生 ID 通常晚于启动产生，必须表示这段时间。provisional 不是对“未知会话”的全局互斥，也不能撤销已发生的两次外部启动；02:78 已正确说明这一限制。 |
| `owner_aliases` | **修改。** 保留有证据的单向 proc→session 归并、每代唯一与换代关闭；取消“复制一份幂等结果，再在每次调用查两套历史”。归并事务将该 proc 范围的幂等记录重键到 canonical session 范围，原 outcome/link/run/digest 不变，原范围留审计字段/归并事件；同键异参或异结果整体拒绝。之后只查 canonical key。见 C01。 | MCP 重启和晚绑定确实需要连续性；双份结果、关闭 alias 后的反查与 shared 特殊分支没有增加正确性，增加了写放大、查询分支和长期维护成本。 |
| 无子 MCP 的三证绑定 | **修改。** 三证是将来开启 observe_only 绑定时可接受的最低门槛，但该正向功能推迟到 v1.1。MVP 无 MCP 时只显示已登记委派及未确认子身份，run 仍可凭独立退出证据结束；不产生确定 SessionRef 父边、不准 report，不凭猜测 resume。见 C03。 | MVP 已要求双方加载 hud-mcp。为安装缺失再实现一套带消息锚点、时间窗与多文件冲突的正向绑定流程，收益小于成本；保留诚实的降级不损坏三项 A9 核心契约。 |
| 同 owner 的 `predecessor` | **追认。** 这是同一个 child 的新任务关系；旧关系历史化、新关系成为唯一当前父边、占槽和幂等提交必须原子。仅当前 owner、空槽且无未决冲突可操作，历史前驱不能再次转交。 | 明确了任务与会话的区别，不需要额外的跨主体授权协议。知道 linkId 仍不构成权限。 |
| `CallerId` + `caller_contexts` | **修改。** 追认物理连接与逻辑调用来源分离；MVP 只实现经验证的直接 stdio 路径，通用共享 daemon 的正向分派推迟。保留 context 表/类型这个扩展位置即可，不为未来共享模式提前实现整套状态机。必须按逻辑调用来源判断隔离，不能由“一个 TUI 一个 MCP”推导“一连接只有一个逻辑会话”。见 C02。 | 原生 subagent、同进程换会话也可能复用连接；是否经过 daemon 不是唯一分界。删掉这个抽象会返工，提前实现所有共享分支同样不合 G13。 |
| 受管范围 = 已核验 harness PGID | **修改。** 默认 PGID 合理，不升级成全机后代追踪。终结要求启动通道封口、原 harness 实例不再执行、已声明 scope 无活 workload；退出码允许未知。Z 状态可作为已终止未回收的成员单列，睡眠/停止/D 状态仍是活成员。普通范围外工具不扩大 scope；若确证原 harness 或同一 SessionRef 的旧写入实例仍在范围外运行，必须阻断复用，不能归入无害逃逸诊断。见 C07。 | 对一个本地 HUD，进程组是合适边界；“没有退出码”与“不知道是否结束”必须分开。当前无条件忽略所有逃逸、并声称不阻 resume 的文字过宽。 |
| 跨 owner 凭证内部先做、公开工具 v1.1 | **推翻其分期。** 整个 grant 协议、内部实现、DDL 与正向测试都移到 v1.1；MVP 只保留跨 owner 返回 unsupported 的拒绝规则。nonce/hash/单次消费作为未来设计笔记，不冻结成 schema v1 的负担。见 C04。 | 没有可用入口的授权协议不会帮助 MVP；为它增加的 `handover_grants`、epoch、撤销/过期/响应丢失规则已经扩散到四份契约。 |
| resume 不回 pending，独立 `runHandshake` | **追认。** 已确认的逻辑关系不因新一轮握手消失；新 run 新 claim/代次，child_ref 不可改，报告仍按 runId 授权。`runHandshake` 由该 run 的有效 binding/claim 推导，不另存一套可漂移状态。closed 的重开语义可保留为 v1.1 规格。 | 同时满足历史可视化和逐轮授权，成本低；旧报告、旧 claim 不能满足新轮。 |

## 2. G13：契约与运行成本是否相称

**结论：修改。** 1244 行、57 条不变量、138 个测试条目本身不是缺陷；其中约 448 行是可执行 DDL。真正过重的是 MVP 尚不可达的正向流程、同一事实的多套表示，以及把实现手段写成协议要求。SQLite、唯一约束和短事务应保留，它们比重新实现文件锁与并发恢复便宜。

MVP 的核心应收敛为：source/session/context 身份；run 级 claim；OwnerKey×request_key 的幂等；意图与槽同事务；单次执行权；R/N/Q 证据驱动的终结；run 固定的 report/wait；HUD 只读。caller 当前性、双 home、复制 claim、旧轮迟报和 uncertain 持槽不能为了减少行数删掉。

具体收缩如下：

- **移出 MVP：** 跨 owner grant、可恢复 close 的 surface 事务、no-MCP 正向绑定、通用共享 daemon 的正向调度、cgroup provider、sidecar 的受管执行实现。`jobs/leases` 的 Jev DDL与正向用例移到 C 前；A9 仍保留“运行槽不因 TTL 释放、browser 等结果对账、collect 可换代接管”的三类规则，不能把延期写成共用 TTL 锁。
- **减少重复存储：** owner 归并重键而非双写；`meta.json` 保存稳定的启动身份/范围，实时状态以 ledger 为准；部分 leader 观察作为 evidence，最终 `exit.json` 一次原子提交。恢复器提交 Q，不续写死 supervisor 的文件。不为 meta、exit、events、evidence 各实现一套完整状态复制协议。
- **收回实现自由度：** 02 规定单次执行与不确定窗口；04 规定需要哪些证据。不得强制所有后端都用“独立 launch gate + RUN 消息 + seal ack + 第二个观察器”。直接子进程路径可由唯一 supervisor 在提交 `submitting` 后只调用一次 spawn；只有维持组控制实例确有必要时，才使用一个随 run 结束的 helper。不能因此删除 fence 或把活着但暂停的启动者当作已封口。
- **合并测试主题：** 02 的对账表只测试一套真值表，03/04 引用它；状态组合用表驱动参数化。真实进程证据重点覆盖身份连续性、重复提交与崩溃切点，未来功能的正向测试不混进 A9 必过列表。删的是重复与不可达范围，不是反例。

运行预算必须变成可验收的口径，而非“后面再优化”：

| 成本 | MVP 契约要求 |
|---|---|
| 进程 | 每个实际加载 hud-mcp 的 harness 一个 MCP；每个活跃 run 一个 hud-run，shell 档案另有必要的启动 shell。默认没有独立 reconciler、轮询 sidecar 或通知 daemon。确有必要的 scope helper 单列计数/RSS，并说明寿命。终态或仅剩无可控进程的 uncertain 历史不养常驻观察者。 |
| 周期写入 | 沿用 04 的每 5 s 一次 heartbeat CAS：R 个活跃 run 的协议心跳为 **R/5 次逻辑 UPDATE/s**，十个 run 为 2 次/s。不是每 5 s 一次 event、evidence、meta、exit 各写一遍；正常只读 status/wait 不更新 last_seen 或写审计心跳。日志吞吐另计，不能把 SQL UPDATE 数冒充实际磁盘写次数。 |
| CPU / 进程检查 | 空闲主要阻塞等待。scope 发现允许有截止的启动期采样；正常存活期间不得每 100/200 ms 扫 `/proc`，退出、取消、恢复时再查组。A8 原型的 1 s 心跳及 200 ms group watch **不能直接成为生产实现**。 |
| 非 wait MCP p95 < 50 ms | spawn/resume 返回持久接受结果及 starting，不等 TUI ready、模型首轮或完整绑定；cancel 返回已接受的取消意图，不等 12 s 升级序列。status 走索引快照。单独记录 accepted→started/bound 的启动延迟，不能藏在 50 ms 指标外不测。 |
| SQLite 与事务 | 当前 `busy_timeout=5000` 对同步 `node:sqlite` 是明显的延迟风险。实时工具连接用短等待和受总响应预算限制的重试；预算耗尽明确返回 busy/未接受。文件读取、摘要计算、宿主 CLI、进程发现不放进 BEGIN IMMEDIATE；事务内重验所依赖的 context/版本/槽再提交。不得因锁竞争重发外部动作。 |
| 冷启动与 HUD | MCP 冷启动 < 200 ms，HUD 增量 tick < 50 ms；说明硬件、样本数、并发数、数据量与分位数。冷追赶与增量分开，先做最小 B 基准，再由 D4 扩展。cold start 不加载整个 HUD/reader/宿主模块图。 |

上述是设计预算，不是本次测得的性能。沿用 5 s/30 s 即可；为本地单用户工具引入更密的租约、全量事件总线或多进程共识没有收益。

## 3. Codex 身份路径

**结论：修改。可以用每次启动的配置覆盖，把 claim 送到 Codex 的 hud-mcp；它应成为主运输路径。daemon-present 不作为 A9 的必测前置条件，未验证的共享启动形态保持 unsupported。**

A3 不只是说“配置 env 可达”：`tests/probes/codex-mcp-launch.sh:31` 已经通过 `-c mcp_servers.probe.env=...` 给每次运行传入不同的输出位置；原始 start 记录确认 TUI 与 exec 收到配置键，未配置的 TUI C 收不到 shell 的键。因此“普通 shell env 不继承”与“配置覆盖后 env 不能用于握手”不是同一结论。官方文档也明确 `-c` 支持嵌套键、值按 TOML 解析，MCP `env` 用于 stdio 服务进程。[OpenAI Docs：单次配置覆盖](https://learn.chatgpt.com/docs/config-file/config-advanced#one-off-overrides-from-the-cli)、[MCP 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

示意如下，仅展示合成值；生产实现应构造 argv 与 TOML 字符串，不照抄为 shell 拼接：

```sh
codex -c 'mcp_servers.hud.env.HUD_CLAIM="synthetic-claim"' \
      -c 'mcp_servers.hud.env.HUD_RUN="synthetic-run"' \
      -c 'mcp_servers.hud.env.HUD_LINK="synthetic-link"' \
      -c 'mcp_servers.hud.env.HUD_HOME="/tmp/synthetic-hud"'
```

服务器名称来自启动档案；只覆盖 HUD 自有叶子键，保留已有 command/args、其他 env 与其他 MCP 服务器。A3 测过的是整张 probe env 表，不是“有用户既有配置时叶子合并”的完整集成；合并、参数引用、TUI/exec 的 resume 模板仍需小范围验证。**不能把探针的 `mcp_servers={}` 用法搬入产品。** `env_vars` 白名单也是官方提供的运输选项，但本次没有该版本的对应本机证据，不再为 MVP 增加第二套必备注入机制。

主路径分两层，契约必须写开：

1. **运输与启动实例：** hud-run 为每一轮生成新 claim，经 per-launch config 交到已知 hud-mcp；记录真实 harness 的 ProcessStamp、实际 source/home 和 run。resume 同样重新注入，不能复用旧环境里的 claim。`HUD_HOME` 也必须明确到达 MCP，否则测试隔离与多 HUD_HOME 会失效；Codex source 从启动档案及经核验的 harness 环境/存储根确定，不能用 MCP 自身缺失的 `CODEX_HOME` 猜。
2. **会话识别与授权：** claim 只关联 run；当前会话来自本次真正的 `params._meta` 或另一条经验证的精确会话来源。交叉核对 source 内的 rollout header、启动实例以及已有 child_ref；resume 必须仍是旧 ref。`params.arguments._meta`、模型参数 sessionId 和 prompt 文本均不是这个来源。多个会话字段冲突、来源缺失或出现原生子线程时不得沿用连接上次的 root 身份。

A3 的 spoof 证据是有价值的工程证据：伪造内容到达 arguments，真正 `_meta` 未被覆盖且与 rollout 一致。**我批准把“版本受限的直接 stdio + 已核验启动实例/source + 逐调用 metadata + 会话一致性”作为主绑定方案；不批准仅凭 `_meta` 字段存在授权，也不要求证明所有未来版本都不可伪造。** A9 仍需补齐首轮/fork、同进程切换与 resume 的判定证据；两个独立 TUI 的隔离不替代这些负向检查。未完成这些门禁时可以登记/claimed，不能提前宣称完整 bound 能力已验证。

启动时自动读到 claim 不等于启动时自动知道 session：P1 的 initialize 没有会话 ID，tools/list 也不足。可先登记并保留待绑定材料，在第一次有合格来源的 tools/call，或收到精确启动会话回执时，执行同一握手逻辑。正常 env 路径不必把 claim 明文再复制进 prompt。`launch_correlation_id` 可由 HUD 自己生成；harness 原生 message/call ID 若尚未出现，应允许为空并后填，不能要求启动前凭空知道它。

| 路径 | 明确规则 |
|---|---|
| 主路径 | 经验证的直接 stdio 配置；每轮配置 env 注入 + 独立启动/会话证据。支持范围写具体版本、启动档案与模式，不写“所有 Codex”。 |
| 运输 fallback | 配置 env 无法使用但 hud-mcp 确实存在时，本轮启动/续跑消息传 claim，子显式 whoami。独立身份门槛不变，不自动重启一次已经提交的任务。 |
| 身份 fallback | 精确且当前的会话注册记录/启动回执或限定 transcript 交叉核验；必须把进程映射到唯一 SessionRef。cwd、最新文件、daemon 时间配对不升级成授权。 |
| unsupported | 无法区分逻辑调用来源的共享 MCP；无法观察同进程会话切换的路径；来源/home 不明；未经验证的 daemon 代启形态；MVP 的 no-MCP 正向绑定。prompt claim 不能救活这些分支。 |

**不需要为了 A9 请求启动用户 daemon。** A9 可以用实际 direct-stdio 正向证据及 shared/unknown 来源的拒绝用例放行这一窄能力；01:185 中共享正向“必须实证”的要求应改成所声明能力的条件门。已有 daemon 的存在也不自动等于共享 MCP，应检查实际启动拓扑；只是当前 A3 不能据此宣称 daemon-present 组合已验证。将来要增加该组合，再取得所需授权和证据。

## 4. B3b 的可见模式方向与第二轮证据

**结论：修改后采用方案甲；淘汰方案乙作为 MVP 受管运行后端。不把 supervisor 崩溃后仍可交互列为甲的保证。**

A8-fixB1 改变了首轮结论：`normal`、`normal-exec`、`kill`、`pane-close`、`cancel` 的原始 receipt 都记录了经发现的 harness PGID 无活成员，shell 状态与 harness 结果分开。pane-close 的两个 Z 成员不再执行，不应为了等待其父回收而永久占槽。相比首轮只看 shell 退出，这足以支持选择甲的架构方向；但原型没有最终协议的全部域/代次/封口与稳定控制保证，不能直接把其 JSON 当成生产 R。

必须修正两个概念：

- **能确认运行结束，不一定能知道原生退出结果。** shell 版甲在这些样本中不能 wait harness，故 `harnessExitCode/harnessSignal=null` 正确。生产的 `runs.exit_code` 不得填 shell 的 0/130/137；shell status 单独留存。已核验 scope 终止可使 run ended/cancelled，任务结果另外取 report，不能因缺退出码把每个正常可见任务都判 uncertain。
- **父 MCP 断连与 supervisor 死亡是不同事件。** 默认 continue 必须使父 MCP 退出后子继续可用；supervisor SIGKILL 则是本轮监督故障。B1 已证明甲此时前台回到 shell，输入进入 shell，并出现 `suspended (tty input)`。应立刻/在失联检测后呈现 uncertain 与交互不可用，保留槽，停止自动 input/focus，禁止自动 fg、恢复 wrapper 或另开 resume。用户仍可查看诊断；结束旧 scope 并对账后才能新开一轮。这是明确的故障语义，不是假装无中断恢复。

乙的优点真实存在：sidecar 死后 TUI 仍前台且能接收输入。但**现有乙既没有受管范围结束证明，也没有可靠取消/启动收尾通道**；其局限不只是缺退出码。把正常路径全部变成 uncertain、每次靠人工处理，会直接破坏 G14。保留乙的探针作为反证/未来观察型模式材料即可，不在 B3b 维护第二套受管执行器；也不允许甲提交失败后改走乙再发一次。

第三选项的裁决：

| 选项 | 裁决 |
|---|---|
| `exec codex …` | **不能当通用修复。** 本机 codex 是 zsh 函数，B1 已实测其外部命令仍 fork；不是 supervisor 的直接子进程。不能把一个 exec 关键字当成拓扑证明。 |
| 受支持档案直接 argv / 最后一步 `exec /absolute/executable` | **作为可选简化路径保留，不另立架构。** 在经验证的完整包装链确实 exec 到 harness 时，可使其成为 supervisor 的直接子进程并得到原生 wait 结果；仍需正确前台组、后代范围及 context。不能改成让 hud-run 自身 exec 掉、同时继续承诺它保存退出回执。无需为了当前已可证明结束的 shell 路径强制改用户函数。 |
| hud-run 自有 PTY、终端代理、重接管 | **推迟。** 会引入输入转发、resize、终端状态、日志合流和 master 生命周期；也不会自动解决 master 持有者死亡。当前没有证据说明这些成本对 MVP 必要。 |
| “visible 只靠人工 reconcile 结束” | **只作为异常降级，不能作为正常产品路径。** reconcile 可以用新证据证明结束，不能按按钮编造结束或退出码。 |

第二轮及后续验证分工必须有界：

| 检查 | A9 前需要什么 | 已有证据与剩余范围 |
|---|---|---|
| 正常退出、kill、pane close、定向取消 | 被验证的 harness/PGID、无活成员、结果来源分离；组内仍有活子时不得给终结 receipt | B1 的五组 receipt 是正向证据；local drain 反例来自报告，仍需主审接受。不要重复消耗模型轮次重跑相同行。 |
| supervisor 死亡 | 明确记录前台变化、输入落点、无回执，并规定 uncertain/持槽/禁自动输入 | B1 已给甲、乙的对照证据。可以接受甲的中断语义，无须把它改造成透明接管后才允许 B。 |
| 父 MCP/launcher 退出 | 真正保留 TTY 的 TUI 或合成终端程序；父实例确实退出，子仍前台、可读输入、最终可收尾 | 旧 `sh -c '… &'` 无 TTY sleep 实验不够；这是 B2 尚须完成的正向场景。 |
| context wrapper | 一次实际由 Codex 执行的合成命令，核对允许列出的本 pane context，而不只检查 TUI argv/env | B2 补当前支持形态；daemon-present 的命令执行不另加为必测前置。 |
| Herdr 识别与交互 | 同一个 agent/session 的 ready、working、完成观测；不得把 shell idle 当 agent idle | B2 补足。无需为满足字面 idle 强迫 Herdr 输出它没有的状态；区分 done/已读投影，由 B16 统一解释。 |
| 生产 ScopeControl、性能、tmux/resume | 安全的整组取消、leader 先死而成员仍活、PID/PGID 复用、短命启动、重启恢复；无 200 ms 扫组 | 属 B3a/B3b/B14 的生产验收；A9 至少要有选定机制的合成进程可行性证据和明确失败分支，不能只写未来会有 anchor。 |

原型在组与 supervisor 共享时改发单个 harness PID，这不能满足“取消整个 scope”的正式能力。生产实现应分离相应组，或提供确实覆盖整个 scope 的控制办法；证据不足就返回 cancel_unconfirmed，不悄悄缩成 leader-only。任何加入 helper 或改变 exec 链的实现，都重验受影响的 TTY/context 行，不重跑无关的整套矩阵。

## 5. 其他 A9 阻断项与 B 阶段返工风险

**结论：修改；在下列闭环完成前不冻结。** 不扩大成全量功能验收，集中处理三项原有阻断项及其低成本前提。

**第一，恢复不能依赖已经死去的写者曾写过退出记录。** 02 的 Q 与 04:115 仍要求“独立原 leader 退出 receipt”。supervisor 被 SIGKILL、没有写出 receipt，后来 workload 全部结束，是正常的恢复用例；当前规则可能永远放不了槽。改为：可信启动记录固定 scope，所有可能继续提交的 launcher/控制通道已封口或确证死亡，原 harness 实例不再执行，正确 boot/PID 域的 scope 已完整证实无活 workload，且无矛盾证据，即可由 reconciler 记录 Q 并以未知退出结果终结。仅 leader PID 不见、仅 pane 消失或仅心跳过期仍不够。无法满足这些条件继续 uncertain；“人工”不替代证据。同机明确跨 boot 的旧进程终止也应有判定，不能把旧 PGID 对到新 boot。

**第二，启动封口必须包含仍能产生未来工作的中间 shell。** 如果 shell 还可能在 `sleep; harness`、循环或后台分支后继续启动，当前 PGID 空并不够。受管 shell 档案必须是经验证的单次前台 harness 启动形态；任意 shell 文本不自动获得完整托管能力。取消/回收需覆盖尚活着的启动者或取得其不可再提交的确认。反过来，对直接单次 spawn，不需要再凭空增加一个 RUN 分发服务。01 的逻辑 ProcessKey 也须明确包含 boot 身份（可编码入 pid_domain），与 04 的 ProcessStamp 对齐；PID/start tick 跨重启不能独立当永久身份。

**第三，调用者基数证据还不完整。** A3 证明两个 TUI 各起一个 MCP，没有证明同一 TUI/Claude 根下原生 subagent 调用不会经过该 MCP。若原生子调用只能看到根的环境/session 文件，就不能授权成根。MVP 可以只向可辨识的根上下文开放委派能力，但必须有可执行的隔离/拒绝路径；不能只在文档写“不支持原生子”而把它们的实际调用照常授成父。A9 的四条身份分支应包含这个反例，以及同进程切换后的当前性证据；普通进程 ancestry 与 env 不能解决逻辑多路来源。

**第四，A9 与 B 的依赖形成了文字上的循环。** 工程计划:80/192 说 A4 fixture 不证明真实进程恢复、B 才做；01:185、02:189 又把覆盖大量 B 过程的实证列成 A9 必过，而工程计划:89 禁止 A9 前合入 B。应把 gate 改成两级：A9 审查支持范围、可执行的事务/状态规格，以及最小合成进程原型和 A3/A8 的关键可行性证据；B3/B4/B5/B14 对生产实现重复这些关键反例并完成能力矩阵。A9 不能只有纸面 fixture，也不能要求全部 B 先完成。

A9 的最小证据包应明确到以下三组，而非要求当前 138 条全部实跑：

| Gate | 不可缺的证据 |
|---|---|
| 身份 | cc→Codex 主路径可构成唯一 source/session；claim 配置运输；fork/旧 claim 不授权；同进程切换失效；MCP 重启 OwnerKey 连续；共享/不可辨来源明确拒绝。对尚不支持的 daemon/no-MCP 分支验证拒绝，不要求正向集成。 |
| 执行 | 真实临时 SQLite + 合成进程：并发同键只一次提交；同键异参拒绝；意图/槽同事务；绑定归并后重放原结果；意图提交后、提交前后和回写前的崩溃切点不重复启动。不能只用单进程内存对象模拟互斥。 |
| 恢复 | 已选可见机制的 A8 接受证据；正常 scope 结束、活成员阻止终结、取消未确认持槽；supervisor 死后 Q 可达或明确缺哪项证据；恢复只观察/收尾，不取得新执行权。原型证明机制可行，生产能力仍等 B 验证。 |

wait 还须消除一个容易进入 B 才发现的接口缺口：最大 120 s 不能超过实际 harness MCP 调用超时。05 应规定协商/配置后的有效上限与余量；不满足时用较短有界 wait，返回相同 runId/游标。官方 MCP 配置有 `tool_timeout_sec`，文档默认值为 60 s；这里必须以所支持客户端的实测配置为准。[OpenAI Docs：MCP 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。不允许客户端断线被解释成取消或失败。

04 已禁止常驻 reconciler，但还要写清恢复怎样被发现：现有 hud-mcp 启动/重连、相关运行事件、wait 的必要截止、显式 reconcile 触发有预算的恢复；发现遗留 receipt 就幂等导入，发现无 receipt 的旧 run 就按同一表取证。status 保持只读。无活写者时 HUD 可以显示 stale/uncertain，不声称后台已自动收尾。wait 的文件通知还要避免被每个 heartbeat 的 WAL 变化放大为所有 waiter 全量重查；通知只是提示，游标是事实，漏通知在有界截止复读。

## 必须改的契约条目

以下 **14 项** 是完整变更清单；同一项跨文档同步算一项。追认的核心不变量不另计新增要求。

| ID | 契约 / 定位 | 必须修改 |
|---|---|---|
| C01 | 01 I-01-9、§owner_aliases；02 §幂等参数与查询顺序、I-02-1、T-02-4/5、DDL | 以原子重键和审计替代 proc/session 结果复制；冲突仍整体拒绝。正常查询只用当前 canonical key，不反复扫描关闭 alias。 |
| C02 | 01 CallerId/context/ProcessKey、I-01-2/10/12、四路径表；02 caller_contexts | 保留物理/逻辑分离；明确逻辑多路不只来自 daemon。MVP 正向范围收窄，原生子/来源缺失不得冒充根；ProcessKey 与 boot/PID 域对齐。共享正向实现与验收后置。 |
| C03 | 01 I-01-11、T-01-29–31；03 observe_only 分支 | no-MCP 三证正向绑定移 v1.1；MVP 只保留未确认身份展示及拒绝授权，run 的退出证据不依赖绑定成功。 |
| C04 | 02 handover_grants、close 字段、jobs/leases DDL；03 I-03-9–12、grant/close 小节 | grant/close 的完整内部协议与正向测试移 v1.1；Jev 存储/实现移 C 前。MVP 不冻结不可达表与操作；保留拒绝规则、历史兼容说明和三类租约的不同释放原则。 |
| C05 | 01/04 Codex env 开放项；05 启动档案 | Codex 主运输改为每轮配置 env 注入；定义服务器名、叶子覆盖/保留配置、HUD_HOME/source、resume 新 claim、运输 fallback。删除“env-claim 对 Codex 不可用”的绝对表述。 |
| C06 | 01 resolver/claim/消息锚点、I-01-3–5；02 launch_message_id；04 初始化 | 写定版本受限的组合身份路径及 `_meta` 的真正位置、参数伪造拒绝、首次 tools/call 才具备的来源。区分 HUD 自生成 correlation 与晚到的原生 message ID；正常 env 路径不强制 transcript 扫描或 prompt 明文 claim。 |
| C07 | 02 R/G/N/Q/X 与 R-02 表；04 scope/ScopeCheck/生产表 | 区分结束事实与退出结果；Q 不强求已死 writer 的 leader receipt；完整 scope 无活 workload + 原 harness 结束 + 所有启动者封口才能终结，结果可 NULL。定义 Z/停止状态、跨 boot、已证实旧 session 写入者的冲突边界。 |
| C08 | 02 执行权/提交围栏；04 launch gate、ScopeControl | 改成结果与证据约束，不强制额外 gate/helper 拓扑。唯一 supervisor 单次提交、不可重领票据与封口继续保留；中间 shell 也是可能的启动者。整组取消不能降成单 PID，失去安全控制能力只报 unconfirmed。 |
| C09 | 04 文件字段/原子提交；02 退出字段语义 | meta 只保留必要身份/范围；部分退出事实留 evidence；最终 exit 一次原子提交，恢复用 Q，不要求多 revision 退出文件协议。runs.exit_code 只表示有来源的 harness 结果，shell status 分列；保留 fsync/rename 后幂等导入。 |
| C10 | 04 可见模式；05 能力矩阵；概念 §6.6.4、计划 B3b | 选择甲的组终止路线，写明原生结果可未知与 supervisor 死亡会中断交互；乙不提供 MVP managed 能力。父断连 continue 单独验收；不能用未测 exec/PTY 替代证据。 |
| C11 | 02 busy_timeout/事务边界；03 I-03-14；04 I-04-15；06 性能预算 | 采用本评审的进程/逻辑写入/CPU/延迟口径；短 SQLite 等待，外部 I/O 不占写事务；快速返回 accepted 与异步启动分开计时；禁止原型 200 ms 扫组进入生产。 |
| C12 | 03 wait；04 恢复触发；05 timeout；06 唤醒预算 | 固定 run/游标规则不变；有效 wait 上限适配客户端超时。定义现有进程内的通知、漏通知截止复读、启动/重连恢复及 heartbeat 唤醒合并，不新增通知服务或按秒全量对账。 |
| C13 | 01:185、02:189、四契约测试清单；计划 A4/A9/B3–B14 | 每项用例标 A9 原型/fixture、B 生产验收、C 或 v1.1；消除 B 实现先于 A9 的循环，合并重复真值表，保留三组最小真实证据。 |
| C14 | 01–04 头部开放项；05 支持表；概念 §15–16 | A3 更新为已评审的有限结论，不能继续称“尚未评审/未做 spoof”；A8 标明首轮不通过、B1 局部进展及 B2 缺口；daemon-present 正向非 A9 必测。支持状态绑定版本/证据快照，文档不把尚未验证的格写 pass。 |

## 可删或推迟

| 项目 | 去向与理由 |
|---|---|
| grant 的 nonce 格式、签发/撤销/过期/丢响应全协议及 DDL | v1.1；MVP 无入口，当前只需要拒绝跨 owner。 |
| close 的取消→关 surface→完成事务、close 重试与 owner_epoch 联动 | v1.1；MVP cancel、历史保留已经覆盖当前需求。保留 closed 的未来语义，不要求现在实现生产入口。 |
| no-MCP 自动绑真父边 | v1.1；无插件时保留运行与候选可视性足够，不能牺牲身份门槛。 |
| shared daemon 正向多 context 调度 | 新能力立项时；保留 context 抽象与拒绝分支，避免现在实现未观察到的拓扑。 |
| Jev jobs/浏览器租约实现与全部正向测试 | C 前；只保留三类资源的不同语义，不能阻塞 cc→Codex。 |
| cgroup provider、所有后代永不逃逸、跨机器/PID 域主动控制 | 后续；本版是本机已验证 PGID 范围，其他域 unknown。 |
| sidecar 受管执行、PTY tee/自有 PTY、supervisor 崩溃透明重接管 | 后续；常态甲能提供证据，罕见故障诚实中断即可。乙保留为探针材料。 |
| 双份 idempotency、周期 evidence/meta、渐进 revision exit 协议、重复对账真值表 | 直接删/合并；不改变核心不变量，减少写入与分支。 |
| 父 pane 自动提示、完整 fork 谱系、通用 ask/send 与更多布局 | 沿用既定延期；一次 spawn + 有界 wait 已满足协作入口。 |

不删：持久幂等、槽与意图同事务、未知不重发、真实实例核验、逐轮权限、nullable 退出结果、手动 reconcile 入口、最小采集一致性、外发材料的来源边界。这些直接保护既定 MVP，成本也可控制。

## 你核实过的事实

以下区分本次读取核实、已有报告的实验结果和未做事项。

| 文件 / 只读操作 | 本次结果 |
|---|---|
| `tmp/tasks/ORACLE1/{role,brief}.md`；本轮追加的 B1 说明 | 核实只读咨询、仅写本答复、不派生 agent、不运行探针的范围；已按新增证据调整问题 4。 |
| `git log -1 --format='%h %s'` | 返回 `7017db2 docs: contracts 03 lifecycle and 04 supervision v0.1, 01/02 v0.2 (A1 batch 2)`。没有执行 Git 写命令。 |
| `docs/universal-hud-concept.md` 指定章节；`docs/universal-hud-engineering-plan.md` 的 authority、A/B、验收与依赖条目 | 核实 G13/G14、八项设计裁决、A9 门禁和生产进程测试排期，定位 A9/B 依赖冲突。 |
| `docs/contracts/01-identity.md` 至 `04-supervision.md` 全文；Python 只读计数/哈希 | 共 1244 行、18 张 DDL 表、57 个不变量 ID、138 个测试 ID；四份 SHA-256 与 batch2 报告相同，前缀分别 `f30a6018eec9`、`0c5b9ee35090`、`a96284c5c2e5`、`6217b5204ac9`。 |
| `tmp/tasks/A1/report.md`、`report-batch2.md`；三份 `docs/reviews/2026-11-01-*` | 读取先前判定与修复处置。其 SQL/引用检查 PASS 是已有报告结果；本次没有重跑或冒充运行协议已验证。 |
| A3 五份 `docs/probes/` 报告 | 核实已记录的版本/模式范围：Codex direct-child 且测时 daemon absent、配置 env 可达；双 home 隔离；Herdr 只测 Codex tab-root/pi split；cc env/会话文件；pi resume 同文件而 fork 新 ID。 |
| `.codegraph` 目录检查；`codegraph explore "tests/probes/codex-mcp-launch.sh mcp_servers.probe.env overrides; tests/probes/lib/mini-hud-run.mjs groupMembers discoverHarness"` | 目录存在，但 CLI 报无可用 index，退出 1。没有索引；之后才用 `rg` 读相关代码片段。 |
| `rg -n -C 3 … tests/probes/codex-mcp-launch.sh`；A3 的 `tui-a/b/c.jsonl`、`exec.jsonl`、`spoof-check.json`、`daemon-liveness.txt` | 核实 per-launch `-c ...env` 已用于探针；TUI A/B/exec 的 env 有两个 probe 配置键，C 没有；MCP 的直接父为各自 Codex；spoofInArguments=true、spoofInMeta=false、metaMatchesRollout=true；本 home daemon 前后 dead。未复制真实会话正文到本答复。 |
| `tmp/tasks/A8/review.md`；`tmp/tasks/A8-fixB1/report.md`；`docs/probes/hud-run-visible.md` | 核实首轮拒绝、B1 修复与未完成项；本次读取的 B1 报告 SHA-256 前缀 `958a57593810`，A8 文档 `b8aca7a9759e`。B2 后续变化不在这个快照的接受范围内。 |
| `tmp/tasks/A8/evidence/hud-run-visible/jia/{normal,normal-exec,kill,pane-close,cancel}/run/exit.json` | 五份都记录 `group.empty=true`、无活成员；shell 状态分别 0/0/137/1/130，harness 原生 code/signal 均 null。pane-close 单列两个 Z；cancel 记录一次已核验的 group SIGINT。确认的是保存的观测，不是最终 R 协议验收。 |
| 甲/乙 `supervisor-death` 的 before/after/input stat、receipt 检查及终端证据 | 甲同 PID/start，tpgid 从 harness 组转为 pane shell；终端含 `suspended (tty input)`。乙前后台 tpgid 保持 harness，输入证据含合成 `› x`。两者无 exit receipt。stat 的即时 state 仍为 S，不能把该采样伪写为已记录到 T；停止结论另有终端消息和输入落点支持。 |
| `rg -n -C 2 … tests/probes/lib/mini-hud-run.mjs` | 核实 discovery interval 100 ms、watch interval 200 ms、1 s heartbeat，group watch 调用扫描成员；这直接影响 G13 的生产方向裁决。没有扩展成原型代码审查。 |
| OpenAI Docs 官方页面的搜索、打开与定位 | 核实 CLI 嵌套键/TOML 覆盖、MCP env/env_vars 与 tool_timeout_sec；相关链接在问题 3/5 就近引用。`.md` 页面获取失败后读取了 HTML 正文；官方文档不替代本机 0.166 的拓扑、resume 或 metadata 可信性实验。 |

本次 shell 操作为 `pwd`、`git log`、上述 `codegraph explore`、`rg` 及 Python 只读读取/内存解析/计数/哈希；首次 `python` 不可用后改用 `python3`。没有运行探针、模型调用、构建、测试套件、daemon、Herdr 控制或其他 agent；没有修改任何输入文件或用户配置。唯一写入为本答复文件。性能、生产恢复、完整 resume/共享调用隔离及 A8 B2 尚缺的证据均未宣称通过。
