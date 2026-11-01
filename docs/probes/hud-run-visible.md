# A8：hud-run 可见运行（方案甲 wrapper vs 方案乙 sidecar）

- 日期：2026-11-01（UTC）
- 环境：codex-cli 0.166.0、Claude Code 2.1.305、pi 1.4.0、herdr 0.9.5、Node v24.22.1、WSL2（kernel 6.18.33.2）
- 分支：`universal-hud`；WP A8（engineering plan v1.1 §4）
- 结论：**采用方案甲（wrapper）**（Oracle 2026-11-01 §4；乙不作为 MVP 受管后端）。B2 补齐第 1、2、11 行后，甲在 12+1 行中：第 1、2、11 行通过；第 12 行是已记录的故障语义（supervisor 死亡 ⇒ 交互中断、`uncertain` 持槽、禁止自动 input/focus），不是正常运行的通过项。第 11 行只在“hud-run 是 pane 前台作业”的生产形态下通过；B1 的 `sh -c '<supervisor> &'` 后台启动形态对 TTY-reading harness 失败（输入落到 pane shell，intermediate shell 以 149/SIGTTIN 退出）。shell 模式下 harness 原生退出码/信号仍不可知（`harnessExitCode`/`harnessSignal=null`），receipt 的 `shellStatus` 只是中间 shell 的状态。第 2 行的 context 效果在甲下由 Codex 实际执行的命令证明；乙的第 1、2 行按 note 未重测（需额外模型轮次）。

## 方法

### 原型

两个一次性原型，均无依赖，位于 `tests/probes/lib/`：

- `mini-hud-run.mjs`（方案甲）：被 `herdr pane run` 打进 pane 的交互 shell；自己 `spawn($SHELL, ['-ic', text], {stdio: 'inherit'})`，因此 `codex` zsh 函数和 `codex-with-herdr-context` 包装器照常生效。启动后从进程树发现 harness（TTY 前台组的 leader，或 `exec`/函数形式下前台组里的非 shell 直接子进程），把 `harnessPid`、`/proc/<pid>/stat` 的 `starttime`（字段 22）和 `pgrp` 写进 `meta.json.scope`；1 s 心跳；每次发信号前重验 pid+start（以及 pgid 实例）；收到 SIGINT/SIGTERM/SIGHUP 时向已核验的 harness 组发 `SIGINT → 10 s → SIGTERM → 2 s → SIGKILL`（组与 supervisor 共享时改发 harness pid，避免打到自己）；只有确认该 PGID 下没有活进程（zombie 单独记录）才写 `exit.json`，否则写 `no-receipt.json` 并说明原因。`exit.json` 把 `shellStatus`/`shellSignal` 与 `harnessExitCode`/`harnessSignal` 分开，`group` 字段给出空组检查时刻、成员和 zombie。产物在 `runs/<runId>/{meta,heartbeat,signals,exit,no-receipt,supervisor.log}`。
- `mini-sidecar.mjs`（方案乙）：harness 按今天的方式启动（`herdr pane run "codex …"`）；sidecar 在 pane 外每 300 ms 轮询 `herdr pane process-info` 与 `herdr pane get`，只记录“前台进程消失”的时刻；Herdr pane API 不提供退出码/信号，所以写 `observed-exit.json`（`exitCode: null`、`receiptWritten: false`）；pane 消失时写 `observed-pane-gone.json`。产物在 `runs/<runId>/sidecar/`。

编排脚本 `tests/probes/hud-run-visible.sh` 对两个候选跑同一组场景，每个场景一个全新 tab；整个脚本用一个临时 `HUD_HOME`（`mktemp -d`），每个场景用不同的 `runId` 隔离 receipt/heartbeat；结束时由 trap 关闭所有 `probe:*` tab。

### 场景

| 场景 | 做法 | 对应检查行 |
|---|---|---|
| `normal` | 启动 TUI → `herdr agent prompt` 问一句合成问题（`Reply with exactly OK.`）→ split/unsplit 改 pane 大小 → `/quit` | 1–5、7、8 |
| `normal-exec` | 同 `normal`，但 `--shell "exec codex …"`（B1 新增，只跑甲） | 8、exec 观测 |
| `ctrlc` | 启动 TUI，`herdr agent send-keys <pane> ctrl+c` | 6 |
| `kill` | 启动 TUI，`kill -9` 前台 harness pid | 9 |
| `pane-close` | 启动 TUI，`herdr pane close` | 10 |
| `cancel` | 启动 TUI，`kill -INT <supervisor>`；supervisor 向已核验 harness 组发 INT→TERM→KILL，组空才写 receipt（B1 新增，只跑甲） | 新增行 |
| `context` | 启动 TUI → `herdr agent list` 采样 ready/working/done/idle → 让 Codex 执行一次合成 context 探针命令 → 第二次便宜 turn 观察 idle→working→idle → `/quit`（B2 新增，只跑甲） | 1、2 |
| `parent-exit` | launcher shell 调 `herdr pane run` 后退出；pane shell 仍以 hud-run 为前台作业；TTY stand-in 收 `hello`、`exit 5`（B2 重做） | 11 |
| `parent-exit-bg` | B1 旧形态的负对照：`sh -c '<supervisor> &'` 让 launcher 退出，pane shell 回到 prompt；同一 TTY stand-in（B2 新增，只跑甲） | 11 |
| `supervisor-death` | 启动 TUI，`kill -9` supervisor（甲）/ sidecar（乙）；3 s 后记录 harness `/proc/<pid>/stat` 的 state/tpgid、Herdr 的 pane 前台组，再发一个不提交的合成按键 `x`，记录它落在哪里 | 12 |

为了缩短 TUI 启动时间，Codex 命令带 `-c 'mcp_servers={}'` 覆盖（只影响本次运行的 MCP 表，不影响本探针的监督行；Herdr context wrapper 自己的 `-c shell_environment_policy.set.HERDR_*` 仍然生效）。模型只用 `gpt-6-luna`、effort low。A8 第一次运行有 `normal` 的 2 次模型轮次；开发阶段另有 4 次（含一次误把命令文本提交给 TUI 的意外轮次），合计 6 次。A8-fixB1 另有 4 次（`normal` 和 `normal-exec` 各两轮，见 `tmp/tasks/A8-fixB1/report.md`）。A8-fixB2 的 `context` 行用了 4 次：第一次 `jia-context` 1 次（context probe）、重跑 1 次（修 timeline 读取）、最后一次 2 次（context probe + 第二次便宜 turn）；`parent-exit`/`parent-exit-bg` 无模型轮次。B2 在 brief 的 5 次以内。A3 的五个探针按验收命令重跑，它们自己的模型调用不计入 A8 预算。

### 证据与脱敏

原始证据在 `tmp/tasks/A8/evidence/hud-run-visible/`（git-ignored）：

- `versions.txt`、`notes.txt`、`commands.txt`、`summary.txt`、`herdr.jsonl`、`herdr-errors.txt`
- `jia/{normal,normal-exec,ctrlc,kill,pane-close,cancel,context,parent-exit,parent-exit-bg,supervisor-death}/`
- `yi/{normal,ctrlc,kill,pane-close,parent-exit,supervisor-death}/`

报告只引用结构、状态和合成 prompt 的标题；session id 用 `<session-id>` 代替；路径用 `~`；未读取或打印任何 API key / auth 文件。第 3–7 行来自第一次运行/B1 的 `normal`、`ctrlc` 证据；第 8、9、10、12 行和 `cancel`、`normal-exec` 行来自 B1；第 1、2、11 行来自 B2。B2 的 `context` 行只跑甲；`parent-exit` 行跑甲、乙，另有甲的后台启动负对照 `parent-exit-bg`。B2 的最终证据在 `jia/context/`、`jia/parent-exit/`、`jia/parent-exit-bg/`、`yi/parent-exit/`；未选中的 B1 行在 `probe_begin` 重建证据树后从 `hud-run-visible-previous/` 恢复。B2 的运行：`A8_ONLY=jia-context,jia-parent-exit,yi-parent-exit`（1 次模型轮次），`A8_ONLY=jia-context` 两次（1 次和 2 次模型轮次；第一次修 timeline 读取，第二次加第二次 turn）。

## 原始观测（脱敏）

### 1. Herdr 识别 agent（B2 重测，甲）

- `jia/context/agent-list-ready.json`（TUI 就绪、`agent` 刚被识别、turn 之前）：`{"present":true,"agent":"codex","agent_status":"working","agent_session_present":false,...}`。`agent_session` 此时还没有；`agent_status` 已经是 `working`，不是 `idle`。
- `jia/context/agent-list-working.json`（timeline 的第一个 working 样本）：同样的 `working`、session 缺席；`jia/context/agent-list-working-session.json`（第一个带 session 的 working 样本）为 `working`、`agent_session_present:true`、`kind:"id"`、`source:"herdr:codex"`。
- `jia/context/agent-list-done.json`（第一次 turn 完成后）：`{"agent":"codex","agent_status":"done","agent_session_present":true,...}`。`jia/context/agent-list-after-read.json` 仍是 `done`：`herdr agent list`/`pane read` 这类 status API 读取不确认完成。
- `jia/context/agent-list-idle.json`（`herdr tab focus <probe tab>` 之后）：`{"agent":"codex","agent_status":"idle","agent_session_present":true,"focused":true,...}`。查看/聚焦该 tab 把未读的 `done` 投影变成 `idle`。
- 第二次便宜 turn（`agent-list-timeline-2.jsonl`）：`idle` → `working`（`agent-list-second-working.json`，session 仍在）→ `idle`（`agent-list-second-after.json`）。因为该 tab 已经被查看过，第二次完成直接投影成 `idle`，没有再出现 `done`。
- `/quit` 后 `agent-list-after-quit.json` 为 `{"present":false,"agent":null,...}`。
- 乙：B1/第一次运行的 `yi/normal/status-timeline.jsonl` 仍是 `unknown → working → done`，`yi/ctrlc/agent-list.json` 仍是 `unknown`；B2 按 note 没有为乙花额外模型轮次重测 `agent list`。
- 结论：同一个被识别的 codex/session 观察到了 `working`（session 未注册）→ `working`（session 已注册）→ `done`（未读完成）→ `done`（status 读取不确认）→ `idle`（查看后确认）→ `idle → working → idle`（第二次 turn，已查看的 tab 不再产生 `done`）→ 退出后 `present:false`。`done` 是 Herdr 的“未读完成”投影，`idle` 是已确认/可交互状态；`agent_session` 在 `agent` 被识别后几秒才出现，不能把 `agent` 出现当作 session 已绑定。第 1 行通过。

### 2. Herdr context wrapper（B2：实际命令效果）

- 甲：`jia/context/context-probe.txt` 是 Codex 的 shell tool 实际执行的合成命令输出（模型只回 `DONE`；输出文件由该命令写入）：

  ```text
  probe=herdr-context-v1
  run=context-jia
  herdr_key_count=9
  env_present=true
  workspace_present=true
  tab_present=true
  pane_present=true
  session_present=true
  socket_present=true
  socket_path_present=true
  config_path_present=true
  workspace_matches=true
  tab_matches=true
  pane_matches=true
  ancestor_codex=true
  ```

  8 个预期 `HERDR_*` 键全部存在，workspace/tab/pane 与期望值相等；`herdr_key_count=9` 表示还有一个未记录名字的 `HERDR_*` 键（可能来自 launcher 的 `HERDR_AGENT` 提示；本探针只数个数，不记录值）。`ancestor_codex=true` 表示命令的祖先链里有 `codex` 进程。TUI 在命令前显示一次 `Hook failed (code 2)`，命令仍然执行并写出输出；本探针没有调查该 hook。
- 旧的 argv/env 证据仍在：`jia/normal/harness.argv.txt` 有 8 个 `-c shell_environment_policy.set.HERDR_*`，`harness.env.txt` 有 `HERDR_*` 和 `CODEX_HOME`。它们只证明配置，不证明命令效果；B2 的命令输出补上了效果。
- 乙：`yi/normal/harness.argv.txt`/`harness.env.txt` 同样有 wrapper 配置，但按 note 没有为乙花额外模型轮次执行命令；乙的第 2 行标记为“未重测”，不能把 argv/env 当作命令效果。
- 结论：甲下，Codex 实际执行的命令收到了本 pane 的 context（8 键齐全、workspace/tab/pane 全等），第 2 行通过；乙的第 2 行未重测，仍是不完整。

### 3. zsh 函数 `codex`

- 甲：`jia/normal/zsh-function.txt`：`codex is a shell function from ~/.zshrc`。supervisor 用 `$SHELL -ic "<text>"`，TUI 能启动，说明函数在非交互 shell 里也被解析。
- 乙：`yi/normal/zsh-function.txt` 同样；pane 的交互 shell 直接解析函数。
- 结论：两者都通过。甲的关键点是 `-ic`（而不是 `-c`）会 source `~/.zshrc`。

### 4. 前台进程组

- 甲：`jia/normal/process-info.json`（B1 重测）：`shell_pid: 339227`，`foreground_process_group_id: 340224`，`foreground_processes: [{pid: 340224, name: "codex"}, {pid: 340391, name: "powershell.exe"}]`；`jia/normal/harness.stat.txt`：codex `pgrp=340224`、`session=339227`、`tpgid=340224`。supervisor 的 `meta.json` 里 `supervisorPgid` 是它自己的 pgid（339915），与前台组不同；`scope-pane.json` 与 `scope-supervisor.json` 的 pid/pgid 一致。
- 乙：`yi/normal/process-info.json`：`shell_pid: 247118`，`foreground_process_group_id: 247850`（codex），`foreground_processes` 同样是 codex + powershell。
- 结论：harness 是 pane 的终端前台作业；甲 的 supervisor 在 pane 的前台作业组里，但不抢终端前台（harness 是终端前台组），也不读 stdin；job control 正常。

### 5. 输入 `herdr agent prompt`

- 甲：`jia/normal/prompt.json` 返回 `agent_status: "done"`、`terminal_title: "Reply OK | tmp"`、`agent_session`；`status-timeline.jsonl` 在 prompt 之后有一段 `working`，随后 `done`；`pane-after-prompt.txt` 显示 TUI 回到 `› Ask Codex to do anything`（98% context left）。
- 乙：`yi/normal/prompt.json` 同样 `done`、`Reply OK | tmp`；`status-timeline.jsonl` 同样 `working` → `done`。
- 结论：`herdr agent prompt` 的文本进入 harness 并启动 turn；甲 的 wrapper 不影响输入路径。

### 6. Ctrl-C

- 甲：`jia/ctrlc/pane-before.txt` 是 TUI prompt；`send-keys.json` 返回 `{"type":"ok"}`；`pane-after.txt` 回到 shell prompt（`✔`）；`run/exit.json`：`exitCode: 0`、`signal: null`、`reason: "exited"`。`run/signals.jsonl` 不存在（supervisor 没收到 SIGINT）。
- 乙：`yi/ctrlc/pane-after.txt` 同样回到 shell prompt（`✔`）；`run/sidecar/observed-exit.json`：`exitCode: null`、`receiptWritten: false`。
- 结论：Ctrl-C 直接到达前台 harness（codex 退出），与没有 wrapper 时一致；supervisor 在后台组，不拦截 Ctrl-C，也不应把它当作自己的取消信号。

### 7. Resize

- 甲：`jia/normal/pane-before-resize.json` 的 `viewport_rows=43`；split 后 `pane-after-split.json` 为 20；unsplit 后 `pane-after-unsplit.json` 为 43。两次 `pane-*.txt` 都能看到 TUI 的 prompt/footer（`Ask Codex to do anything`、context 百分比、warnings）。
- 乙：`yi/normal/pane-*.json` 同样 43 → 20 → 43，TUI 同样重绘。
- 结论：SIGWINCH 到达 TUI；两种方式都正确重绘。

### 8. 正常退出 `/quit`（甲重测）

- 甲：`jia/normal/run/exit.json`（字段节选）：

  ```json
  {"reason":"exited","supervisorSignal":null,
   "supervisorPid":339915,"supervisorPgid":339915,
   "childPid":339941,"childPidStart":"16767450",
   "harnessPid":340224,"harnessPidStart":"16767506","harnessPgid":340224,
   "harnessIsGroupLeader":true,"harnessPgidSharedWithSupervisor":false,
   "shellStatus":0,"shellSignal":null,"shellExitObserved":true,
   "harnessExitCode":null,"harnessSignal":null,"harnessExitSource":null,
   "group":{"pgid":340224,"empty":true,"checkedAt":"2026-11-01T18:59:26.515Z","members":[],"zombies":[],"excluded":[]}}
  ```

- 交叉核对：`jia/normal/harness.stat.txt` 为 `pid=340224 comm=(codex) state=S ppid=339941 pgrp=340224 session=339227 tpgid=340224 starttime=16767506`；`jia/normal/scope-pane.json` 的 pane 前台 pid/pgid 都是 340224；`jia/normal/scope-supervisor.json` 的 `pgid`/`harnessPid` 也是 340224、`sharedWithSupervisor: false`。supervisor 的 `childPid` 339941 是中间 shell，harness 是它的子进程（`ppid=339941`）。
- 乙：`yi/normal/run/sidecar/observed-exit.json`：`harnessPid: 247850`、`harnessName: "python3"`、`exitCode: null`、`signal: null`、`receiptWritten: false`、`observedAt: "2026-11-01T18:28:11.754Z"`；没有 `exit.json`。
- 结论：甲 的 receipt 在 harness PGID 340224 已空之后才写出，`shellStatus=0` 是中间 shell 的状态；`harnessExitCode`/`harnessSignal` 为 null，因为 harness 不是 supervisor 的直接子进程，supervisor 不能 `wait()` 它。乙 只能看到退出时刻，拿不到退出码，运行保持 `uncertain`。

### 9. `kill -9` harness（甲重测）

- 甲：`jia/kill/harness-before-kill.stat.txt`：`pid=347177 comm=(codex) state=S ppid=346900 pgrp=347177 session=346518 tpgid=347177 starttime=16776782`；`jia/kill/process-info.json` 的前台组是 347177（codex + powershell.exe）。`jia/kill/run/exit.json`：`reason: "exited"`、`shellStatus: 137`、`shellSignal: null`、`harnessExitCode: null`、`harnessSignal: null`、`harnessPid: 347177`、`harnessPgid: 347177`、`group.empty: true`、`group.zombies: []`。
- `jia/kill/run/supervisor.log`：`child exit code=137` 后先记录 `shell exited but group 347177 still has 1 member(s); waiting for drain`，0.8 s 后组空才写 receipt（`19:00:19.348Z`）。也就是说，shell 退出本身没有直接触发 receipt；是“组空”触发的。
- 乙：`yi/kill/run/sidecar/observed-exit.json`：`harnessPid: 252013`、`harnessName: "codex"`、`exitCode: null`、`signal: null`、`receiptWritten: false`；pane 显示 `KILL`。
- 结论：甲 的 receipt 有 scope 级“组空”证明，但 137 是 shell 对 SIGKILL 的编码（128+9），不是 harness 的原生信号；`harnessSignal` 仍为 null。乙 诚实缺失（brief 允许），运行仍是 `uncertain`。

### 10. Pane close（甲重测）

- 甲：`jia/pane-close/harness-before-close.stat.txt`：`pid=348379 comm=(codex) ... tpgid=348379`；`process-info-before.json` 的前台组是 348379。`jia/pane-close/run/exit.json`：`reason: "supervisor-signal"`、`supervisorSignal: "SIGHUP"`、`shellStatus: 1`、`shellSignal: null`、`shellExitObserved: true`、`harnessPid: 348379`、`harnessPgid: 348379`、`group.empty: true`、`group.zombies: [{pid:348379,comm:"codex",state:"Z"},{pid:348566,comm:"powershell.exe",state:"Z"}]`、`cancel: {signal:"SIGHUP", steps:[], groupAlreadyEmpty:true}`。
- `signals.jsonl` 记录两次 SIGHUP（`19:00:23.843Z`、`19:00:23.855Z`）；`heartbeat-before.json`/`heartbeat-after.json` 的 `at` 从 `19:00:23.363Z` 变为 `19:00:23.870Z`，`childAlive`/`harnessAlive`/`groupAlive` 都从 true 变 false。
- 乙：`yi/pane-close/run/sidecar/observed-pane-gone.json`：`receiptWritten: false`、`reason: "pane process-info unavailable (pane closed or Herdr unreachable)"`；`heartbeat-before.json` 的 `sidecarAlive: true`，`heartbeat-after.json` 的 `sidecarAlive: false`。
- 结论：甲 的 pane close receipt 有 scope 级组空证明（只剩 zombie），`shellStatus=1` 是中间 shell 的状态，`supervisorSignal=SIGHUP` 只说明 supervisor 收到 HUP；终端先杀掉了 harness 组，所以 supervisor 的取消序列没有需要发的信号（`groupAlreadyEmpty: true`）。乙 只记录“pane 不见了”，没有退出码，只能算 n.a.。

### 11. Parent exit（B2 重做：TTY-reading stand-in）

- **甲，生产形态（`jia/parent-exit/`）**：launcher shell 调 `herdr pane run <pane> "<supervisor>"` 后退出（`launcher-exit.txt=0`、`launcher-gone.txt=gone`）；pane shell 仍以 hud-run 为前台作业。`meta.json.tty.stdin=true`。stand-in `/proc` 为 `state=S pgrp=431679 tpgid=431679`，`process-info-before.json` 的前台组也是 431679。`standin-status-before.json`：`stdinIsTTY=true`、`stdoutIsTTY=true`、`lines=0`；发 `hello` 后 `lines=1`（`reason:"line"`）；发 `exit 5` 后 `lines=2`、`sentinelSeen=true`、`reason:"sentinel"`。`run/exit.json`：`reason:"exited"`、`shellStatus:5`、`shellSignal:null`、`harnessPid=431679`、`harnessPgid=431679`、`group.empty=true`、`durationMs=4515`。`pane-after-hello.txt` 有 `STANDIN_READY`/`STANDIN_GOT=1`，`pane-after.txt` 有 `STANDIN_GOT=2`/`STANDIN_EXIT=5` 和 shell 的 `5 ✘`。**通过。**
- **甲，B1 后台启动形态（负对照，`jia/parent-exit-bg/`）**：`sh -c '<launcher> < /dev/tty &'` 让 launcher 退出，pane shell 回到 prompt。`meta.json.tty.stdin=true`；stand-in `/proc` 仍是 `state=S pgrp=432819 tpgid=432819`，`process-info-before.json` 的前台组也是 432819；但发 `hello` 后 `standin-status-after-hello.json` 仍是 `lines=0`，`pane-after-hello.txt` 显示 pane shell 执行了 `hello`（`zsh: command not found: hello`），intermediate shell 以 `shellStatus=149`（128+SIGTTIN）退出，`run/exit.json` 的 `group.empty=true`、`durationMs=1471`。receipt 写出来了，但不是 stand-in 的 sentinel 触发的；stand-in 没收到输入。**失败（旧形态）。**
- **乙（`yi/parent-exit/`）**：sidecar 的 launcher shell 退出（`launcher-exit.txt=0`、`launcher-gone.txt=gone`），sidecar 继续轮询；pane 直接运行 stand-in。stand-in 收到 `hello`（`lines=1`）和 `exit 5`（`lines=2`、`sentinelSeen=true`），pane 显示 `STANDIN_EXIT=5` 和 `5 ✘`。`run/sidecar/observed-exit.json`：`harnessPid=433678`、`harnessName:"MainThread"`、`exitCode:null`、`signal:null`、`receiptWritten:false`、`durationMs=4208`。TUI 活过了 launcher 退出并收到输入，但 sidecar 仍拿不到退出码，运行 `uncertain`。
- 结论：第 11 行在“hud-run 是 pane 前台作业”的生产形态下通过（甲）；B1 的后台启动形态对 TTY-reading harness 失败，说明那条 receipt 不能当作可见运行存活的证据。契约 04 必须要求这个前台启动形态（或终端代理），不能接受后台 launcher 的 receipt 作为 R。乙 的 TUI 存活但无 receipt，仍 `uncertain`。

### 12. Supervisor death（甲、乙重测）

- 甲：`jia/supervisor-death/harness.stat.txt`（杀 supervisor 前）：`pid=350955 comm=(codex) state=S ppid=350678 pgrp=350955 session=350295 tty_nr=34816 tpgid=350955 starttime=16778662`。`harness-after.stat.txt`（3 s 后）：同 pid/start/state S，但 `tpgid=350295`（pane shell 的组）。`process-info-before.json` 的前台组是 350955（codex + powershell.exe）；`process-info-after.json` 和 `process-info-after-input.json` 的前台组变成 350295（zsh，pane shell）。`input-echo.txt` 里合成的 `x` 落在 shell prompt 上（不是 TUI composer）；`pane-after.txt` 显示 `[1] 350668 killed node …` 和 `[1] + 350955 suspended (tty input)`，旧 TUI 画面还在但被 shell prompt 覆盖。`heartbeat-before.json`/`heartbeat-after.json` 的 `at` 都是 `2026-11-01T19:00:36.938Z`（心跳停止），`childAlive`/`harnessAlive`/`groupAlive` 仍为 true；`receipt-exists.txt` 显示没有 `exit.json`。
- 乙：`yi/supervisor-death/harness.stat.txt`（杀 sidecar 前）：`pid=352128 comm=(codex) state=S ppid=351732 pgrp=352128 session=351732 tty_nr=34820 tpgid=352128 starttime=16779438`；`harness-after.stat.txt` 同 pid/start/state/tpgid 352128。`process-info-before.json`/`process-info-after.json`/`process-info-after-input.json` 的前台组都是 352128（codex）。`input-echo.txt` 显示 `› x`（TUI composer）和 `tab to queue message`；`pane-after.txt` 仍是 `› Ask Codex to do anything`。`heartbeat-before.json`/`heartbeat-after.json` 的 `at` 都是 `2026-11-01T19:00:44.559Z`（sidecar 被 SIGKILL，心跳停止；`sidecarAlive: true` 是最后一条心跳的残留值）；没有 `exit.json`。
- 结论：甲 的 harness 进程还活着（state S），但终端前台已经回到 pane shell（tpgid/Herdr 前台组都变了），合成输入落到 shell prompt，随后 harness 因读终端被 `SIGTTIN` 挂起（`suspended (tty input)`）。所以“PID 还活着”不等于“可见 TUI 还能用”：甲 在 supervisor 被 SIGKILL 后不能继续交互，reconciler 必须把这种情况留在 `uncertain` 并禁止 input/focus。乙 的 TUI 仍是前台消费者，输入能进 TUI，但 sidecar 死了、没有 receipt，运行同样只能 `uncertain`。

### 13. `exec` 变体（甲，正常退出）

- `jia/normal-exec/run/exit.json`：`reason: "exited"`、`shellStatus: 0`、`harnessExitCode: null`、`harnessExitSource: null`、`harnessPid: 343838`、`harnessPgid: 343838`、`harnessIsGroupLeader: true`、`harnessPgidSharedWithSupervisor: false`、`group.empty: true`、`durationMs: 43451`。
- `jia/normal-exec/harness.stat.txt`：`pid=343838 comm=(codex) ppid=343561 pgrp=343838 tpgid=343838`；`jia/normal-exec/run/meta.json` 的 `supervisorPgid: 343553`；`exit.json` 的 `childPid: 343561`。`scope-pane.json`/`scope-supervisor.json` 的前台 pid/pgid 都是 343838。`prompt.json` 仍是 `agent_status: "done"`、标题 `Reply OK | tmp`；timeline 仍是 `working → done`。
- 结论：`$SHELL -ic "exec codex …"` 里的 `codex` 是 zsh 函数；zsh 在 shell 进程里执行函数，但函数里的外部命令仍被 fork 成新 job group（harness pid == pgid == 343838，ppid 仍是中间 shell 343561）。所以 `exec` 形式既没有让 harness 成为 supervisor 的直接子进程，也没有让它共享 supervisor 的组；它和普通 `-ic` 形式在进程关系上等价，不能用来补 `harnessExitCode`/`harnessSignal`。要让 harness 成为直接子进程，只能 `exec` 一个外部命令（例如直接 exec wrapper 二进制），那会绕过 zsh 函数/context wrapper；本探针没有把这条当作可行路径。

### 14. Supervisor 定向取消（甲）

- `jia/cancel/harness-before-cancel.stat.txt`：`pid=349716 comm=(codex) state=S ppid=349439 pgrp=349716 session=349033 tpgid=349716 starttime=16778134`；`process-info.json` 的前台组是 349716（codex + powershell.exe）。`jia/cancel/run/exit.json`：`reason: "cancel-confirmed"`、`supervisorSignal: "SIGINT"`、`shellStatus: 130`、`shellSignal: null`、`harnessExitCode: null`、`harnessSignal: null`、`harnessPid: 349716`、`harnessPgid: 349716`、`group.empty: true`、`cancel.steps: [{step:"SIGINT",sent:true,target:"group",harnessVerified:true,leaderGone:false}]`、`groupEmptyAt: "2026-11-01T19:00:32.206Z"`。
- `jia/cancel/run/signals.jsonl` 记录 supervisor 收到 SIGINT；`pane-after-cancel.txt` 回到 shell prompt（`INT ✘`）；`process-info-after.json` 的前台组是 349033（pane shell）。supervisor 只发了 SIGINT 就等到组空，没有升级到 SIGTERM/SIGKILL。
- 结论：`kill -INT <supervisor>` 被当作取消意图；supervisor 重验 harness pid+start 后向组发 SIGINT，codex 在空闲态退出，shell 以 130 退出，组空后写 receipt。终端 Ctrl-C（第 6 行）不会打到后台 supervisor，所以这条路径必须由 supervisor 自己转发，不能靠 TTY。

### 汇总（原始值）

| 场景 | 甲 | 乙 |
|---|---|---|
| normal | `reason=exited`，`shellStatus=0`，`harnessExitCode=null`，`group.empty=true`，43.2 s | `exitCode=null`，`receiptWritten=false`，42.9 s |
| normal-exec | `reason=exited`，`shellStatus=0`，`harnessPgid=343838`（自有组），`harnessExitCode=null`，`group.empty=true`，43.5 s | n.a. |
| ctrlc | `exitCode=0`，`signal=null`（第一次运行） | `exitCode=null`，`receiptWritten=false`（第一次运行） |
| kill | `shellStatus=137`，`harnessSignal=null`，`group.empty=true` | `exitCode=null`，`receiptWritten=false` |
| pane-close | `reason=supervisor-signal`，`supervisorSignal=SIGHUP`，`shellStatus=1`，`group.empty=true`（zombie 2） | `observed-pane-gone`，`receiptWritten=false` |
| cancel | `reason=cancel-confirmed`，`supervisorSignal=SIGINT`，`shellStatus=130`，`group.empty=true`，steps=[SIGINT] | n.a. |
| context | `agent-list`：working(session 未注册) → working(session) → done → done(status 读) → idle(查看) → idle→working→idle；context probe 8 个预期键存在、workspace/tab/pane 匹配 | n.a.（B2 按 note 未重测） |
| parent-exit | 生产形态：stand-in 收 hello/exit 5，`shellStatus=5`、`group.empty=true`；后台形态：输入落到 pane shell，`shellStatus=149` | stand-in 收 hello/exit 5；`observed-exit`：`exitCode=null`、`receiptWritten=false` |
| parent-exit-bg | `shellStatus=149`（SIGTTIN），`group.empty=true`，stand-in `lines=0` | n.a. |
| supervisor-death | 心跳停止，harness alive 但 tpgid 回到 pane shell，输入落到 shell，`suspended (tty input)`，无 receipt | 心跳停止，TUI 仍前台、输入进 TUI，无 receipt |

## 结论

### 检查表（12 行 + 新增取消行）

| # | 检查项 | 甲（wrapper） | 乙（sidecar） |
|---|---|---|---|
| 1 | Herdr 识别 agent | **pass（B2）** — `jia/context/agent-list-*.json`、`agent-list-timeline*.jsonl`（working→done→idle→working→idle，session 晚到） | **limited（B1/第一次运行；B2 未重测）** — 识别与 working→done 已观测（`yi/normal/status-timeline.jsonl`、`yi/ctrlc/agent-list.json`）；agent-list 的 idle 周期未观测 |
| 2 | Herdr context wrapper | **pass（B2）** — `jia/context/context-probe.txt`（8 个预期键存在、workspace/tab/pane 匹配，`ancestor_codex=true`） | **未重测（B2 按 note 不花额外模型轮次）** — `yi/normal/harness.argv.txt`/`env.txt` 只有配置 |
| 3 | zsh 函数 `codex` | **pass** — `jia/normal/zsh-function.txt` | **pass** — `yi/normal/zsh-function.txt` |
| 4 | 前台进程组 | **pass** — `jia/normal/process-info.json`、`harness.stat.txt` | **pass** — `yi/normal/process-info.json` |
| 5 | 输入 `agent prompt` | **pass** — `jia/normal/prompt.json`、`status-timeline.jsonl` | **pass** — `yi/normal/prompt.json`、`status-timeline.jsonl` |
| 6 | Ctrl-C | **pass** — `jia/ctrlc/pane-after.txt`、`run/exit.json` | **pass** — `yi/ctrlc/pane-after.txt`、`run/sidecar/observed-exit.json` |
| 7 | Resize | **pass** — `jia/normal/pane-*.json`（43→20→43） | **pass** — `yi/normal/pane-*.json`（43→20→43） |
| 8 | 正常退出 `/quit` | **pass（scope 组空）** — `jia/normal/run/exit.json`（`shellStatus=0`、`group.empty=true`；`harnessExitCode=null`） | **fail** — `yi/normal/run/sidecar/observed-exit.json`（无码、无 receipt） |
| 9 | `kill -9` harness | **pass（scope 组空）** — `jia/kill/run/exit.json`（`shellStatus=137`、`group.empty=true`；`harnessSignal=null`，137 是 shell 状态） | **pass（诚实缺失）** — `yi/kill/run/sidecar/observed-exit.json`（无码） |
| 10 | Pane close | **pass（scope 组空）** — `jia/pane-close/run/exit.json`（SIGHUP、`shellStatus=1`、`group.empty=true`、zombie 2） | **n.a.** — `yi/pane-close/run/sidecar/observed-pane-gone.json`（无码） |
| 11 | Parent exit | **pass（B2，生产形态）** — `jia/parent-exit/`（stand-in 收 hello/exit 5，`shellStatus=5`、`group.empty=true`）；后台形态 `jia/parent-exit-bg/` 失败（149/SIGTTIN） | **pass（TUI 存活）/ 无 receipt** — `yi/parent-exit/`（stand-in 收 hello/exit 5；`observed-exit` 无码） |
| 12 | Supervisor death | **pass（故障语义）** — `jia/supervisor-death/harness-after.stat.txt`（tpgid 回到 pane shell）、`process-info-after.json`（前台组是 pane shell）、`input-echo.txt`（输入落到 shell）、`pane-after.txt`（`suspended (tty input)`）；无 receipt → `uncertain` 持槽、禁止自动 input/focus | **pass（TUI 仍前台）/ 无 receipt** — `yi/supervisor-death/harness-after.stat.txt`、`process-info-after.json`、`input-echo.txt`（输入进 TUI）；无 receipt → `uncertain` |
| 13 | Supervisor 定向取消（新增） | **pass** — `jia/cancel/run/exit.json`（`cancel-confirmed`、`shellStatus=130`、`group.empty=true`、steps=[SIGINT]） | n.a. |

### 推荐

**采用方案甲（wrapper）；乙不作为 MVP 受管后端**（Oracle 2026-11-01 §4）。甲 的第 1、2、11 行在 B2 补齐后通过；第 12 行是已记录的故障语义：supervisor 被 SIGKILL 后交互中断，运行保持 `uncertain`、持槽、禁止自动 input/focus，不能把它当作“可见 TUI 仍可用”。原生退出结果可以未知：shell 模式下 `harnessExitCode`/`harnessSignal` 为 null，`shellStatus` 只是中间 shell 的状态；receipt 的 scope 证明是“已核验 harness PGID 无活成员”。第 11 行的通过有前提：hud-run 必须是 pane 的前台作业（launcher 通过 `herdr pane run` 启动后退出，pane shell 继续等待 hud-run）；B1 的 `sh -c '<supervisor> &'` 后台形态对 TTY-reading harness 失败，不能作为可见运行存活的证据。乙 的 TUI 在 launcher 退出后仍可交互，但乙 没有受管范围的结束证明，也没有可靠的取消/启动收尾通道，已发任务只能 `uncertain`，因此不作为 MVP 受管后端。甲 没有未解释的正常运行失败行；第 11 行的后台负对照失败是启动形态约束（hud-run 不能后台启动），不是组终止/回执机制失败。

### 甲 的边界与故障语义

- 第 12 行（supervisor death）：harness PID 还活着，但 tpgid 和 Herdr 前台组都回到 pane shell，合成输入落到 shell prompt，随后 harness 被 `SIGTTIN` 挂起（`suspended (tty input)`）。这不是“甲 整体失败”，而是“supervisor 死后必须 `uncertain`、禁止 input/focus、不能宣称 TUI 可继续交互”；Oracle 已接受这个中断语义。
- 第 11 行的后台负对照：`sh -c '<supervisor> &'` 让 pane shell 回到 prompt 后，stand-in 的 tpgid 仍是自己，但输入被 Herdr 送到 shell，intermediate shell 以 149（SIGTTIN）退出。生产实现必须保持 hud-run 为 pane 前台作业（或加终端代理），否则可见运行不可交互。
- 第 8、9 行的边界：receipt 的 scope 证明是“组空 + shell 状态”，不是 harness 原生信号；`harnessExitCode`/`harnessSignal` 仍为 null。第 9 行的 137 是 shell 状态，不能推成 SIGKILL。
- 第 10 行的 `shellStatus=1` 是 shell 状态，`supervisorSignal=SIGHUP` 只说明 supervisor 收到 HUP；harness 组是终端先杀掉的（`groupAlreadyEmpty: true`）。

### 乙 的失败/缺失行

- 第 8 行（正常退出）：sidecar 只看到前台进程消失，Herdr 没有退出码；按 brief 的规则不写 receipt。
- 第 11 行（parent exit）：TUI 活过 launcher 退出并收到 `hello`/`exit 5`，但 sidecar 仍拿不到退出码，`observed-exit` 为 `exitCode:null`、`receiptWritten:false`。
- 第 1、2 行：B2 按 note 没有为乙花额外模型轮次；`agent list` 的完整生命周期和 context 命令效果未重测。
- 第 9 行：诚实缺失（brief 允许），但运行仍是 `uncertain`。
- 第 10 行：只能写 `observed-pane-gone.json`，没有退出码，n.a.。
- 第 12 行：sidecar 被杀后 TUI 仍在前台、输入能进 TUI，但没有 receipt，运行仍是 `uncertain`；这比甲 的“失去前台”好，但仍不能终结。

## 对契约的影响

### Contract 04 必须写明的 receipt 字段（按甲 的实测）

```json
{
  "schemaVersion": 1,
  "runId": "normal-jia",
  "mode": "visible",
  "reason": "exited | signalled | cancel-confirmed | supervisor-signal | spawn-failed",
  "supervisorSignal": "SIGHUP | SIGTERM | SIGINT | null",
  "supervisorPid": 339915,
  "supervisorPidStart": "16767445",
  "supervisorPgid": 339915,
  "childPid": 339941,
  "childPidStart": "16767450",
  "harnessPid": 340224,
  "harnessPidStart": "16767506",
  "harnessPgid": 340224,
  "harnessIsGroupLeader": true,
  "harnessPgidSharedWithSupervisor": false,
  "shellStatus": 0,
  "shellSignal": null,
  "shellExitObserved": true,
  "harnessExitCode": null,
  "harnessSignal": null,
  "harnessExitSource": null,
  "startedAt": "2026-11-01T18:58:43.355Z",
  "endedAt": "2026-11-01T18:59:26.515Z",
  "durationMs": 43163,
  "group": {
    "pgid": 340224,
    "empty": true,
    "checkedAt": "2026-11-01T18:59:26.515Z",
    "members": [],
    "zombies": [],
    "excluded": []
  },
  "cancel": null
}
```

- `shellStatus`/`shellSignal` 是中间 shell（`childPid`）的状态；`harnessExitCode`/`harnessSignal` 只在 supervisor 是 harness 的直接父进程（argv 模式，或 shell 直接 exec 外部命令）时才非 null。两者不能合并，不能用 137/130 推 harness 的原生信号。
- `group` 是 scope 级证明：`empty: true` 表示检查时刻该 PGID 下没有活进程；`zombies` 单独列出（pane close 时 codex/powershell 是 Z，仍算组空）；`excluded` 只在组与 supervisor 共享时包含 supervisor pid。
- `cancel` 记录取消序列的每一步（`step`、`sent`、`target: group|pid`、`harnessVerified`、`leaderGone`）；`groupAlreadyEmpty: true` 表示 supervisor 收到信号时组已经空了（pane close 的实测）。
- 契约应把 `reason` 的取值、`supervisorSignal` 的含义、四个退出字段的来源写死；`startedAt`/`endedAt` 用 ISO-8601 UTC，`durationMs` 是 supervisor 观察到的墙钟时长（正式实现按 04 的单调钟规则）。

### Herdr `agent list` 生命周期（第 1 行）

- `done` 是 Herdr 对“未读完成”的投影；`herdr agent list`/`pane read` 这类 status API 读取不确认完成，`done` 会保持。
- 查看/聚焦 tab 后 `done` 变 `idle`；已被查看过的 tab 在下一次完成时可以直接投影成 `idle`，不再出现 `done`。B2 实测：第一次 turn `working → done`，聚焦后 `done → idle`；第二次 turn `idle → working → idle`。
- `agent_session` 在 `agent` 被识别后几秒才出现；`agent` 出现不等于 session 已绑定。`agent_session` 的 `value` 是 session id，探针只记录 presence/kind/source，不记录值。
- 契约 03/06（B16）应把 `done` 与 `idle` 都当作“当前无 turn 在进行”的注册表状态，用 `completion_seq`/`state_change_seq` 识别完成观测；不能把 `idle` 当作“从未完成”，也不能把 `agent` 出现当作 session 就绪。
- `agent_status: "working"` 可能在 TUI 启动阶段就出现（本机实测 ready 样本是 `working`、session 缺席）；就绪判断应结合 TUI prompt/`interactive_ready`，不能只看 `agent_status`。

### Context wrapper 的实际效果（第 2 行）

- 甲下，Codex 的 shell tool 实际执行的合成命令收到 8 个预期 `HERDR_*` 键，workspace/tab/pane 与期望值全等；`ancestor_codex=true`。这证明 wrapper 的效果，不只是 argv/env 配置。
- 探针只记录 presence/equality 布尔、键数和合成 marker；不记录 context 值、session id 或命令正文。
- 乙 的命令效果未重测（按 note 不花额外模型轮次）；不能把乙的 argv/env 当作命令效果。
- daemon-present 的命令执行没有单独强制（Oracle：不作为 A9 必测前置）；本机这次命令的祖先链是 codex，未观察到共享 daemon 代启。

### 父退出与前台作业（第 11 行）

- 生产形态：launcher shell 通过 `herdr pane run` 把 hud-run 敲进 pane 后退出；pane shell 继续把 hud-run 当作前台作业等待。TTY stand-in 的 `tpgid` 是自己，收到 `hello` 和 `exit 5`，supervisor 写 `shellStatus=5`、`group.empty=true` 的 receipt。
- 后台形态：`sh -c '<supervisor> &'` 让 launcher 退出后，pane shell 回到 prompt；stand-in 的 `tpgid` 仍是自己，但 pane 输入被 Herdr 送到 shell（`zsh: command not found: hello`），intermediate shell 以 149（SIGTTIN）退出。receipt 仍写出（`group.empty=true`），但它不是 stand-in 的 sentinel 证据。
- 契约 04 必须写死“hud-run 是 pane 的前台作业”这一启动形态（或要求终端代理）；不能把后台 launcher 的 receipt 当作可见运行存活/可交互的 R。父 MCP 断连（`orphan_policy: continue`）与此不同：父 MCP 退出不影响仍在前台的 hud-run。

### 必须记录的第二个 pid：harness 不是 `childPid`

甲的 supervisor 直接子进程是 `$SHELL -ic "<text>"`（`childPid`），harness（codex）是它的子进程。正常行实测：`childPid=339941`，harness pid=340224，`harness.stat.txt` 里 `ppid=339941`、`pgrp=340224`、`tpgid=340224`。因此：

- contract 04 必须要求 receipt 里同时有 `harnessPid`/`harnessPidStart`/`harnessPgid`，由 supervisor 从进程树发现（本原型用 TTY 前台组的 leader，或前台组里的非 shell 直接子进程），不能只写 `childPid`。
- 发现必须带 pid+start（必要时加 pgid 实例）重验；本原型在每次发信号前重验，pgid leader 的 start 变了就拒绝发信号（`pgid-reused`）。
- `exec codex …` 不是“让 harness 成为直接子进程”的办法：`codex` 是 zsh 函数，zsh 在 shell 进程里执行函数，但函数里的外部命令仍被 fork 成新 job group（实测 harness pid == pgid == 343838，ppid 仍是中间 shell 343561，`harnessPgidSharedWithSupervisor: false`）。要让 harness 成为直接子进程，只能 exec 一个外部命令（绕过 zsh 函数/context wrapper），本探针没有把这条当作可行路径。
- 第 9 行的 `shellStatus=137`：137 是 shell 对 SIGKILL 的编码。若契约要求“真实信号”，supervisor 必须能 wait harness（直接子进程）或用 ptrace 等更强手段；否则只能记录 shell 的 128+N，并把 `harnessSignal` 留 null。

### 取消与信号

- 终端 Ctrl-C 只到前台 harness 组，不到后台 supervisor（第 6 行 `signals.jsonl` 为空）；supervisor 定向 `kill -INT` 才会触发取消（第 14 行）。
- supervisor 收到 SIGINT/SIGTERM/SIGHUP 后，重验 harness pid+start，再向组发 `SIGINT → 10 s → SIGTERM → 2 s → SIGKILL`；组与 supervisor 共享时改发 harness pid（否则会打到自己）。本原型实测 SIGINT 一步就让空闲 codex 退出（`shellStatus=130`、组空），没有升级。
- pane close 时终端先杀掉 harness 组，supervisor 的 SIGHUP 处理只看到空组（`groupAlreadyEmpty: true`），receipt 仍写出 `supervisorSignal=SIGHUP` + `group.empty=true` + `shellStatus=1`。所以“supervisor 收到 HUP”只能作为部分证据，scope 级组空才是 R 的必要条件。
- 取消/信号成功不是终结；只有组空（且 receipt 落盘）才写 receipt。组空检查失败时写 `no-receipt.json`（`reason: group-not-empty`），不写 `exit.json`。

### Supervisor 死后：PID 活着 ≠ TUI 可用

甲 的实测（第 12 行）：`kill -9` supervisor 后，harness 仍是 `state=S`、PID 不变，但 tpgid 从 350955 变成 350295（pane shell），Herdr 的 `foreground_process_group_id` 也从 350955 变成 350295；合成 `x` 落到 shell prompt，`pane-after.txt` 显示 `[1] + 350955 suspended (tty input)`。所以：

- contract 04 不能把“harness PID 仍活”当作“可见 TUI 仍可用”；必须检查终端前台 owner（tpgid/前台组）和输入落点。
- supervisor 死亡/心跳过期时，即使 G=alive，也要 `uncertain` 持槽，禁止 input/focus；不能自动恢复前台或 resume 副本；持槽直到 R 或独立 Q。
- 终结规则是 R **或** 独立 Q，不是 receipt 单一路径：supervisor 被 SIGKILL、没有写出 receipt 时，运行保持 `uncertain` 并持槽；只有在拿到 R，或 reconciler 用独立证据建立 Q（原 harness 实例已结束、已核验 scope 无活 workload、所有可能继续提交的 launcher/控制通道已封口或确证死亡、无矛盾证据）之后，才可终结，且原生退出结果允许未知。仅 leader PID 不见、仅 pane 消失或仅心跳过期都不够；“人工”不替代证据。本节的 receipt 是原型产物，不是生产的身份/代次/封口协议；Q 不要求已经死去的写者补写 `exit.json`。
- 乙 的 sidecar 死亡不影响 TUI（前台组仍是 codex，输入进 composer），但没有 receipt，同样只能 `uncertain`。

### 事件与 `uncertain`

| 事件 | 甲 记录 | 乙 记录 | 契约要求 |
|---|---|---|---|
| 正常 `/quit` | `exit.json`：`reason=exited`、`shellStatus=0`、`group.empty=true`、`harnessExitCode=null` | 无 receipt，`observed-exit` 无码 | R 或独立 Q 都可终结；两者都没有时保持 `uncertain` |
| `kill -9` harness | `exit.json`：`shellStatus=137`、`harnessSignal=null`、`group.empty=true` | 无 receipt | 记录 shell 的 128+N；若需 harness 原生信号，必须能 wait harness |
| pane close | `exit.json`：`reason=supervisor-signal`、`supervisorSignal=SIGHUP`、`shellStatus=1`、`group.empty=true`（zombie 2） | `observed-pane-gone`，无码 | HUP 只是部分证据；组空才 R；无 R 且无独立 Q 则 `uncertain` |
| supervisor 定向取消 | `exit.json`：`reason=cancel-confirmed`、`supervisorSignal=SIGINT`、`shellStatus=130`、`group.empty=true`、steps=[SIGINT] | n.a. | 取消只按 R-02-2 终结；信号成功不是终结 |
| parent exit（生产形态） | `exit.json`：`shellStatus=5`、`group.empty=true`、`harnessExitCode=null`；stand-in 收到 hello/exit 5 | TUI 收到 hello/exit 5；`observed-exit` 无码 | 运行生命周期不绑定 launcher；TTY harness 必须仍前台可读 |
| parent exit（后台 launcher） | `exit.json`：`shellStatus=149`、`group.empty=true`；输入落到 pane shell，stand-in 未收到 | n.a. | 后台 launcher 的 receipt 不是可见运行存活证据；契约要求前台作业形态 |
| agent list 完成 | `done`（未读）→ `idle`（查看后）；已查看 tab 的下一轮直接 `idle` | 只有识别与 working→done（B1/第一次运行）；idle 周期未观测 | `done`/`idle` 都是无 turn 状态；用 `completion_seq` 识别完成 |
| context probe | Codex 执行的命令：8 个预期键存在、workspace/tab/pane 匹配 | 未重测 | wrapper 效果按实际命令证据，不按 argv/env |
| supervisor 被 SIGKILL | 心跳停止、无 receipt、harness 可能仍活着但失去前台 | 心跳停止、无 receipt、TUI 仍前台 | 心跳过期 ⇒ `uncertain` 持槽；禁止 input/focus；不得从“进程消失”推断退出码；R 或独立 Q 才终结 |

### 实现约束（甲）

- hud-run 必须是 pane 的前台作业：launcher 通过 `herdr pane run` 启动后可以退出，但 pane shell 必须继续等待 hud-run。不要用 `sh -c '<hud-run> &'` 后台启动可见运行；那样 pane shell 回到 prompt，TTY-reading harness 会失去输入（SIGTTIN/149）。
- supervisor 在 pane 的前台作业组里，但不读 stdin；Ctrl-C 由前台 harness 直接收到。supervisor 必须自己转发 supervisor 定向的 SIGINT/SIGTERM/SIGHUP，不能靠 TTY。
- 心跳 1 s（正式实现按 04 用 5 s/30 s）；reconciler 以“心跳过期 + 无 receipt”判 `uncertain`，并检查 harness 组是否仍活着；不要用 `herdr pane process-info` 的进程消失来推断退出码。
- pane close 时 supervisor 收到 SIGHUP，先写 `signals.jsonl`，再检查/转发组，最后写 `exit.json`（`reason=supervisor-signal`、`supervisorSignal=SIGHUP`）。
- `herdr agent prompt`、`herdr agent send-keys`、`herdr pane split/close` 都通过 pane 的终端路径工作；harness 是前台作业，resize（43→20→43）能重绘。
- Herdr context wrapper 的 `-c shell_environment_policy.set.HERDR_*` 和 `HERDR_*` 环境在甲、乙 下都生效；`$SHELL -ic` 会 source `~/.zshrc`，`codex` 函数解析为 `codex is a shell function from ~/.zshrc`。
- `herdr agent list`/`herdr pane get` 的 `agent_status` 在 turn 中为 `working`，turn 后为 `done`（未读）或 `idle`（已读）；`agent_session` 可能晚几秒出现；快照可能仍是 `unknown`，不要只用它判断“TUI 已就绪”。
- context wrapper 的实际效果用 Codex 执行的命令验证（第 2 行）；argv/env 只作配置证据。

### 乙 的契约含义

乙 可以在 `observed-exit.json` 里记录退出时刻（`observedAt`、`durationMs`、`harnessPid`），在 pane 消失时记录 `observed-pane-gone.json`；但 Herdr pane API 没有退出码/信号，乙 按 brief 的规则不写 receipt。乙 的 TUI 在 launcher 退出后仍可交互（第 11 行实测），sidecar 死亡也不破坏 TUI（第 12 行实测）。Oracle 淘汰乙 的理由不是“缺退出码”（甲 的原生结果同样允许未知），而是乙 既没有受管范围的结束证明，也没有可靠的取消/启动收尾通道：sidecar 只观察 pane 前台，无法证明已核验 scope 无活 workload、原 harness 实例不再执行、所有可能继续提交的 launcher/控制通道已封口或确证死亡。若选乙，contract 04 只能规定“所有可见运行在 sidecar 视角下都是 `uncertain`”，正常路径全部变成人工处理，直接破坏 G14；Oracle 已裁定乙不作为 MVP 受管后端，保留探针作为反证/未来观察型模式材料。

### 未决问题

- 乙 的第 1、2 行未重测（按 note 不花额外模型轮次）；乙的 argv/env 配置仍在，但命令效果和完整 agent-list 生命周期没有 B2 证据。
- 后台 launcher 形态失败：生产实现必须保证 hud-run 是 pane 前台作业；如果需要从后台 launcher 启动，必须加终端代理/前台接管，本探针没有实现。
- `done`/`idle` 的投影依赖 tab 是否被查看；B2 的 `idle` 样本是通过 `herdr tab focus` 短暂聚焦探针 tab 得到的，之后恢复了原来的 focused tab（`focus-before.txt`/`focus-restore.json`）。
- `herdr_key_count=9` 的第 9 个键没有记录名字（只数个数）；8 个预期键都存在、workspace/tab/pane 匹配，额外键不影响结论。
- daemon-present 的命令执行没有单独强制；本机这次 `ancestor_codex=true`，未观察到共享 daemon 代启。
- harness 原生信号在 shell 模式下仍不可得；`exec codex`（函数）不改变进程关系。若 04 要求原生信号，B3b 必须换启动结构（直接 exec 外部命令或 supervisor 自己解析函数），并重新测 context wrapper/函数。
- 组空检查把 zombie 排除在外（pane close 的 codex/powershell 是 Z），这是“组空”的合理定义，但契约要写明 zombie 不算活成员；如果要求“连 zombie 也没有”，需要等父进程 reap。
- 组与 supervisor 共享时（argv 模式或外部命令 exec），本原型改发 harness pid 而不是组，避免打到自己；这会不会漏掉同组后代，需要 B3b 用 anchor/控制句柄解决（04 已要求）。
- `harnessName` 在乙 的 `observed-exit` 里可能是 wrapper 的 OS `comm`（`python3`、`MainThread`），不是 `codex`；pid 才是权威关联。
- B2 的 ready 样本是 `agent_status: "working"`、`agent_session: null`；session 在几秒后才出现。契约不应把 `agent_status` 或 `agent_session` 的瞬时值当作唯一就绪信号；就绪判断应结合 TUI prompt/`interactive_ready`。
- 仓库级 `npm run format:check` 在 214 个既有文件上失败（与 A3 的基线一致）；A8 新增文件通过 `prettier --check tests/probes`。这是既有格式债，不是 A8 代码问题。
