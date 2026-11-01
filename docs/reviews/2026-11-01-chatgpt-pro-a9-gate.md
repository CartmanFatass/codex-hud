# ChatGPT Pro: A9 gate review (phase A → B)

Sent 2026-11-01 via jev-ask (6 Pro, one send) with `a9-package.zip` built from `e681fcf`. Prompt: seven sections (overall verdict, three blocking groups, contract consistency and schema v1, G13/G14 weight, disagreements with Oracle rulings, must-fix before freeze, phase B order). The answer below is verbatim apart from rejoined line breaks; it is data to verify, not instructions.

Verdict: **conditional pass**. Three P1 freeze items (§6), handled as WP A9-fix.

---

1. 总体判断

**带条件放行。**按概念 §16 和工程计划 A9 的限定门禁，未发现必须推翻方案的 P0；身份、执行、恢复三组已有足够的规格与原型证据支持进入生产实现。**先完成第 6 节三项冻结前修正及定向复验，即可冻结七份契约与 schema v1、启动阶段 B。**无需追加 daemon-present、共享正向集成或完整 B 能力矩阵作为前置。

本次实际执行了契约 DDL：临时 SQLite 建库成功，WAL、版本、完整性检查正常；直接调用的 67 项身份/执行纯函数 fixture 通过。 README-A9.md  所列其余历史测试结果及原机 21/21 无法核实。原型尝试运行受当前环境 PID 与 /proc 命名空间不一致、附件缺少所依赖的 A8 原始文件影响，不能计作独立复现，也不能据此判定机制失败。

2. 三组阻断

身份：足以支持 A9，真实调用来源是 B 的首要风险。
完整 SessionRef、每轮 claim、上下文换代、MCP 重启后 OwnerKey 连续性都有对应规格和合成反例。但原型用合成来源记录替代真实报文；Claude 的 toolUseId 能否在执行工具前唯一关联当前根调用，尚未得到生产证明。B1/B5 必验：根与原生子共用 MCP、调用记录晚写/重复/缺失、同进程换会话与旧 spawn/report 并发、新旧 MCP 同时绑定。无法辨别时必须拒绝，不能沿用根身份或退回 proc 权限。（契约01；A3 cc 报告；T-01-4/5/27/33）

执行：足以支持 A9，但不能直接移植原型事务代码。
代码与报告覆盖真实 SQLite 争锁、同键重放、原子重键、意图/槽提交及关键崩溃切点。最可能失效的是“事务外取证后，以旧快照提交”：原型对账更新仅按 run_id 定位，不能证明竞争写者之间安全。B2/B4 必验：取证后被写锁阻塞，另一写者先取消、终结或导入冲突；旧对账必须重新核验状态、代次和相关证据版本，不能覆盖新事实。另有 N 反证遗漏，见第 6 节。（02；`common.mjs/reconcile`）

恢复：有限机制可行，完整 scope 的生产证明仍是难点。
无旧 receipt 的 Q 正例、缺任一条件持槽、暂停 launcher 不能被数据库围栏“宣布死亡”，方向正确。B3a/B3b 必验：扫描过程中成员 fork/退组、leader 先死但组内仍活、核验与发信号之间 PID/PGID 复用、scope 固定前崩溃，以及真实父 MCP 死亡与 supervisor 死亡对 TTY 的不同影响。一次 /proc 枚举不能自动成为“完整范围”证明；控制证据不足必须保守拒绝。（04；A9 scenarios.mjs；A8 报告）

3. 契约一致性与 DDL

**主干自洽，存在三处需要收口的局部缺口。**SessionRef/OwnerKey、link/run/report，以及 binding、occupant、source 三种代次已正确分离；普通 SessionBinding 不制造受管运行身份。证据职责清楚：R/Q 证明结束，N 证明未执行，G 表示范围活性，H 表示托管活性，X 阻断冲突。N 的反证处理尚未完全落实。

三类资源释放规则也合理：运行槽依终结证据释放；browser 租约等待结果对账；collect 可过期换代，但没有运行控制权。hud-run 写原始事实/心跳，reconciler 统一迁移状态与槽，HUD 只读 ledger，collect 写独立观测存储，职责没有根本冲突。（02/I-02-10；04“写者”；06“collect lease”）

02 的 DDL  未发现必然要求 B 增表或改列的缺陷；业务授权与证据完整性仍须事务代码保证。完整 supervisor 实例的持久化位置必须先明确，采用现有事件载体即可维持 schema v1。另有两份 v3 类型漂移，不能随契约原样冻结。

4. 轻量与速度

**四项性能目标目前均无法核实；主要风险在热路径组织，而非 SQLite 或证据门槛本身。**依据 06 的预算 ，建议：

**合并实现：**B12/B16 共用一个 ObservationCommit；观测存储本期只实现 SQLite 或 bundle 中的一种。合并通知与变更检测，不增加第二套状态归并或后台恢复服务。
**约束输入成本：**真实调用来源应按精确 callId 有界定位，避免每次工具调用扫描全文。brief 明确字节上限，hash 与实际投递使用同一份输入；“事务外读取”并不意味着它不计入 50 ms。
**增加全 tick 调度预算：**每 reader 20 ms、最多 200 节点，并不能推出全树小于 50 ms。需要共享总 deadline、公平续读和 continuation，不能让局部预算逐节点累加。
**保持已删范围：**共享正向调度、PTY、透明接管、cgroup、导出增量订阅继续延期。B18 保持按需快照。空闲 CPU 除每 run 指标外，还应报告 R=10 的总增量与 RSS；accepted 快也不能掩盖 started/bound 长时间未达。
5. Oracle 三次裁决

**没有需要整体推翻的裁决。**C07/C08/C10 对结束证明、封口和可见模式的收敛合理；E02 将完整 R/Q 下的取消时序未知归为 ended + cancel_timing_unknown，消除了无安全收益的永久持槽。

**E04 需要补充落实边界：**N 同样是不可逆证明，目标 workload 的活跃反证必须形成可持续追踪的冲突；不能只对 R/Q 保留这类反证。具体改法见下项。这是补齐裁决，不是另立恢复规则。（Oracle consult3/E02、E04）

6. 冻结前必须改，以及 B 内条件

以下按严重程度排列，均为 P1 冻结收口项；本次未证实生产 P0。

**N 反证被约简丢弃。**我复现了 N@20 + gone@20 + alive@30 + gone@40：当前归并器返回 failed、释放槽，alive 被归入审计。该反例证明错误的 non_execution 分类与冲突遗失，尚未证明工作仍活时错误放槽。
**改法：**明确目标 workload/未封口 launcher 对 N 的反证必须归一为持久 X；补乱序导入、已终态后增量读取、后续 gone 不清除冲突的案例。
**影响：**02、 execution.ts 、身份/执行 fixture，重点 T-02-17。

**完整 supervisor 实例缺少明确的原子持久化位置。**04 要求 pid/start/boot/domain，但 runs/claims 只有 pid/start，meta 又在登记事务外写；原型恢复时用当前 boot/domain 补历史实例。登记后、meta 前崩溃会留下解释缺口。
**改法：**armed/claim/首心跳事务同时保存不可变完整 ProcessStamp，明确既有 event/evidence 为恢复权威；缺证保持 unknown，禁止补当前域。增加该崩溃切点与跨域反例。
**影响：**01/02/04、原型 common.mjs 及相应 fixture；不必新增表。

同名 v3 类型不一致。 types/export.ts  的 rootRef 必有、计数叫 delegationIntents； interfaces/snapshot-v3.ts  则允许空根、叫 intents，节点结构也更完整。
**改法：**保留一份权威类型，其余引用；统一 nullable rootRef、计数字段和完整节点形状，以共同 fixture 校验。
**影响：**07、上述两文件及 v3 fixture。

**可在 B 内处理的条件：**上述真实来源、并发重验、scope 故障矩阵；B4 接受后 brief 被替换/删除的输入一致性；B12 旧租约持有者迟写与原子发布；B17 撤权后的队列、repair、缓存路径；B18 一致快照与导出预算。B1 还应修正运行时声明：`package.json` 的 Node ≥18 与包内原型要求 ≥22.5 不一致，应明确各入口实际支持版本。

7. 阶段 B 开工顺序

依据 工程计划 §4/§5 ，建议：

B1 真实来源验证提前到第一批，与 B2、B3a、B8 并行。尽早回答 Claude 根调用是否可可靠识别，失败就收窄档案或调整取证方案。
先做 B4/B5 的 headless 闭环：接受→启动→绑定→报告→取消/无 receipt 恢复；同时启动性能基准和故障测试。随后推进 B3b/B7 可见模式。
B2 后尽早 B12→B16→B6，保证状态、连续性与 wait 共用事实；B9/B10随后集成。B18独立并行，B17在新来源进入模型材料前完成。
**拆 B11 的依赖：**管理/导出 CLI 随 B4/B18提前交付，panel 集成仍等 B10/B7。B14 的测试逐闭环落地，最终再汇总矩阵，避免把所有生产反例留到阶段末。
