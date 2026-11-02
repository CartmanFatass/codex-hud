# Oracle consult 6 (Codex gpt-6-astra max), 2026-11-02: phase B batch 3 forks, Q1–Q7 (H01–H13)

Q8–Q12 were withdrawn (NOTIFY track, decided on the ChatGPT Pro review). Answer as received.

---

# ORACLE6：阶段 B 第三批分叉裁决（Q1–Q7）

核对基线：主检出 `8e5f87b`，已包含 B3a-R1、B12R、B16 和 B3b/X2-C。报告中的工作树、未提交状态和早期测试结果是历史记录；本裁决以主检出实现及各报告的最终修订为准。

按编排者最新指示，本次**只回答 Q1–Q7，含 Q1a**。共要求 **13 项契约变更，H01–H13**。这是设计裁决，不是生产能力放行；不重开身份、幂等、运行槽或 R/Q/N 的基本规则，也不放宽 F08 及 P-06-7 的预算。下文性能和测试数字均来自已有合成证据，本次未运行测试或进程探针。

## Q1：GNU env 依赖、native_unknown 与 Node 兼容实现

**裁决：追认当前生产方向，修改 G01 的歧义文字。允许受测 Linux 档案以系统 GNU coreutils 的所需功能为前提；默认 headless 的 argv 和 managed shell 都可以返回 native_unknown。精确结果的测试保留，不等于永久保留第二套生产执行器。**

G01 同时要求轻量实现和诚实的退出来源。POSIX shell wait 的 137 不能区分正常 exit 137 与 SIGKILL；原 argv 直接执行并不使外层 Node 突然取得孙进程的原生 wait result。把这些生产结果写成 null 是遵守来源契约，不是丢失已持有的原生结果。完整 scope 终止与任务成功仍是两件事。

### H01：明确生产依赖及精确结果路径的保留范围

在 `docs/contracts/04-supervision.md`「运行、启动输入和范围」「文件、字段与原子提交」、I-04-4/7/15，以及 05 的能力证据中写定：

> headless 默认执行器只有轻量 session/group leader 一种。受支持平台必须提供已核验功能的系统 `/usr/bin/env`：`-i`、`-S`、`--default-signal=INT,QUIT`；所选控制管道还使用系统 `/usr/bin/mkfifo`。缺失或语义不符明确拒绝，不选择隐式 Node 后端。依赖、实际版本、冷预检及启动成本进入该能力格证据。
>
> `GroupExit` 保持 `verified_wait | native_unknown` 来源判别。只有真实 wait/trusted result 的 subject 完整 stamp 与独立核验的 harness 相符，才投影 native_exit。轻量实现没有该结果时 native_exit=null；POSIX 编码仅是有观察者和对象的私有诊断。完整 R/Q 仍可 ended/scope_ended，shell_exit 也可以为 null。

具体落实：

- `src/core/run/process.ts` 保留当前功能预检及 fail-closed 行为。使用功能证据，不凭一个版本字符串假定所有语义成立；GNU coreutils 9.4 是已有受测版本，不是本轮虚构的通用最低版本。
- `src/core/run/control.ts` 和 `src/core/types/supervision.ts` 保留精确来源投影及 stamp 不匹配的拒绝分支。以后真实路径提供可信原生结果时，仍须使用它，不能因默认 shell 路径是 unknown 而统一清空。
- B3a-R1 的替代实现已完成所报告的定向验收后，`launchNodeGroup`、`group-helper.ts` 从**生产模块图和运行选择**退出。仍需用旧实现产生真实 wait 结果的集成测试，可将它收为 test-only fixture；或者用直接 ChildProcess wait 的可信测试适配器覆盖同一个生产投影入口。不能只构造几个伪结果后声称验证了真实 wait，也不必为保留断言维护一个可供用户选择的完整后端。
- 保留精确 0/3/137、真实 SIGKILL/SIGTERM、实际 shell137、subject 不匹配的断言；默认生产路径另验 unknown、正常终结及不伪造 shell result。清理兼容代码不要求重新运行无关矩阵。

**落实包：**O6APPLY 同步契约；B3a-R1 收尾小包完成生产兼容代码清理和受影响测试。**依赖：**不阻塞 B6 的读取/取消意图实现、B13 文稿、B17 或 B9/B10；B14 的 headless 格必须使用最终生产模块图和实际依赖取证，不能把旧 Node fixture 的结果写成默认生产能力。

## Q1a：通过 environ 运输 env -S 引用

**裁决：追认。允许生成的运输变量名出现在 argv；禁止把原始环境条目作为运输数据复制进任何 bootstrap argv。**

当前实现把原条目放入 `HUD_ENV_n` 的值，argv 中仅有固定语法及生成引用。这与 `env NAME=VALUE command` 的暴露面不同。它的正确性依赖已验证的单次展开、不递归解释、不按值重新分词等语义，不能推广成任意 shell 字符串拼接。

### H02：把运输不变量与可验证边界写清

在 04 的 G01 环境段和 T-04-1/2/18–20 增补：

> helper bootstrap 的 argv 不得含原环境条目的 name=value、原名称/值的传输副本或可逆编码副本；只允许固定控制程序及实现生成的运输引用。环境内容只能作为数据进入目标 environ，不得成为 eval、shell 插值或递归展开的代码。原本由调用者明确放在 workload argv 中的参数不在此处被重写；“环境不进 argv”是运输不变量，不是对任意字符串相等的禁令。

`encodeGroupEnvironment` 保留完整条目的重建、原 `HUD_ENV_0` 等同名变量的恢复、`-i --` 的选项隔离，以及超限显式拒绝。不得截断、偷偷删变量或换 Node 后端。目标程序取得原环境后，自行把它打印或写入 argv 不在 helper 的此项保证之内。

验收复用已有 kernel exec-stop 审计与 sentinel 用例：导出函数、dotted name、以 `-` 开头的名称、PWD、NODE_OPTIONS、空环境、同名运输变量、引号/反斜杠/美元/换行/长值；逐个 exec image 检查 bootstrap argv，并检查最终环境及私有 FD 关闭。不能只检查最终 harness 的 `/proc/cmdline`。编码范围沿现有 Node 字符串 API，不新增未经实现的任意非 UTF-8 字节承诺。

**落实包：**O6APPLY、B3a-R1 收尾；**依赖：**仅阻塞 B14 对环境保真和环境不经 argv 运输的正式声明，不新增 B6/B13/B17/B9/B10 的开工前置。

## Q2：P-06-7 与同步持久发布

**裁决：修改。选择同一观测 SQLite 的 WAL + FULL 作为唯一下一步存储实现，保持原子持久提交和逐样本全 tick <50 ms；不批准 WAL + NORMAL、把发布移出计时，或自行拆分预算。当前 WSL 原生盘结果仍然不通过。**

B12R 已把巨大 recovery 的热路径成本显著收敛。后续诊断中，原生盘 2000 次发布有 568 次 ≥50 ms；每次超限的 COMMIT 占比至少 90.28%，而 tmpfs 对照为 0/2000。它支持“当前文件系统/提交持久化路径是主要瓶颈”，并没有逐个追踪 fsync，也没有证明所有尾延迟都能靠更换 journal mode 消除。B16 的新 checkpoint 路径仍有 1/1000 次 ≥50 ms，最大 70.859443 ms，不能用其他快样本抵销。

### H03：保留语义与预算，收敛到一次有界的日志模式优化

修改 06「checkpoint 一致提交与 collect lease」、P-06-7、G11 验收说明，写定：

> 持久发布完成仍指 checkpoint、恢复索引、summary、continuity、notice/dedup 状态在同一 fenced 事务中一致提交；prepare/witness、SQLite 等待、COMMIT 和该路径引起的 checkpoint 成本均属于实际 tick。不得在持久提交前发布新摘要、推进 notice 游标或确认 reader ACK，也不得把慢提交安排到别处后从统计中删除。
>
> 本期观测存储采用单一 WAL + FULL 方向优化现有 DELETE + FULL；不降低 synchronous 保证。该选择不构成 <50 ms 的通过证据，原超限样本和门禁保留。

新小包 **B12D** 拥有 `src/core/observation-store.ts` 的 journal/open/close 路径及对应存储测试；`checkpoint.ts`、`collect-lease.ts` 的权责和同实例租约不改：

1. 把当前仅接受 `journal_mode=delete` 的生产约束改为受控切换并验证 WAL，保持 FULL、私有目录/数据库/`-wal`/`-shm` 权限和现有 busy 上限。日志模式在受控停写/重开时选定，不在每次 publish 中切换，不并行维护两套可配置生产后端。
2. WAL 中同样只能出现合格 compact recovery 元数据。先完成旧 raw-tail 缓存的受控清除/重建，不能因换日志模式保留第二份不合格旧缓存；现有 `secure_delete` 也不能被描述成自动清除了所有旧 WAL 页。
3. SQLite checkpoint/关闭的成本、WAL 实际字节及长期读快照的影响必须计量。不得用永久关闭 checkpoint、无限 WAL 增长、新常驻 flusher 或另一份 publish 队列换取快的 COMMIT 数字。读事务仍短，保留原来的公平 continuation 和失败时旧完整提交。
4. 仅补受影响的提交前后崩溃、lease/CAS、并发只读投影、projection/recovery 同提交和日志回收证据；用原生盘、相同声明负载重测 no-op、summary-only、新 checkpoint，保留全部原始样本。B14 再测实际 reader→发布→paint 全 tick，API 结果不能代验。

选择 FULL 的原因是这里已有持久连续性、notice 去重和提交序号语义。NORMAL 可能使最近提交在系统故障后回退；“只是缓存”不自动解决旧消费者游标、序号复用和已经对外看到的 notice。批准它需要同时裁定可丢失窗口及恢复语义。本轮不以一个 PRAGMA 隐式修改这些承诺。异步实现本身可以改善响应性，但在 G11 口径下不能免除持久发布的端到端成本。

**上送边界：**现有超限结果已经应进入 Pro 的预算/平台范围决策材料；B12D 是一次不削弱保证的有界优化，不是延后上送的理由。若 WAL + FULL 仍有声明样本超限，停止继续堆机制，由 ORCH 带原始分布请求 Pro 决定预算、可接受故障持久性或受支持平台范围；Oracle 不将 <50 ms 改成 p95。

**依赖：**B6 可继续使用 `readProjection`，B9/B10 可继续消费旧完整提交，B13/B17 不受此项开工阻塞。B10 的全 tick、B14 的性能晋级仍受阻；B12D 通过局部检查也不自动解除全链门禁。F08 的 MCP 150/50 ms、事务 30/10/20 ms 均不改变。

## Q3：executable 参数含 `=`

**裁决：追认预登记拒绝；不为这个边界保留 Node fallback，也不据此提高所有用户的 coreutils 版本要求。**

这里的问题是传给 env 的命令操作数会被重新解释成赋值，不是 shell 转义不足。把 `--` 当作“此后一定是 executable”的证明已经被现有证据否定；失败还可能走到 env 输出环境的行为。拒绝比执行了另一个含义可靠。

### H04：把 headless 支持边界放回启动契约

在 04「运行、启动输入和范围」、I-04-1/T-04-1，以及 05 的档案预检/unsupported 中增加：

> 当前 headless GNU env 启动档案不支持其实际 command operand（`launch.argv[0]`，或 managed shell 的可执行路径）含 `=`。可确定此条件时，返回 `headless_executable_assignment_unsupported`，发生在 supervisor 登记、票据消费和外部 dispatch 之前；不改写路径，不自动转 shell，不选择其他执行器。

保留 `preflightGroupLaunch` 及真实 ledger 零变化断言；同步 README，删除“待 ARCH”标记。这个限制不禁止普通 argv 参数含 `=`，不禁止环境值含 `=`，也不改写用户原有 managed shell 文本。已显式选定、经过验证的 shell 档案仍按原合同执行；不能由本错误自动转换得到。

`--argv0` 是否能解决命令操作数解析要有另外的语义证据，不能从选项名称直接推出。本轮不增加此分支。此裁决是当前后端的明确支持域；若某个已承诺的实际产品档案依赖含 `=` 的 executable，必须把该格的受影响范围带给 Pro，不能把拒绝用例算作该格正常启动通过。

**落实包：**O6APPLY、B3a-R1 收尾。**依赖：**B13 说明错误即停止，不换 key/后端重试；B14 验零登记/零 dispatch。其他包不阻塞。

## Q4：Bash 作为 /bin/sh 的 CHLD/read 问题

**裁决：追认最终 D 拓扑。队列中的单 shell 原型及旧资源数字不再是本题决策基线；不选 Bash 主机拒绝、强制 dash 或 Node 生产逃生分支。**

最终报告及主检出已经采用 leader、control forwarder、waiter 三个小 shell，通过私有合流管道交付控制、封口和完成。它消除了依赖 CHLD 打断 blocking read 的条件，已有 dash、Bash-as-sh、Bash --posix 的定向证据。

### H05：承认三个有界辅助进程，冻结其职责与成本口径

在 04 G01、I-04-7/9/15、T-04-18–23/38 和 06 P-06-1/3/9 写定：

> headless scope helper 可由一个不可移组的 session/group leader 加两个随 run 存活的轻量辅助 shell 组成。只有 leader 发本组信号；forwarder 只读取原私有控制输入并产生受限控制/封口帧；waiter 只消费一次启动材料并产生有来源的完成诊断。三者没有新的票据或独立恢复执行权，不增加轮询或第二运行后端。

继续采用 `group-leader.ts` 和 `group-pipe.ts` 的固定程序、已 unlink FIFO、私有权限、stdin 分离及 exec 前关闭私有 FD。外部控制输入不能伪造 DONE/SEAL；EOF 封口不能重开。辅助进程故障按报告的实际边界表达：forwarder 死亡丧失控制，waiter 死亡不能伪造完成，leader 死亡不能由父端改发数字 PGID。不能把这些故障写成“自动回收已保证”。

最终 D 的 R=10 合计 RSS 为 **700,472 KiB**，基线为 1,264,920 KiB，下降约 44.6%；CPU 为 1.57 对 1.66 秒/300 秒，辅助 shell 记录为零 tick。20 次启动 p95 为 266.613 对 246.132 ms，约增加 20.481 ms，须一并保留。队列中的 680,460 KiB/1.77 秒不是最终 D 数字。三类 shell 的数量必须逐项计入，不能把“一个逻辑 helper”写成一个 OS 进程。

这些是 file-fake/合成局部证据；有些窗口仅 59 次心跳，仍不满足 G02 的正式 B45、真实 B2、H/R=1/1 与 2/10、300 秒且至少 60 个心跳边界要求。本轮不增加任意 RSS 硬阈值，也不宣布 B14 已通过。

**落实包：**O6APPLY 和 B3a-R1 收尾；B14 收正式资源/故障数据。**依赖：**允许 B6 按现有 headless 控制接口接线；最终能力晋级仍依 H01/H02/H04/H05 受影响证据，B13/B17/B9/B10 不需等待另造 helper。

## Q5：可见甲的 group control 与前台 admission

**裁决：追认拒绝可见数字 PGID 信号的当前行为；修改契约，明确 no-reuse 要求也适用于 visible。推翻“原 leader stamp 刚核验且 JavaScript 同步就足以安全发送”的例外。追认 PID=PGID=terminal foreground PGID 作为当前直接前台档案的 admission 条件。**

G01 的特定实现建议面向 headless，但 I-04-9 中不杀复用组的安全目标没有 visible 例外。最后一次 procfs 核验和 `kill(-pgid)` 是两个操作；其间进程可以被调度暂停，无法由 JavaScript 的同步段给出最大间隙。保留一个已读 stamp 不是内核对组实例的稳定引用。

### H06：统一安全目标，并区分拒绝通过与正向能力通过

修改 04 I-04-9/12、「取消与父断连」「可见模式：修订方案甲」、T-04-22/23/30–33/36；同步 05 能力格及 `docs/probes/hud-run-visible.md` 对生产要求的引用：

> 所有受管模式的 deliverable group signal 都必须在交付点绑定原范围实例，不能依赖父进程 verify→数字 PGID signal。当前 visible wrapper 没有已批准的稳定整组交付机制，故控制不可用：接受合法取消意图后记录 `cancel.unconfirmed` / `visible_scope_control_unavailable`，不发送 INT/TERM/KILL，不降为单 PID，不启动无意义的升级计时器。后续独立 R/Q/N 仍可正常对账。

取消意图已接受、信号交付失败和运行仍存活须分别呈现。当前 fresh/live 情形可以保持 `cancelling`；只有满足 R-02 的对应条件才进入 uncertain。不能因为拒绝了信号就宣称 cancelled，也不能在后来完整 R/Q 到来时永久持槽；有取消意图但没有时序证明的正常结束仍按 ended + cancel_timing_unknown。

具体落点：

- `signalVisibleScope` 保持拒绝并将注释改为本项已裁决的边界。`control.ts` 保留无 ack 即返回、不排后续 TERM/KILL 的逻辑；同一取消请求不重置宽限或重新尝试。
- `preflightVisible` 的 PID=PGID=tpgid，加真实 TTY stdin，保留为当前**受信直接前台启动形态**的必要条件；这不是可验证任意恶意 launcher 行为的通用证明。允许的 launch profile 仍须固定 pane shell 等待 hud-run 的拓扑。非 exec wrapper/后台保留 `/dev/tty` 不因成员关系而准入。
- 私有启动 FD、不读 TTY、真实 harness 的 executable/ancestry/TTY/SID/stamp 发现及独立 shell wait 均保留。不能为了 group control 把 detached headless 直接搬进可见路径、绕过函数/context，或重新启用乙 sidecar。
- `docs/probes/hud-run-visible.md` 的原型 verify→signal、单 PID fallback 等历史代码仅是探针事实，不再作为生产授权。X2-C 最终拒绝测试通过，不等于它早期的正向取消阶梯仍然通过。

**下一步选择：**当前实现维持安全拒绝，B3b 的正向可见取消能力不得晋级。若要补齐，限定一个 **B3b-C** 工作包设计并验证在交付点稳定绑定范围的机制；不能先启用弱保证再补文档。新 native/解释器依赖、PTY/启动拓扑变化，或删除已承诺的可见取消能力，都涉及既定 MVP 成本或范围，须由 ORCH 带本项反例送 Pro 作取舍。本轮没有授权其中任何一种扩张，也没有批准把永久不可取消当作完整双模式 MVP。

**依赖：**B6 的 status/wait、取消意图和明确 unavailable 返回可继续；B13 必须如实说明当前可见取消边界，不能指导改走 `sendKeys`、单 PID kill 或自动 resume。B14 的正向 visible cancel 格受阻，已有启动/TTY/正常结束证据可保留。B17、B9/B10 的只读实现不阻塞；展示层不能把“accepted cancel”画成已结束。

## Q6：supervisor 收到的信号与稳定宿主 context

**裁决：修改。为 supervisor 自身收到的信号增加一个窄 raw fact；稳定宿主定位复用已有 locator，不新增泛化的 visible.context 环境载体。**

这两类信息的角色不同：信号是一次事件，context 是定位快照。把两者都塞进退出回执，或把所有 HERDR_* 变量复制成一个新权威对象，都会扩大不必要的协议。

### H07：新增 supervisor.signal，严格保留 subject

在 04「部分 evidence」、I-04-4/11、T-04-12/13 增补，02/03 的事件白名单同步：

```ts
type SupervisorSignalFact = {
  signal: 'SIGHUP' | 'SIGINT' | 'SIGTERM';
  observedAt: number; // handler 实际观察的毫秒 epoch，不是 DB 提交时间
};
// events.kind = 'supervisor.signal'
```

> 本事实的 subject 固定为该 run 已登记的 supervisor。只能由匹配 `supervisor.registered` 完整 ProcessStamp 的现有写者提交；runId/linkId 由写者入口从账本关联。它只证明 supervisor 收到了该信号，不证明发送者、harness 收到信号、harness 退出、scope 结束或取消因果关系。

在 `src/ledger/run-facts.ts` 的白名单和入口增加字段、枚举及时间类型校验；由 `src/core/run/control.ts` 的现有可见信号 handler 记录。Node handler 没有提供可信 sender 信息，不能自行标为“用户发出”或“终端已杀掉 harness”。原取消意图流程独立继续；重复在途信号处理可合并，不能重置同一取消阶梯。

不用 `command.exited` 或 `cancel.step` 冒充此事实，不改稳定 meta，不增 `signals.jsonl` 或渐进 exit.json。事实写入失败即保留证据缺口，不能拿一次内存回调生成终态证据。测试覆盖 HUP 后 scope 仍活、终端先结束 scope 再到 HUP、重复信号及写者 stamp 不符；只复验这一载体影响的路径。

**落实包：**O6APPLY 定类型/文字，新的小包 **B3b-Facts** 与 B2 串行修改 raw whitelist 和 handler。**依赖：**不阻 B6 基本读取；阻塞 B14 对“监督信号部分事实已完整记录”的声明。此事实不解除 H06 的交付限制。

### H08：宿主数据使用现有 locator，环境只是提示

在 01「身份、实例与定位」、02 `runs.locator`、04 RunHandle 和 05「宿主、定位与 timeout」明确：

> `visibleHostContext(env)` 是交给 HostAdapter 的进程内提示，不是身份或控制凭据。需要跨重启提供的受管宿主位置，使用经 HostAdapter 核验、与固定 runId/bindingGeneration 对应的现有 HostLocator；未受管 surface 继续使用 SurfaceLocator。不把 HERDR_* 全表持久化，不以 workspace/tab/pane 相同证明 occupant 相同。

`src/core/run/visible-host.ts` 保持上下文传递职责。B4/B7 将正式 HostAdapter 结果接到既有 `runs.locator`：如果 B2 尚无窄写入口，则补 `recordRunLocator`，只记录该 run 的首次有效定位，重放同值幂等；未知字段保持未知，冲突不得静默覆盖或改变执行目标。这个入口沿用该 run 的受信写者/意图权限和事务前提，不向模型开放任意 locator 写入。

Herdr 的 server/workspace/tab/pane、tmux 的 server/session/pane 按现有类型保存；process stamp、occupantGeneration、bindingGeneration 仍是不同事实。`SurfaceLocator`/`LocatorCheck` 的 occupant 观察不能借用 bindingGeneration；缺 server 实例或 occupant 证据时仅能供诊断定位，操作前仍须重验。仅由继承环境取得的未验证 ID 可继续在进程内作提示，无需为它额外增加 `visible.context` raw kind。宿主环境原样传给用户 shell，与把它复制进账本是两回事。

**落实包：**O6APPLY、B4/B7 的宿主接线，B2 补确实缺少的窄入口；B3b-Facts 不另造第二份 context 存储。**依赖：**B6/B10 的宿主动作投影应等正式 locator 接线；纯状态/树读取、B13、B17 可继续。B14 的真实 context 效果仍需实际目标命令证据，不能用已保存几个 ID 代验。

## Q7：B16 六行政策

**裁决：C01、C04 修改；C21/C33 的静默基线、C30 的 blocked 映射和 C46 的显式跨源解决证明追认，并补充以下边界。唯一归并器、同一 ObservationCommit 和有界 noticeState 继续保留。**

### H09：C01 不把普通 registry/transcript 差异自动升级为 conflict

**修改。** 06「B16 的五维输入与消费者字段」、I-06-4、附录 C01 及概念 §6.8 写定：

> 匹配且新鲜的 registry 优先回答当前 activity；transcript 的 turn/tool 历史、明确失败和待决证据各按其维度参与归并。两个来源的 activity 值不同，本身不足以建立冲突。两次读取均 fresh，也不证明它们描述同一个原子时刻或同一事件边界。

`src/core/status/merge.ts` 删除当前仅比较 `registry.activity !== transcript.activity` 就合成 conflict 的分支；保留已显式提供的 conflict 及合格 `validity='conflict'` 证据。确有同主体、同语义命题的互斥证明时，仍按冲突优先，不能以 registry 优先规则冲掉。

C01 应为 activity=working@registry、无自动 conflict，语义 `working:working`；其余维度仍可采用 transcript，不能误改成整条记录都只取 registry。可用有界诊断解释采用来源，但不为正常观察延迟写 ledger 冲突事件。保留“明确 failed 不被 busy 覆盖”和“真实显式冲突仍最高优先”的邻近用例。

**理由：**当前自动冲突规则会让一次正常 registry 先更新、文件稍后追加的状态转移占据最高告警优先级，抵消既定的来源职责及 fallback，损害 G14。

### H10：C04 的 tool deadline 只撤回该 activity 证明

**修改。** 06 五维来源/freshness 段、I-06-4/13、附录 C04/T-06-6/27 写定：

> 未闭合 tool 超过自己的有效 deadline 后，不再支持 working，也不被推成已完成或 idle；可保留 lastKnownActivity 和未闭合诊断。工具活动截止不自动改变同一 transcript 来源的读取新鲜度，不使独立的 pending、outcome 或 liveness 事实一并失效。来源自己的 deadline、读取错误、谱系和时钟检查仍然独立生效。

在 `merge.ts` 中撤掉把 `openTool.deadlineAt` 无条件压入整个 `FreshnessSource.deadlineAt` 的逻辑；它只约束工具活动候选及相应的语义区间。已有新鲜 registry activity 可以替代它。只有该工具证据能支持的 working 必须撤回，不能从同一旧 `activity:'working'` 再兜回来。

按 C04 现有 fixture：transcript 仍 current、来源 deadline=90000，因此 now=4000 时该来源仍 fresh；tool deadline=2000 使 activity=unknown，独立给出的 liveness=alive 保留，pending/outcome 仍为 none，最终为 `unknown:insufficient_evidence`，而不是把整个来源标 stale。若此次语义转换确由已知 tool 截止产生，stateSince 使用 2000/event；不能用本次 paint 时间代替。另保留真正 source deadline 到期、无独立 liveness 和有效 registry fallback 的用例。

**理由：**“最近成功读到了一个长期未闭合调用”和“来源读取已经陈旧”是不同事实。既不能让旧 tool 永远把节点画成 working，也不能用一个活动期限清除仍有效的审批或明确失败。freshness=fresh 本身不证明当前 idle/working，更不授予控制权限。

### H11：C21/C33 采用静默首次基线，不影响账本事件消费

**追认。** 06 NoticeEvent、StateContinuity、I-06-5/13、附录 C21/C33 和 T-06-7/8/28 写定：

> 没有可恢复 noticeState/可信既有消费边界时，第一次建立基线只呈现当前状态，确认该次一致输入中已经存在的 report 和 active episode，不补发 report/pending/failed/uncertain 历史边沿。成功持久化后出现的新事件，或恢复了原有 noticeState 后的未消费事件，照常通知。

基线静默不是“不显示问题”：pending、failed、uncertain 的当前状态照常可见。也不是每次进程重启都清空通知历史；有已提交状态就按原 cursor/episode 继续。失败的 publication 不得先在内存中确认基线或推进报告游标。旧 commit 缺 noticeState 时按 B16 已实现的单次静默升级处理。

保留 writer 的 3 个 active episode stamp、3 个进入事件 alias、一个 report 游标和一个观测域计数器，不新增历史 report ID 全集。C21 的“确认 report_id”应按当前实现改写成“确认基线已覆盖的 report.received 序号/当前 episode”，避免要求不存在的无界 ID 列表。

此规则只控制 B16 派生 notice，不替调用者推进 `delegate_wait.afterSeq`，不删除 ledger report，也不把首次查询当前状态当成父端已处理任务结果。跨域 seq 不比较。

### H12：C30 的 blocked 报告映射 needs_human，但不制造运行终态

**追认。** 06 五维/分类、附录 C30 及 03「报告与 status」写定：

> 当前 run 最新的已接受 blocked 报告作为独立待决来源，映射 pendingReason=needs_human、语义 pending:blocked；source、reportId、进入时间和 report.received seq 保留。它表示需要外部处理，不等于已证明某一种 approval/question，也不证明必须由真人执行某个动作。

保留 B16 的 blocked 独立分类优先级，包括 C56 的反例：另一个维度中的请求被解决，不能顺带解决仍是最新事实的 blocked report。明确 failed 等 outcome 可继续保留在其维度中，不被 pending 图标改写成成功；新一份当前轮报告按 03 序号语义取代旧报告。

`run.state`、`isRunTerminal`、槽及 resume 门禁完全不因该映射改变。B6/B10 不再各造 blocked 分类；B13 可说明该代码是需外部关注的通用待决，不把它解释成新的授权协议。

### H13：C46 保留显式 pendingResolution，归并器统一核对

**追认。** 将当前 `StatusFacts.pendingResolution` 的内部输入契约写入 06 五维来源/附录 C46，保留：

```ts
pendingResolution?: { episodeAnchor: string; eventAt: number };
```

> 跨来源清除待决必须有指向同一个已识别 episode 的解决证明；证明的外层 evidence 保留真实 source/ref/run/绑定代次/sourceGeneration、有效性与时间。时间须合法、不早于该 episode 打开且不晚于当前可信边界；缺 anchor、外来实例、过期/时钟异常证据或无关 none 都不能清除待决。毫秒相等只在来源确有同 episode 的解决关联时可接受，不能仅凭时间相等推断因果。

collector 负责把原生事实解析成此输入；同 episode 比较、来源选择和语义转移仍由唯一 `mergeStatus` 完成，不在 B6/B10/collector 再折叠一套 pending 状态机。多个请求并存时，一个 resolution 只解决对应请求；可以提供多个具名事实，不把单个字段偷解释成“全部已解决”。匿名 episode 无从关联时保持未知/待决，不捏造 ID。

采用 resolution 后保留其证据来源在 requiredSourceIds 和 provenance 中；恢复后的 idle/working/报告等区间不能沿用被待决打断前的旧起点。重读同一解决证明不产生新 notice。C54–C60、C64/C65、C70–C73 中已经覆盖的修复继续保留。

**Q7 落实与依赖：**新小包 **B16-P** 统一修改 `src/core/status/merge.ts`、相关 fixture/单测和 06 附录；只有持久输入结构确实变化时才同步 `checkpoint.ts` 的严格 validator。语义变化递增 B16 ruleVersion，旧连续性不得贴上新规则版本沿用；按既有 observed/unknown 与 H11 基线规则处理，不无故重建 native reader recovery 或修改 ledger schema。B6/B9/B10 可以继续按共享类型接线，但最终状态验收必须使用修订后的唯一 merger；B13 的最终待决/通知说明和 B14 相应状态用例依赖本包。B17 不因这些纯状态政策停工。

## 必须改的契约条目

以下是完整计数；正文中的类型、代码、文档和定向验证属于对应条目，不重复计数。

| ID | 契约、章节/编号 | 必须变更 | 落实包 |
|---|---|---|---|
| H01 | 04 运行/退出来源、I-04-4/7/15；05 能力证据 | GNU env 功能依赖及 fail-closed；默认 native_unknown；精确投影/真实 wait 测试保留，Node 兼容执行器退出生产 | O6APPLY、B3a-R1 收尾、B14 |
| H02 | 04 G01 环境段、T-04-1/2/18–20 | 生成引用可进 argv，原环境运输数据不可；单次展开、完整恢复、超限拒绝及逐 exec sentinel 证据 | O6APPLY、B3a-R1 收尾 |
| H03 | 06 一致提交、P-06-7、G11；计划 B12/B14 | 下一实现选 WAL+FULL，持久原子边界及全 tick 预算不减；原失败保留，预算/持久性/平台范围上送 Pro | B12D、O6APPLY、B14 |
| H04 | 04 启动/I-04-1/T-04-1；05 预检 | 含 `=` 的实际 env command operand 明确 unsupported，登记前拒绝；无 Node/自动 shell fallback | O6APPLY、B3a-R1 收尾 |
| H05 | 04 I-04-7/9/15、相关故障测试；06 P-06-1/3/9 | 追认三个轻量 shell 的 D 拓扑，职责、封口、辅助故障边界和最终资源数字单列 | O6APPLY、B3a-R1 收尾、B14 |
| H06 | 04 I-04-9/12、取消/甲、T-04-22/23/30–33/36；05 | no-reuse 目标适用于 visible；当前拒绝不算正向取消通过；限定直接前台 admission | O6APPLY、B3b；后续 B3b-C 受范围裁决约束 |
| H07 | 02/03 事件白名单；04 部分 evidence、I-04-4/11 | 新增窄 supervisor.signal，验证写者及 subject；不冒充 command exit 或取消结果 | B3b-Facts、B2、O6APPLY |
| H08 | 01 定位边界；02 runs.locator；04 RunHandle；05 locator | 正式宿主定位复用现有 locator；环境仅提示、不持久全表、不新建 visible.context 权威 | B4/B7、B2、O6APPLY |
| H09 | 06 五维/I-06-4/C01；概念 §6.8 | 普通 activity 来源分歧按职责选择，不自动生成最高优先 conflict；显式矛盾保留 | B16-P、O6APPLY |
| H10 | 06 freshness/I-06-4/13/C04 | tool 截止仅撤回工具活动证明，不使独立来源和维度一并过期；新语义区间用真实截止 | B16-P、O6APPLY |
| H11 | 06 NoticeEvent/一致提交/I-06-5/13/C21/C33 | 静默首次基线、有恢复状态则继续；不推进父 wait 游标；有界持久去重 | B16-P、O6APPLY |
| H12 | 06 五维/C30；03 报告与 status | blocked→needs_human/独立待决，保留 outcome，不改变 run 终态、槽或权限 | B16-P、B6/B13 |
| H13 | 06 五维/C46 及相关反例 | 显式相关 resolution、外层完整来源及时间门禁、保留依赖，唯一 merger 负责解决判定 | B16-P、B6/B9/B10 |

后续依赖按能力和最终验收划分，不把局部缺口扩大成整批停工：

| 工作包 | 现在可推进 | 本轮阻塞的最终交付 |
|---|---|---|
| B6 | ledger status/wait、固定 run 游标、取消意图、headless 接线、readProjection 组合 | H06 可见控制必须诚实不可用；H07/H08 的新增事实/宿主定位接线；H09–H13 的最终状态结果 |
| B13 | 工具/角色模板、请求键、expectedRun、报告流程 | H04 拒绝说明、H06 可见取消限制、H11/H12 通知与待决语义；不得声称尚未 verified 的完整产品格 |
| B14 | 复用既有证据，补最终 headless 构建的正式资源/启动样本、受影响故障与状态检查 | H03 全 tick 性能；H06 正向可见取消；H07/H08 部分事实与真实宿主 context；H09–H13 状态验收 |
| B17 | 原定材料入口、provenance、授权/撤权与隐私负向测试 | 无本轮开工阻塞；新增诊断/环境不能因本地可读自动成为模型材料 |
| B9/B10 | 身份树、候选/已证关系、共享状态消费与只读展示 | 最终状态规则等 B16-P；宿主动作等 H08；全 tick 性能仍受 H03 门禁；不自行补第二 merger 或控制后门 |

O6APPLY 只同步契约及必要共享类型，不是新运行组件。B3a-R1 收尾、B3b-Facts、B12D、B16-P 的写路径由 ORCH 串行安排共享文件所有权；不以多套实现解决合并冲突。

## 可删或推迟

| 项目 | 裁决与 G13/G14 理由 |
|---|---|
| 可供生产选择的 Node group 后端及 `=` 特例 fallback | 删除；一个默认执行器足够，保留必要的 test-only 真实 wait 证据即可 |
| 单 shell CHLD/read 方案、拒绝全部 Bash-sh 主机、强制 dash | 不继续；最终 D 已有可用的有界替代及三种 shell 证据 |
| 为缺原生退出结果另造渐进回执、额外日志或执行协议 | 不做；现有 nullable native/shell 与私有编码诊断已足够 |
| WAL+NORMAL、后台发布后从 tick 中扣账、擅改 p95 或拆预算 | 本轮不做；需要改变的保证必须明示送 Pro，不能以优化名义偷换 |
| 无限 journal/存储参数搜索、新持久化 daemon/GC/flusher | 不做；B12D 限一次有界方向，剩余冲突由预算/范围决策解决 |
| 可见 verify→数字 PGID 信号、单 PID 降级、TTY 字节模拟取消 | 删除生产候选；已有设计反例，不能用快路径或更多 procfs 检查补成稳定交付 |
| 为可见控制立即并行开发 native、PTY、sidecar 多套方案 | 不做；先取得必要的范围取舍，再允许一个 B3b-C 方案 |
| 新 `visible.context` 环境事件、完整 HERDR_* 持久副本 | 不做；已有 HostLocator/SurfaceLocator 与进程内提示各负其责 |
| B16 对每次普通来源差异写冲突、collector/B6/B10 各自解决 pending | 删除；保留唯一纯 merger，减少误报和状态分叉 |
| 无界 report ID 历史、每次重启补发所有 notice | 不做；已有有界状态、可信 cursor 与静默缺失基线满足本期语义 |
| 全量重跑未受影响的 A9、导出或身份矩阵 | 推迟；只补改动、真实证据缺口和正式 B14 门禁所需检查 |

## 你核实过的事实

以下列出与本次范围有关的读取及其实际结论；报告中的测试是原包证据，不是本次复测。

| 文件 / 只读命令 | 本次核实结果与限制 |
|---|---|
| `cat tmp/tasks/ORACLE6/{role,brief,queue}.md`；编排者随后限定范围 | 本题是架构裁决、只写本 answer、无子代理/其他模型/进程探针；最终范围仅 Q1–Q7，含 Q1a |
| `pwd`、上级 AGENTS.md 读取、`.codegraph` 目录检查、`codegraph explore ...` | cwd 为 `<repo>`；目录检查为存在，但 CodeGraph 返回无可用 index、exit 1，随后使用普通只读搜索；没有建索引 |
| `git log -5 --oneline` | 核对 HEAD=8e5f87b，包含 B3b 合并；未运行 Git 写操作 |
| 分段 `cat`/`sed`/`rg` 读取 contracts 01–07、concept §6/§15、工程计划相关行 | 核实身份/定位分离、R/Q/N、nullable native、完整组取消、五维来源职责、逐样本预算、材料及导出边界；引用的是相关章节，未声称完整代码审计 |
| consult1 contracts、consult2 D01、consult3 E02/E03、consult4 F08 相关段、consult5 G01–G11 | 保留精确来源、scope 结束独立于原生结果、静默完成基线、终态说明与冲突区分、同库一致发布和全成本预算；未重新裁定其未涉及部分 |
| `tmp/tasks/B3a-R1/report.md`、run/README、`process.ts`、`group-leader.ts`、`group-pipe.ts`、`control.ts` 相关路径 | 最终 D 是三个 shell；绝对 env/mkfifo、一次 RUN、环境引用、原始控制 EOF 封口和默认 native_unknown 已在主检出。Node 兼容实现仍在生产源码中；报告标明接受后待清理。只读脚本，没有执行 |
| `tmp/tasks/B12R/report.md`、`tmp/tasks/B16/report.md`；`observation-store.ts`、`checkpoint.ts`、`collect-lease.ts` 相关路径 | 原生盘超限及 tmpfs 对照在报告中保留；当前 store 明确要求 DELETE/FULL、同步事务 COMMIT，publishPrepared 包含租约/CAS/谱系/索引/投影原子提交。WAL+FULL 尚无本次所读报告的通过证据，H03 没有声称它已达标 |
| X2-C report 的开头与 Fix round 1、`arm-3.md`、`arm-3-recheck.md`、三个 answer-q 文件 | 初审启用的 numeric PGID 信号和前台成员 admission 曾被拒；最终通过的是取消拒绝与严格直接前台 admission。最终报告不能与早期 enabled ladder 结果混用 |
| `visible-process.ts`、`visible-host.ts`、`run-facts.ts`、run control、HostAdapter/locator/types 及 ledger 相关引用 | `signalVisibleScope` 恒 false；preflight 要求 PID=PGID=tpgid；信号 handler 没有合法 supervisor-signal carrier。rawKeys 确无该 kind。visibleHostContext 导出全部 HERDR_* 为进程内数据，已有独立 HostLocator/SurfaceLocator/runs.locator 可承载正式定位 |
| `docs/probes/hud-run-visible.md` 相关行 | A8 的 TTY/context 可行性、父 launcher 退出、supervisor 死亡的故障事实有明确边界；原型信号方式不是生产 no-reuse 证明 |
| 06 附录 C01/C04/C21/C30/C33/C46、C01/C04 JSON、`status/merge.ts`、B16 报告 | C01 当前会自动合成 activity 冲突；C04 当前将 tool deadline 压入整个来源 deadline；pendingResolution、blocked 映射、有界持久 dedup 和基线规则已有实现。H09/H10 是实质政策修改，不能只删“待 ARCH”文字 |
| 操作边界 | 本次只有文件读取、路径/符号搜索、git log 和一次失败的 CodeGraph 查询；未启动 harness、终端、测试、故障/性能探针、子代理或其他模型。唯一仓库写入为 `tmp/tasks/ORACLE6/answer.md` |
