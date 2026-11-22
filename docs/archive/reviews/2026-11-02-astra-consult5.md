# Oracle consult 5: phase B batch 2 forks

Codex gpt-6-astra, effort max, read-only, 2026-11-02, baseline `6513f35`. Brief: hud-run helper memory (B3a), MCP resume expectedRun and capability cells (B45), B12/B18 integration seams, the two pid_domain encodings, Codex checkpoint size (B12). Verbatim answer below; G01–G11 are the required changes.

---

# ORACLE5：阶段 B 第二批分叉裁决

核对基线：主检出 HEAD 6513f35，包含 B45 合并 8444de7、B12、B18 及 F08 Pro 增补。适用基线仍为 A9 + consult4 + F08 Pro；本轮是设计裁决，不是完整代码审查或生产能力放行。B3a/B12/B18 报告中“未提交”等文字是各包交付时的历史描述，以主检出的合入代码判断接口。

本轮要求 **11 项契约变更，G01–G11**。不重开 A9，不修改 ledger schema v1，不放宽 F08 的 150/50/30/10/20 ms 门槛。所有实测数字来自已存在的报告或合成证据；本次没有运行探针、测试或其他模型。

## R1：hud-run helper 的内存与原生退出结果

**裁决：修改。选择 session-leading sh、允许 native exit unknown 的轻量 headless 方向；不接受第二个完整 Node 运行时作为无需再处理的 MVP 默认成本。现有 Node 实现保留至替代实现通过定向验收，不把它立即替换成未经验证的 shell。新解释器依赖和 native helper 暂不立项。**

依据不是“精确退出结果不重要”，而是 04 已明确区分两件事：完整 scope 结束证明是必须的；原生 code/signal 在没有可信来源时本就可以为 null。以约 60 MiB/run 的额外运行时去避免一个协议已经允许的 null，不是当前最小方案。与此同时，不能用减少 RSS 换掉组实例安全、单次提交、启动封口或输入/环境契约。

已有证据只证明一个窄取舍：session-leading sh 约 2 MiB，但正常 exit 137 与 SIGKILL 都得到 shell wait status 137；它没有证明生产取消协议已经可用。exec-launcher + 可移动 reader 的反例则已直接击中错误目标：reader 被移进 decoy group，INT 命中 decoy 而未命中 harness。后一拓扑推翻，不继续采用。

### G01：轻量 helper 与退出来源

在 04「运行、启动输入和范围」「文件、字段与原子提交」、I-04-4/7/9/15、T-04-10/23/38 增补，并在 05 能力格证据中引用：

> headless 的必要 scope helper 优先采用随 run 存活、保持真实 session/group leader 身份的轻量实现。helper 只消费一次受保护的提交输入，关闭后不可重开；执行权仍只有原票据的一份。组信号由经核验且不能被移组的本组 leader 发出，不改为父进程核验后向可复用数字 PGID 发信号。POSIX shell wait status 不构成 harness 的精确 code/signal；缺少独立原生结果时 native_exit=null，正常完整范围结束仍按 R/Q 进入 ended，reason=scope_ended。

具体落点：

- B3a 后续小包 **B3a-R1** 拥有 src/core/run/process.ts、group-helper 的轻量替代、control.ts 及相应进程测试。保持现有 GroupProcess 的单次提交/整组控制边界，不引入新的 supervisor、票据或恢复服务。
- GroupExit 改成带来源的判别结果，至少区分 verified_wait 与 native_unknown。control.ts 只有在 verified_wait 的 subject stamp 与实际 harness 完全一致时才构造 native_exit；不能继续仅凭“argv + 同 PID”把 sh 的编码 status 写成 wait_status。
- sh 自身的 wait 编码最多是有来源的私有诊断，不冒充 harness exit_code，也不冒充另一个实际启动 shell 的 ExitObservation。没有可合法投影的 shell 结果时 shell_exit 同样可为 null；不为保存 137 新建一套退出协议。
- 保留原来能取得精确原生结果的路径及其断言；新增 unknown 路径的断言，不把全部结果统一清空来掩盖错误。
- sh 必须保持固定控制词表、无 eval、无 brief/prompt 代码拼接、stdin 与控制通道分离，并保持原 argv 字节、cwd 和用户环境。报告已记录 shell bootstrap 丢失导出函数/dotted env、改写 PWD 的反例；因此不能简单在当前启动命令外包一层 sh 就算完成。INT/TERM 的 trap、子进程继承的信号 disposition、wait 被中断、EOF 后封口及回收均须验证。
- 这项选择针对 headless。B3b 的可见路径仍按修订甲核验 TTY 前台消费者，不能把 detached headless 拓扑搬进可见模式。

若 B3a-R1 不能同时保住环境、取消、封口和组实例性质，保留当前未放行实现并带具体失败证据回报 ORCH。接受约 1.2 GiB 的默认成本、删减既有启动档案，或把新增 native/解释器分发负担纳入 MVP，应上送 Pro 作产品成本/范围取舍；本裁决不预先授权这些替代。

### G02：B14 必测的资源口径

补 06 P-06-1/2/3/9、T-06-11–16 和工程计划 B3a/B3b/B14 条件：

- 使用正式 B45 启动链和真实 B2 ledger，分别测 H/R=1/1、2/10；supervisor、helper、必要 shell、MCP 分列进程数、稳态/峰值 RSS、寿命与回收。能取得 PSS/私有驻留量时同时报告，不能把逐进程 RSS 相加直接称为唯一物理内存占用。
- 空闲测满 300 s、至少 60 个心跳边界；报告每 run 和 R=10 总 user+sys CPU、真实 WAL/磁盘写入、逻辑心跳次数及额外事件。B3a 的 60 s/file-fake 结果不是此项通过证据。
- 按 06 原样采集启动分布及未达到数，分开 accepted、dispatch、真实 harness started、bound、ready；helper 启动和 IPC 成本不能从中剔除。报告替换前后的同环境对照，不把 sh 原型的 2 MiB 当作新生产链的实测。
- 定向重验 exit 137/SIGKILL、leader 先退而成员仍活、helper 死亡/EOF、INT/TERM/KILL、fork/退组/复用、提交后 scope 固定前崩溃、父 MCP 与 supervisor 死亡。B3b 另验真实 TTY/context/环境，不重跑无关身份和导出矩阵。

核实的现状是优化后 R=10 两类进程合计 RSS 1,246,576 KiB，约 1.19 GiB；其中 helper 612,816 KiB。报告的“1.25 GB”是近似值，不是新预算。现有契约没有数字化 RSS 上限，本轮也不凭四舍五入数值虚构一个已经越过的硬阈值；G01 是对默认实现成本的明确收敛要求。

**落实/阻塞：**B3a-R1 落 G01，B14 落 G02。B3b 可继续 TTY/context 工作，但共享退出结果接口须采用 G01；B6 可继续实现，helper 相关取消能力和 B14 的 headless 格不得在替代方案验收前升 verified。B16、B11 的导出/管理接线及 B13 文稿不因此停工。

## R2：MCP delegate_resume 是否增加 expectedRun

**裁决：修改。增加可选 expectedRun；省略时保留事务选择当前 run 的语义。本地 resume 继续必填。**

B45 的当前做法能防止并发占槽，不能表达“我只想续刚看过的 r1”。例如父端读到 r1 终结，另一合法调用已经让 r2 启动并结束，迟到的新 request_key 仍可能再续一轮。这不是重复提交同一个幂等键，却可能违背父端的意图。A4 已有 expectedRun 门禁，增加一个可选前提比要求父端靠时序猜测便宜。

代码中还存在事务外 previous.run 的准备过程；planResume 对 generation/runSeq 的检查能拒绝部分在途竞争。这不能替代调用者显式钉住此前看到的 run，也不能被描述成“事务内可以安全改用任意更新轮次”。

### G03：可选 compare-and-set 前提及重放顺序

修改概念 §6.6.1/§15、02「幂等参数与查询顺序」/I-02-1/16/T-02-34、03「resume 与 handover 事务」/T-03-37：

> delegate_resume 接受 expectedRun?:RunId。提供时，它是新意图的 currentRun 前提并进入 params_digest；未提供时维持原参数规范化，不能把后来查到的 currentRun 自动填进摘要。先验证当前调用权限，再查询 OwnerKey×request_key 的原结果；同参重放先于新意图的 expectedRun/槽/能力门禁。仅无原结果时比较 expectedRun 与事务内 currentRun，不符返回 expected_run_mismatch，零新 run/claim/slot/外部提交。省略不表示钉住先前 status 的轮次。

具体落点：

- packages/hud-mcp/src/tools.ts 增加可选属性和 RunId 校验；delegation.ts 对 MCP/local 两种入口均只在实际提供时纳入 expectedRun；CLI 的必填条件不变。
- src/ledger/intents.ts 使用 supplied expectedRun；MCP 未提供时才取事务内 previous.runId。保留已有 preparation→transaction 的 runSeq、目标 ref、绑定代次及档案前提重验，不因省略参数把旧准备材料重新贴到新 run。
- 沿用 src/core/lifecycle.ts 的 resumeGate/prepareResume，不新增第二个 resume 状态机，不改 params_version=1 的旧请求编码；“缺省”与“明确提供”是不同参数。
- B13 模板在基于 wait/status 结果决定续跑时默认携带所看到的 runId。expected_run_mismatch 要重新读取并重新作决定；不得自动换 key/换 expectedRun 连续重试。

定向断言：旧键重放在新轮已出现后仍返回原 run；同键改 expectedRun 冲突；两个调用者先读同一 run、不同 key 竞争时最多一个新意图；另一个 run 已启动且结束后，旧 expectedRun 仍拒绝；缺省兼容及本地必填继续成立。

**落实/阻塞：**新小包 **B45-R2** 落工具/事务/契约，B13 使用新可选参数。阻塞 B13 的最终协议模板与 B14 的 resume 验收，不阻塞 B6 的 wait/status、B3b、B16 或 B11 已有必填 expectedRun 的本地入口。

## R3：随代码发布的能力格文件

**裁决：追认受信、随代码发布、默认全 unverified 的方向；修改为明确的共享 manifest 契约和生产版本取证规则。B45 的真实闭环不能自行晋级产品格。**

当前文件为空、main.ts 使用 b45-unverified 且没有可信 executable version，是诚实的未放行状态。把路径限制在代码/受信发布组合层、拒绝 HUD_HOME/delegate.json 指定证据文件，方向正确；无需增加签名服务、远程能力注册中心或在线验收开关。

### G04：manifest v1 与晋级边界

在 05「能力格与证据快照」、I-05-1、T-05-1/2 增补；src/core/types/capabilities.ts 定义唯一 CapabilityManifestV1，src/core/launch/capability.ts 消费：

~~~ts
type CapabilityManifestV1 =
  | { version: 1; hudRevision: null; cells: [] }
  | { version: 1; hudRevision: string; cells: CapabilityCell[] };
~~~

具体规则：

1. 保留 256 KiB/128 cells 上限；未知版本、错误结构、重复完整键、缺失或矛盾证据不能选出 verified 格。null revision 只用于空的未验证 manifest。文件可含 unverified/unsupported 格，加载不自动升级。
2. envelope、cell.versions 和正在运行的受信 HUD 构建标识一致；完整 key、sourceId、profileFingerprint、实际可执行文件与版本、拓扑及整个 versions 元组均匹配。模板中的 run 值可用已定的类型化占位表示，实际执行值仍进入意图摘要；不通配 source、固定配置或 shell 实际解析目标。
3. hudRevision 指受检可执行构建的不可变标识，由构建/发布组合层给出，不由模型参数、delegate.json 或任意环境覆盖。不能采用“提交包含本 manifest 的最终 Git SHA，再让文件包含自己的 SHA”的循环规则；可绑定受检代码构建摘要，manifest/report 的摘要另存。任何可能影响该格的运行代码、helper、档案或版本变化都使其回到 unverified。
4. unverified/unknown 等占位字符串不是版本证明；host/shell=none 仅在该拓扑确实不适用时合法。B11/发布组合层在启动预检中有界获取可信 executable/version/runtime 信息，复用其结果；不在每个 acceptance 内跑 --version。无法证明动态 shell/function 实际目标时，该格保持 unverified。
5. 晋级需要已有五项 product 结果、accepted review、空 incomplete 以及适用的 06 预算和 A9/B14 条件。Claude 父调用路径还要覆盖实际 Claude/hook/helper/档案及 F08 双预算，不能只拿目标 Codex 版本替代。现有 cells 的五个 passed 字段不意味着性能门槛已经另行通过。
6. B14 可以由受信测试组合注入显式 test-only verifier 收集证据，再经评审制作发布 manifest；测试注入不能暴露成生产参数。初始空文件不造成“必须先有 verified 才能验收”的循环，也不授权普通生产请求绕过 capability_unverified。

保留 B45 的完整 key 和精确安装/source/profile 绑定，不将局部实测变成适用于任意机器、home 或用户配置的通行证。B14 只晋级真正覆盖的格。

**落实/阻塞：**契约/类型由 **O5APPLY** 收口；B11/发布组合层接可信取证，B14 审证和生成 manifest。阻塞 B11 对“可执行委派能力”的正式声明、B13 真实产品验收和 B14 晋级；不阻塞功能实现、test-only 组合或 B11 export。无需修改 ledger schema 或增加运行期写能力格的 API。

## R4：B12/B18 的集成边界

**裁决：追认 B12 的候选提交边界 witness、已知 V8 格式的发布校验、实例内租约权限，以及 B18 的私有元数据投影。补成具名共享 API；R6 改变成本组织，不取消这些保证。**

### G05：B12/B16 共用候选提交与验证入口

06「checkpoint 一致提交与 collect lease」、I-06-5、T-06-8 写明：

> ObservationBoundary、ObservationBoundaryWitness、ObservationCandidate 及 checkpointBoundary/witnessObservationBoundary 是 B12/B16 共用的发布接口，由 src/core/checkpoint.ts 提供，不在 B16 再复制一套。B16 在同一个 ReaderResult 上捕获完整记录边界，再执行唯一归并并绑定其结果。witness 是受信采集器关于来源一致性的断言及防错摘要，不是来源真实性签名，也不授予发布或执行权限。

应核对 ref、readerVersion、sourceGeneration、fileId、offset、checkpoint/summary 摘要、commitSeq、continuity、notices 和实际 observationStamp；不能事后拿一个新 checkpoint 的 offset 给旧 summary 补 witness。intent 分支仍无伪 SessionRef/collect commit。调用者可改变对象时，发布器必须处理脱离可变输入的快照，不能验证后再序列化被改过的对象。

对还支持的 Codex V8 格式，保留版本/runtime/结构白名单、空 raw tail、边界一致、exact EOF、解码值校验及仅重序列化已验证值的要求；重编码字节不必与输入相同。重复 Map key 的不可见旧字节、尾随数据或未知结构不作为合法持久状态保留。未来 reader 格式不能只因能 deserialize 就放行。

R6 允许同一不可变 checkpoint 的验证结果复用；“发布校验”是每个新内容进入存储前满足保证，不是强制每次 summary/no-op 对相同 blob 全量重解码。缓存键必须含内容身份、reader/runtime/格式和边界，不能只看 offset 或 file mtime。

**落实：**O5APPLY 明确契约，B16 直接 import 现有接口；B12R 落 R6 的复用 API。现在即可开 B16 纯归并；最终持久接线需采用同一入口。

### G06：实例内 lease 权限是本期规则

06「采集与租约」、I-06-6、T-06-9/10 增补：

> CollectLease 的可序列化字段描述已提交租约，不是可转交的写权限。只有成功完成 acquire(g+1) 的同一 ObservationStore 实例拥有该代的 renew/release/publish 权限；readLease、重新 open、相同 holder 名称或恢复进程均不能继承它。每次写入还必须在与接管相同的事务内核对持久 holder/generation/有效期、来源谱系及 previousCommitSeq。

追认当前默认 TTL=15 s、续约不密于 5 s、保留 generation 下界、内存 sampled high-water 和持久 last_now。B16 在一个 writer 生命周期内保存 store 与 lease，正常交接先 release 再 close；崩溃后重新竞争，不能按“同 holder”续旧代。读者不隐式 acquire，observation_busy 留旧完整摘要或在下一正常采集机会再尝试。

不增加持久 monotonic/boot-domain fence，不逐 tick 为时钟写盘。边界要说清：当前方案防止旧代覆盖与已观察到的时钟倒退；它不承诺系统时钟跳变后仍在真实 15 s 内完成接管。倒退/不可判时只读，可能延长停采；UTC 恢复到可判范围或正常释放/过期后再 acquire。不能把墙钟 TTL 称为跨重启的单调时间保证，也不能借它释放运行槽。

**落实：**O5APPLY 写明，B16 遵守。已有 instance-local 机制无需换成新时钟协议；不构成额外开工阻塞。

### G07：B18 私有投影继续使用，禁止泛化成公开 SQL 接口

07「本地委派元数据导出 v1」、I-07 的导出约束及 T-07-20–26 明确既有唯一入口：

~~~ts
queryDelegationExport(hudHome, {
  schemaVersion: 1,
  paths?: 'none' | 'local',
  scope?: { kind: 'all' } | { kind: 'links'; linkIds: string[] }
}): Promise<ExportResult<ExportQueryValue>>
~~~

追认 src/core/export-query.ts 内的 metadata-only SQL 投影；不要求为了目录整齐立刻搬文件、再套一个 broad LedgerReader 或另建 ORM。B2 拥有底层 schema/读取语义，B18 拥有此受限投影及 export v1，后续 schema 变更必须共同保持其回归。B11 只消费此函数，不自己拼 SQL。

保留 native readOnly、无迁移/初始化、busy_timeout=0、单读事务内取得 rows 与全局 high-water、尽早结束事务、复制输入后组装/编码、最后才输出完整 JSON。限额仍为 10000 runs/16 MiB/1000 ms 软预算；超限无成功文档。不得为导出加载 claims 明文、任意 event/evidence payload 或正文后再靠 serializer 清理。历史绑定与每轮端点语义仍依 07，不能套用当前 report 权限来删除历史事实。

**落实/阻塞：**O5APPLY 记录已选边界，代码接口原样保留；B11 export 可立即接入，不等待 B16/B6/B17，也不要求 B2 先搬模块。B14 复用现有 producer 证据并补真实接线所改变的断言。

## R5：ProcessKey 与 ProcessStamp 的 pid_domain

**裁决：追认两种不同用途的持久编码；修改为共用一份规范派生与显式类型边界。本轮不把已经持久化的 ProcessKey 中 raw machine-id 悄悄改成 hash。**

两个编码都能表达所需域，只要完整比较：ProcessKey 把 boot 放在域字符串内；ProcessStamp 的 boot_id 是独立必需字段。要求两者 pid_domain 字节相同没有收益。真正风险是三个生产者各自拼接、可选字段回退混用，以及变更字符串后割裂 caller_scope、proc OwnerKey、hook 锚点和幂等历史。

raw machine-id 目前只在私有身份材料内，不属于 export v1。新设计优先使用散列机器标识是合理的，但简单把一个既有身份键“脱敏”不是无害字段变更；hash 也不等于匿名化。在没有明确的版本化身份迁移需求时，本轮选择保持键稳定，避免新增 alias/重键协议。

### G08：共享派生、保持现有字节、禁止跨表示比较

01「身份、实例与定位」、02「数据模型」、04 ProcessStamp 段明确“同一机器/boot/PID namespace 事实”与“同一序列化字符串”不同。引入轻量模块 src/core/process-domain.ts，按已验证、非空的同一组机器/boot/namespace 输入派生：

| 用途 | 本轮保持的字节编码 | 比较规则 |
|---|---|---|
| Caller / ProcessKey 域 | JSON.stringify(['linux', machineId, bootId, pidNamespace]) | 只与同类 caller 域/完整 ProcessKey 比较 |
| Run / ProcessStamp 域 | SHA256(UTF8(trim(machineId))) 的小写 hex + ':' + pidNamespace | 必须同时比较独立 boot_id、pid、proc_start |
| Claude 原生 registry 域 | 'linux:' + machineId + ':' + pidNamespace | 只用于该版本原生文件的适配核验，不充当上述任何一个域 |

采样必须验证 procfs 可用于本进程的数字 PID、机器与 boot 非空、namespace 一致；不可见/矛盾保持 unknown/refusal。同一调用不能把两个独立来源的 boot 与 namespace 任意拼起来。

具体落点：

- packages/hud-mcp/src/process.ts、hook/process.ts、src/core/run/process.ts 共用轻量派生函数。hook 不因此 import 整个 run/reader/ledger 模块图。
- ProcessReaderPort 对 Run stamp 使用单独、必需或明确 unavailable 的 runPidDomain；handshake.ts 去掉 runPidDomain ?? pidDomain 的跨表示兜底。测试 fake 也必须明确提供本用途的域。
- currentDomain() 仍是 Run stamp 的同一生产入口，resolvers/handshake/call-context 使用对应 caller 域；不能把一个持久 ProcessKey 解析后当作重新证实的 ProcessStamp。
- 已提交 supervisor.registered/meta/receipt/ProcessKey 原样保留，不用当前 boot/domain 回填旧事实，不做字符串归一化重写，不加 owner alias。
- 定向覆盖三个生产者同输入一致、boot/namespace 变化、机器输入缺失、同数字 pid/start 的异域、hook 与 MCP 一致、不能跨表示比较。F08 只重验受模块图/来源变化影响的成本与身份行。

若将来确实改为 hashed ProcessKey 域，应独立定义编码版本、旧进程及未绑定 proc owner 的连续性、hook 重放边界和旧键处置；不能只改一个 JSON 元素。该迁移本轮推迟。

**落实/阻塞：**小包 **BID1** 落共享派生与回退移除，O5APPLY 改文字。不阻塞 B16 或 B6 纯读取；B3b 新 stamp 生产者必须使用该入口，B11 的正式身份组合和 B14 跨组件身份验收须在 BID1 后收口。现有双编码本身不是宣布 B45 握手无效的理由。

## R6：9.3 MB checkpoint 与 06 tick 预算

**裁决：修改。选择“紧凑恢复状态 + 同一观测 SQLite 内的不可变 checkpoint 复用 + 廉价投影读取”。推翻每次 publish/no-op 全量验证大对象、每次消费者读取都解码 native recovery 的热路径。只加 16 MiB cap、压缩原 blob 或把工作搬到另一个进程，都不是本题解法。**

已有合成证据足以否定当前普遍达标声明：10 个完整、每个约 700000 字符的公开工具参数可以生成 9,343,278-byte candidate；四次 prepare 为 278–346 ms，publish 为 299–489 ms，readCurrent 为 22–55 ms；三次无变化 publish 仍为 277–302 ms。prepare 是 publish 内部的一部分，不能把两组耗时相加；witness 构造还不在这些计时内。它不是一次性冷启动成本。

根源可定位：RolloutParser.exportCheckpoint 序列化整个 cachedResult/runningCalls/rateTracker/readStats，完整 arguments 随之保留；Codex facade 每读一次导出/复制；B12 随后规范化、解码、验证、重编码、再次稳定摘要。公开记录“允许读取”不等于其全部正文“必须反复进入恢复提交”。

### G09：恢复数据收敛，精确状态不靠截断

修改 06 Reader/ObservationCommit、I-06-2/5 和 07 checkpoint 版本策略：

> durable checkpoint 保存继续正确解释下一段输入所需的状态，不保存整个显示/材料缓存的内存对象图。单个热路径 inline recovery 编码上限定为 256 KiB，按实际编码字节计；这是资源边界，不是 <50 ms 的性能证明。完整公开工具参数、代码、长输出等先提取必要事实，正文不复制进 hot recovery；有界显示摘录若截断须保留截断/缺失语义。

落点由新包 **B12R** 一并拥有 src/collectors/rollout.ts、src/harness/codex/index.ts、src/harness/claude/reader.ts、src/core/checkpoint.ts、observation-store.ts 和相关共享类型：

- Codex 定义显式、版本化的 recovery DTO；保留累计 usage、去重/配对、未结束 tool 的 ID/状态/时钟、pending、rate baseline、compaction/reset、链接核验元数据及完成边界。不要先 clone/serialize 全 cachedResult 再删 arguments，成本收敛必须发生在 reader 生产端。
- 默认新 recovery 使用可验证的结构化元数据，不再持久化任意 RolloutParser/V8 对象图。已支持的旧 V8 仅走 G05 的有界兼容/受控重建路径；不为每种未来对象另堆一个镜像 validator。
- 对确实必须精确保留、会随历史增长的集合采用同一观测 SQLite 内的增量恢复索引，按 ref/sourceGeneration/恢复版本隔离，并把本 slice 的变更与发布边界同事务提交。Claude 的 usageMessageIds、factClockPages 已证明“100 条展示历史”不等于恢复状态有总上限；它们也要覆盖，不能只优化十个 tool arguments。
- 索引保存必要 ID/时钟/配对元数据，不保存 raw tail 或全文材料。读取按本 slice 需要的键/有界页进行，不在恢复时先把全部历史集合载回内存；重启后重复 message.id、晚到结果、重复事实仍保持原去重与时间语义。
- 不能丢旧 ID、截去未闭合调用、用近似集合改变 token 计数，或把忘掉的待决当 resolved。索引内容身份/边界必须进入 checkpoint 引用，不能以一个可被覆盖的“最新 map”越过 commitSeq。
- 旧 public snapshot/--json v2 的字段和既有口径不因恢复优化删除。详细材料若确需展示，从原来源走已有有界读取与材料边界；恢复缺证诚实表达，不造空文本或零值。

256 KiB 不能靠无限“下次再试”落实：单条合法大记录须完成必要提取并前进；高基数精确集合用增量索引承接。异常或不受支持状态超上限时返回 checkpoint_state_oversize，保留前一完整提交并明确缺口；不能持久 offset 前进而丢掉语义状态。若标准 100 MiB/合法大记录样本持续命中该错误，仍是未满足本项，不能用 partial 标签宣布性能通过。

这是本期为满足既有恢复/性能契约所需的窄存储调整，不是另建通用对象仓库、后台 compactor 或第二写者。

### G10：一次验证、同库复用、投影读取

06 I-06-5/9/14 与 src/core/checkpoint.ts、observation-store.ts 定义以下内部共享接口；名称可按仓库导出习惯微调，职责不能重新合并：

| 接口 | 必需语义 |
|---|---|
| prepareCheckpoint | 对新 compact checkpoint 及其恢复引用作完整边界/结构/内容校验，生成不可由外部随意构造的 PreparedCheckpoint；绑定 ref、readerVersion/格式、sourceGeneration、fileId、offset、内容身份 |
| publishPrepared | 接收同 ReaderResult 边界上的 prepared checkpoint 与 B16 summary/continuity/notices，仍在每次发布时重验实际 lease 和 previousCommitSeq；不因内容已验证就缓存写权限 |
| readProjection | 一个已提交快照内返回 summary、continuity、notices、observationStamp、commitSeq 与 checkpoint 身份/边界；不读/解码 recovery 正文，不运行 reader |
| readRecovery | 仅采集器恢复时取得同一提交对应的 checkpoint/恢复引用，并有界恢复；readCurrent 如保留完整兼容接口，不用于 status/wait/paint 常规读取 |

同一 source 的 SQLite 内保存不可变 checkpoint 内容与 current projection 引用；checkpoint 没变的 summary 边沿只换小投影。它们仍构成一个逻辑 ObservationCommit，同一 fenced 事务发布，不能演变成两次独立提交。新 checkpoint 的写盘/校验仍记入本次 tick。旧 blob 回收依现有受控发布/重建路径和事务快照，不加后台 GC，不删除仍被当前提交引用的内容。

内容身份由可信准备入口对已验证值产生；不能信调用者自报 hash、相同 offset、可变对象地址或文件 mtime。一次 no-op 不应重新构造大 checkpoint、hash 全历史或 deserialize 同一 blob；跨有效期的 freshness deadline、源谱系、规则版本或真实状态边沿不能误判 no-op。读取到的 projection 带其原 observationStamp，不把新 ledger high-water 贴到旧摘要上。

G05 的 witness 保留，但使用 checkpoint 的已验证内容身份与 captured boundary，而非要求为每次摘要变更反复扫描相同 payload。未知/损坏/版本失配内容仍拒绝；读投影不是替不安全 checkpoint 授予恢复能力。

**落实：**B12R 先交付共享接口和 reader DTO，再由 B16/B6/B10 使用；不另造第二份 merger。无需把原始 recovery 暴露给 HUD 或 export。

### G11：预算、continuation 与版本迁移的验收边界

补 06 P-06-7/8、T-06-3/4/8/9/19/20、07 checkpoint 版本策略及工程计划 B12/B16/B14 条件：

- 全 tick <50 ms 仍从 collect 入口到一致发布及本次数据组装/paint enqueue，包含 reader 提取、checkpoint 准备/witness、序列化、hash、索引读取/写入、SQLite 等待/commit 和调度。P-06-7 是所声明样本逐个检查的上限，不改成 p95；同步不可抢占超时照记缺陷。
- 共享总 deadline/8 MiB I/O、公平 continuation 保持；需要让出时停在可恢复的完整记录边界，checkpoint/summary/continuity/notices 同进退。只有恢复确实需要更大字节 slice 才返回 record_needs_larger_slice；分批恢复索引/准备进度使用单独的 recovery_catching_up 分支及明确 coverage，不冒用 minimumBytes。不得反复处理同一巨大对象而永久无前进。
- B14 对 0/1/2000 增量、100 MiB 历史、≤1 MiB 合法记录、十个大公开参数、长期重复 ID/大量精确时钟、多消费者、200 节点和真实心跳/锁竞争分别记录原始样本。每组合 ≥1000 tick，报 p50/p95/p99/max、超预算次数、字节/分配/RSS/写入；测无变化、summary-only 边沿、新 checkpoint 三条路径。
- cold rebuild 与 warm incremental 分开报告；反复 full validation 或反复恢复不得改名为 cold。readProjection 在真正使用它的 statusline 廉价入口接受 ≤20 ms 的完整入口测量；B6 非 wait MCP 仍按 P-06-4 的完整响应口径，不只测 SQL。
- reader 语义变化 bump readerVersion；结构不兼容则同步升相应 checkpoint/内部观测格式并拒绝旧写者。ledger user_version=1、export v1、public snapshot/旧 --json 版本不联动。
- 通过持有 collect lease 的受控缓存重建切换旧 reader：清除/替换旧缓存，重置不能证明的连续性，保留正确 sourceGeneration/显式 gap，不把“删除 payload 后沿用旧 offset”当迁移。若需要改观测 SQLite 布局，独立处理其私有格式及旧写者围栏；本期不新增通用在线迁移服务。
- 补新布局的前/后提交崩溃切点、旧 writer 迟写、同内容复用但 lease 已失效、projection 与 recovery 指向同一提交、丢通知/重复读不重发 notice。复用已有 A9/B12 的未受影响证据，不从头重跑全部矩阵。

**落实/阻塞：**B12R 落 G09/G10 及相关 G11；B16/B10 负责总调度和同边界接线，B6 使用廉价投影，B14 汇总正式证据。阻塞 B16 持久恢复/性能最终验收、B6 完整 status/wait 观测组合、B11 panel 的最终预算验收及 B14 晋级；不阻塞 B16 纯归并、B6 ledger-only/wait/cancel 实现、B3b 或 B11 export/local 管理。

本轮没有放宽 tick 预算。若上述有界方案在声明样本上仍无法达标，需携实际数据上送 Pro 决定预算或产品范围；不能以“已在事务外”“无写盘”“换后台进程”免除成本。

## 必须改的契约条目

以下是完整计数；R 节中的代码、类型与验证要求分别属于这些条目，不另重复计数。

| ID | 契约、章节/编号 | 必须改动 | 落实包 |
|---|---|---|---|
| G01 | 04 范围/退出来源，I-04-4/7/9/15，T-04-10/23/38；05 能力证据 | headless 轻量不可移动 leader；允许有来源的 native_unknown，保留 scope/封口/环境/取消性质 | O5APPLY、B3a-R1 |
| G02 | 06 P-06-1/2/3/9、T-06-11–16；计划 B14 | 正式链路 300 s、H/R=1/1/2/10，RSS/PSS、总 CPU、真实 I/O、启动分布及受影响故障矩阵 | O5APPLY、B14 |
| G03 | 02 幂等顺序/I-02-1/16/T-02-34；03 resume/T-03-37；概念 §6/§15 | MCP 可选 expectedRun 入摘要；权限→重放→新意图 CAS；缺省兼容，local 必填 | B45-R2、B13 |
| G04 | 05 能力格/I-05-1/T-05-1/2 | CapabilityManifestV1、受信构建/版本取证、完整匹配及 review/B14 晋级规则 | O5APPLY、B11/发布组合、B14 |
| G05 | 06 一致提交/I-06-5/T-06-8 | B12/B16 共享 boundary/witness；可信断言非授权；新内容验证、已验证不可变内容可复用 | O5APPLY、B12R、B16 |
| G06 | 06 采集与租约/I-06-6/T-06-9/10 | 同实例 acquire 才有写权；重开不继承；采样时钟限制和失效行为明确 | O5APPLY、B16 |
| G07 | 07 本地导出/T-07-20–26；计划 B2/B18/B11 | 固定 queryDelegationExport 私有元数据 seam/所有权；不要求搬模块或公开 SQL | O5APPLY、B11 |
| G08 | 01 ProcessKey；02 数据模型；04 ProcessStamp | 共享派生、三种用途分离、保留原编码、禁止回填与跨表示 fallback | O5APPLY、BID1 |
| G09 | 06 Reader/I-06-2/5；07 checkpoint 版本 | compact recovery DTO、256 KiB inline 边界、精确增长集合的同库增量索引；不截断必要状态 | B12R |
| G10 | 06 一致提交/I-06-5/9/14 | prepareCheckpoint/publishPrepared/readProjection/readRecovery；同库原子引用与内容复用 | B12R、B16/B6/B10 |
| G11 | 06 P-06-7/8 与相关测试；07；计划 B12/B16/B14 | 全链预算、有效 continuation、受控版本重建及新布局定向证据 | O5APPLY、B12R、B16/B10、B14 |

下一批工作的依赖按最终验收区分，不能把一个未收口接口扩大成全批停工：

| 下一 WP | 现在可以推进 | 最终收口所依赖的本轮条目 |
|---|---|---|
| B16 | 唯一纯归并、真值表、连续性/notice fixture；按 G05/G06 使用边界和 lease | 持久恢复与全 tick：G05/G06/G09/G10/G11 |
| B6 | ledger 只读快照、固定 run wait、取消接受及现有 RunControl 接线 | 观测组合：G10/G11；helper 取消能力：G01/G02；resume 参数不是 wait 开工前置 |
| B3b | 修订甲 TTY/context、父离线与监督死亡的独立故障工作 | 共用退出来源 G01、域派生 G08；可见格性能/故障按 G02 和既有矩阵 |
| B11 | export、现有 local resume/cancel/reconcile 管理入口；不等 B16 | 正式身份/能力组合 G04/G08；panel 预算 G09–G11；不额外要求搬 B18 |
| B13 | 角色与工具说明草稿、固定 runId/请求键使用方式 | expectedRun G03、B6 已有依赖、G04 下可用产品格；不得复制 test-only 放行 |
| B14 | 按已完成闭环收原始证据，复用未受影响结果 | 最终晋级前全部适用 G01–G11 与原 A9/F08 条件；真实/合成分开，不称本评审为 pass |

O5APPLY 是契约/类型对齐，不是新的运行组件。新增实现包限 B3a-R1、B45-R2、BID1、B12R；共享文件的实际修改由 ORCH 串行安排，不通过重复建模块解决所有权冲突。

## 可删或推迟

| 项目 | 裁决与 G13/G14 理由 |
|---|---|
| exec-launcher + 可移动 sh reader | 删除候选实现方向；已有错组信号反例，保留证据即可 |
| 为保持所有 headless 路径精确 native exit 而保留第二个 Node 的无条件默认 | 删除这一附加保证；保留已有精确来源，其他路径按契约给 null |
| 新 Python/其他解释器依赖、native helper、更多 Node 内存旗标组合 | 本轮不立项；先完成 G01 的一个有界方案，不并行养多套运行后端 |
| 强制 MCP expectedRun 必填、另造 resume 状态机 | 不做；可选字段复用 A4，旧调用与本地必填分别保留 |
| 能力在线注册中心、用户配置写 verified、每次验收前跑版本子进程 | 不做；受信静态 manifest + 启动预检足够 |
| 持久 clock-domain fence、逐 tick 写时钟高水位、新采集协调服务 | 推迟；同库 generation/CAS 加实例权限已守住单写边界，额外方案尚无所需收益证据 |
| B18 为统一目录而整体改走 broad reader/ORM | 推迟；现有受限投影更贴近隐私与读取预算，B11 可直接接 |
| ProcessKey 散列化迁移、域字符串强制统一、通用 identity alias 表 | 推迟；稳定私有键优先，先统一派生及比较边界 |
| 通用内容对象库、跨 source blob 去重、后台 GC、压缩整份 parser 后照样每次解码 | 不做；R6 只在既有 SQLite 内保存必要恢复元数据和不可变内容，按需回收 |
| status/wait/paint 解码 recovery、重新解析 transcript、为了最新年龄写盘 | 删除热路径；复用带原戳的廉价投影与纯 B16 截止计算 |
| 全量重跑 A9/全部历史矩阵，或用已有快样本覆盖历史慢样本 | 不做；仅对改动和证据缺口定向复验，B14 汇总所有适用门槛 |

唯一可能需要 Pro 再裁的是：明确接受仍然过重的默认资源成本、增加运行时分发范围、删减既定 MVP 能力，或放宽原性能门槛。本轮没有代替 Pro 作这些决定，也不因存在该后备分支暂停已授权的实现工作。

## 你核实过的事实

| 读取的文件/只读命令 | 本次核实结果与限制 |
|---|---|
| cat tmp/tasks/ORACLE5/role.md、brief.md、queue.md | 任务为 R1–R6 设计裁决；仅可写本 answer.md；禁止探针/子代理/其他模型。没有需要问 ORCH 才能给出的阻断性缺参 |
| git log -7 --oneline | 核对时 HEAD=6513f35；包含 8444de7 B45、b533831 B12、179bda2 B18。未执行 Git 写操作 |
| cat AGENTS.md | 仓库根未找到该文件；使用会话中给出的 AGENTS 指令及本任务 role/brief。role 明确无 CodeGraph 索引，本次未建立/查询索引 |
| 分段 cat/sed 与 git grep：docs/contracts/01-identity.md 至 07-outbound-compat.md | 核实 native nullable、local expectedRun、能力格完整证据、观测原子边界、预算和导出白名单；并非只读报告后自行发明新基线 |
| docs/universal-hud-concept.md §6/§15；docs/universal-hud-engineering-plan.md 阶段 B 及条件表 | 核实 G13/G14、MCP 原 resume schema、B12→B16→B6、B11 管理/导出与 panel 分依赖及 B14 条件 |
| docs/reviews/2026-11-01-astra-contracts.md，astra-consult2.md、astra-consult3.md、astra-consult4.md 的相关裁决 | 沿用 C 的 helper 自由度/原生结果可空、D 的连续性/导出、E 的代次分离、F09/F10 的 raw-tail 禁止与恢复预算；未重跑原探针 |
| docs/reviews/2026-11-01-chatgpt-pro-a9-gate.md、2026-11-01-chatgpt-pro-f08-hook-budget.md | A9 带条件冻结；F08 仅放宽显式 Claude hook 联合预算，不放宽 MCP 内部/事务/全 tick。B45 少量真实调用不满足最终样本门 |
| tmp/tasks/B3a/report.md、fix1-shell-counterexamples.mjs/.json、fix1-idle-10.json；src/core/run/process.ts、group-helper.ts、control.ts、types/supervision.ts | 读到真实保留的 shell137 混淆和 decoy 反例、十 run RSS/CPU 数组；当前 helper 通过自身 kill(0) 固定控制目标，退出数据来自 Node wait。脚本只阅读，没有执行 |
| tmp/tasks/B45/report.md；packages/hud-mcp/src/delegation.ts、handshake.ts、process.ts、resolvers.ts、tools.ts、main.ts；src/ledger/intents.ts、call-context.ts 相关路径；src/core/lifecycle.ts | MCP schema 无 expectedRun；local 有；writer 在重放后取当前 run 并有准备上下文检查。握手分别比较 stamp/caller 域，但存在可选 runPidDomain 回退。没有把这些代码阅读说成新的并发试验 |
| src/core/launch/capability.ts、fingerprint.ts、src/core/types/capabilities.ts、src/core/capabilities.ts；src/harness/codex/profile.ts 相关引用 | bounded shipped manifest、完整 key/版本/证据门禁与 typed template normalization 已存在；main 没有生产版本证明。此事实不等于任何格已 verified |
| packages/hud-mcp/src/hook/process.ts 与 MCP/run 的域生产代码 | 实际有 caller JSON、run hash+namespace、Claude registry 字符串三种用途。没有读取本机 machine-id 内容，也没有从当前机器数据推断旧实例 |
| tmp/tasks/B12/report.md、evidence/large-probe.json；src/core/checkpoint.ts、observation-store.ts、collect-lease.ts | 同实例 authority map、generation 围栏、发布前 prepare、no-op 前仍全量准备、readCurrent 完整 decode 确实存在。读取了四个大样本与三个 no-op 原始计时；未把四个样本当 p95，未重复执行大探针 |
| src/collectors/rollout.ts、src/harness/codex/index.ts、src/harness/claude/reader.ts、src/core/types/observation.ts、interfaces/harness-adapter.ts | Codex recovery 包含 cachedResult/完整 tool arguments；facade 每次导出；Claude usageMessageIds/factClockPages 随历史增长，不能以展示数组限额证明恢复总大小有界。只据此裁定数据边界，未做全 reader 代码审查 |
| tmp/tasks/B18/report.md；src/core/export-query.ts | 私有 metadata SQL、readOnly、单快照、高水位、事务结束后编码和完整 JSON 返回均有对应实现。报告的预算/一致性测试是原包证据，本次未独立复现 |
| 本次操作边界 | 只执行文件读取、git grep、git log；未启动 harness、进程故障探针、测试、其他模型或子代理，未发送外部消息。唯一仓库写入为 tmp/tasks/ORACLE5/answer.md |

