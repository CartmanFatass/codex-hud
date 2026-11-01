# A3 补测：共享 app-server daemon 在场时的 Codex MCP 启动路径

- 日期：2026-11-01；CLI `0.166.0`，本机已安装的 managed app-server **`0.163.0`**。
- home：仅 `codex2` → `~/.codex`；没有升级 daemon 包，没有修改用户配置。
- 脚本：`tests/probes/codex-daemon.sh`；复用 A3 的 `common.sh` 和 `probe-mcp-server.mjs`，原样使用。
- 私有证据：`tmp/tasks/A3-daemon/evidence/run-20261101T111934-390134/`（git-ignored，目录 0700 / 文件 0600）。
- **测量完成；自动清理检查失败，随后经编排者明确授权完成 updater 清理。** 脚本的真实退出码为 `2`，不能写成 `0`。

## 方法

先记录 `~/.codex/app-server-daemon/` 文件名、类型、大小、pid 值、记录的启动 ticks、当前存活状态。原有 daemon 和 updater pid 均已死亡。按编排者补充指令，不备份文件内容、不回写死 pid / socket / lock，不自行操作 updater 文件。

先启动一个无提示 TUI（daemon 缺席），测 dotted env 覆盖；关闭后用 `CODEX_HOME=~/.codex codex2 app-server daemon start` 启动 daemon。实际输出报告 CLI `0.166.0` / app-server `0.163.0`，同时生成 daemon 和 updater 两个进程。后续两个 TUI 与 exec 都通过同一个 `codex2` 函数启动，不强制连接某个后端；因此本报告测的是 **daemon 正在运行时的默认 CLI 启动行为**，不是证明 TUI 已连接共享 daemon。

| 运行 | daemon 状态 | 模型回合 | 目的 |
|---|---|---:|---|
| absent TUI | 缺席 | 0 | dotted env 覆盖是否到达 |
| TUI A | 运行 | 0 | 并发实例隔离 |
| TUI B | 运行 | 1 | 调用元数据 / rollout / SQLite |
| exec | 运行，TUI A/B 仍在 | 1 | exec 的父链 / 元数据 / rollout |
| spoof exec | 同上 | 1 | 参数里合成伪造 `_meta` 的有界检查 |

共 **3 个模型回合**，`gpt-6-luna`、effort `low`，临时 cwd / `HUD_HOME`，合成提示。所有注册和 env 注入均通过 `-c`，包括三个独立键：

```text
-c mcp_servers.probe.env.PROBE_EXISTING="probe-preserved"
-c mcp_servers.probe.env.PROBE_CONFIG_TAG="probe-<run>"
-c mcp_servers.probe.env.HUD_CLAIM="<synthetic sentinel>"
```

shell 另外设置 `HUD_LINK=probe-shell-only`、`PROBE_SHELL_TAG=probe-shell-only`。服务器按 A3 的固定脱敏规则记录环境；`HUD_CLAIM` 的值总被遮盖，因此只直接观测其键存在，精确 claim 字节 **unmeasured**；同语法的 `PROBE_CONFIG_TAG` 则核对每次启动的准确值。

以服务器记录的 ppid 定位对应 CLI，采样 `/proc/<pid>/fd` / `fdinfo`，只保留本 home 的 rollout 路径和可写标志。保存的实测运行还遍历了服务器父链中的 Codex 祖先进程；没有读取其他会话正文。实测后，最终脚本把采样进程收窄为 probe CLI 直接父进程与本 home daemon，并增加了从 start 输出的 `process_spawned` 事件证明所有权、在 start 非零退出时也清理已证实自启 daemon 的处理。**这两项后续安全加固只通过 `bash -n` 静态语法检查，没有重跑 daemon / 模型；保存的运行证据不代表最终这些分支已被动态验收。** 评审后又补充独立于 pid 文件的清理核验：start 后立即保存 spawn 回执对应的 pid + ticks，清理时直接复查这些身份，即使 updater pid 文件已被删除也不能漏检。该核验另用本任务自启的 `sleep` 进程做合成 fixture：删 pid 文件但进程仍活时检查失败，终止该 fixture 进程后检查通过（`cleanup-verification-fixture.json`）；未再次启动 Codex daemon / 模型。按调用的 session id 定位 rollout，只读取 `session_meta.payload.id`；SQLite 只读，保存目标名、进程标识和计数，不保存日志正文。

退出时关闭自己创建的 `probe:*` tab；核对 daemon pid + 启动 ticks 后运行文档中的 stop。若 updater 仍在，脚本退出 `2` 并向编排者请求决定，不自行 TERM / KILL。

## 原始观测（脱敏）

### 进程、环境与逐调用身份

`summary.json`、`ps-live.txt`、各服务器 JSONL：

```text
absent   node(391521) <- codex(391128) <- zsh <- herdr
TUI A    node(393021) <- codex(392610) <- zsh <- herdr
TUI B    node(393814) <- codex(393602) <- zsh <- herdr
exec     node(395014) <- codex(394703) <- zsh <- timeout <- probe bash <- …
spoof    node(396411) <- codex(396139) <- zsh <- timeout <- probe bash <- …
daemon   pid=392023, startTicks=16893453（不在以上直接父链）
updater  pid=392155, startTicks=16893479
```

TUI A/B 同时存活，服务器 pid 各异；exec 和 spoof 也各有不同实例。仅证明这些测量启动各有独立服务器，不推及 resume / fork 或其他配置下的所有会话。

五个服务器 start 记录均包含：

```text
env.HUD_CLAIM       = <redacted>
env.PROBE_EXISTING  = probe-preserved
env.PROBE_CONFIG_TAG= probe-absent / probe-tui-a / probe-tui-b / probe-exec / probe-spoof
HUD_LINK / PROBE_SHELL_TAG / CODEX_HOME / HERDR_* 未出现在服务器环境
```

TUI 的父进程 env 选定键记录确认 `CODEX_HOME=~/.codex`，shell sentinels 在父进程存在。服务器 `envNames` 是基础环境加三个显式 env 键；exec 另有 `LC_ALL`。不能仅凭 sentinel 未到达推论任意环境键都会被过滤。

调用的 `params._meta.sessionId`、`params._meta["x-codex-turn-metadata"].session_id` 和 rollout 的 `session_meta.payload.id` 三者相等：

| 运行 | 三处相同的 id（缩短） | turn_trigger |
|---|---|---|
| TUI B | `01a1988d-d0e0…` | `user` |
| exec | `01a1988d-ed2f…` | `exec` |
| spoof | `01a1988e-203b…` | `exec` |

spoof 实际收到的 `params.arguments` 包含合成的 `_meta.sessionId="spoofed-0000"`、嵌套 `session_id="spoofed-0000"` 和顶层 `sessionId="spoofed-0000"`；`params._meta` 没有伪造值，仍匹配 rollout。结论仍是 **bounded check only, harness stamping rules unverified**。

### Rollout 写入进程与 SQLite

`rollout-fd.jsonl` 采样到 TUI B `393602`、exec `394703`、spoof exec `396139` 分别持有各自匹配 rollout 的 **可写、append fd**。采样没有发现 daemon 持有这些 rollout 的 fd。由这些正向句柄证据推断，测得的 TUI / exec 进程负责各自 rollout 写入；没有追踪 `write(2)`，没有测无提示 TUI A 的 rollout 写入，也不把采样未见当作 daemon 永远不可能写入的证明。

`summary.json` 和较晚的 `logs-confirmation.json`：

```text
TUI B session: 46 rows, process_uuid=pid:393602:<shortened>
exec session:   0 rows
spoof session:  0 rows
```

TUI A/B 各有 2 条 `codex_tui::app::startup`；TUI B 还在同一 CLI 进程标识下记录 `codex_app_server::message_processor`、`codex_app_server::outgoing_message` 等 target。exec 的 session id 和进程 uuid 查询均无行。这只覆盖保存的查询时刻，不能宣称 exec 永不写 SQLite。

### 启停与最终状态

`daemon-before.json`：原 daemon pid `1909540`、原 updater pid `6254` 均 dead。`daemon-start.txt` 逐条记录本次 spawn 事件，daemon `392023`、updater `392155`。

`daemon-stop.txt` 的结构化输出（脱敏）：

```json
{"event":"shutdown_requested","details":{"pid":392023}}
{"status":"stopped","backend":"pid","managedCodexPath":"~/.codex/packages/app-server-daemon/current/bin/codex","managedCodexVersion":"0.163.0","socketPath":"~/.codex/app-server-control/app-server-control.sock","cliVersion":"0.166.0"}
```

stop 后 daemon 消失，updater `392155` 仍存活；脚本原始输出：

```text
env overrides, shell filtering, separate TUI instances, rollout identity and bounded spoof checks: PASS
new live daemon/updater processes: 1
exit=2
```

编排者随后只授权对 updater `392155` 发一次 SIGTERM，要求即时重验 `comm=codex`、`startTicks=16893479`，最多等 10 s。实际通过 pidfd 固定进程，重验后发送一次 SIGTERM，0.1 s 后 `/proc/392155` 消失；没有 SIGKILL。见 `updater-authorized-cleanup.json`。最终另行验证：

```text
owned daemon 392023: gone; owned updater 392155: gone
```

`daemon-after-authorized-cleanup.json` / `final-differences.json` 的完整变化：

| 文件 | before → final |
|---|---|
| `daemon.pid` | 旧死 pid 文件 433 B → 不存在 |
| `daemon-updater.pid` | 旧死 pid 文件 145 B → 新死 pid 文件 150 B（pid `392155`，ticks `16893479`） |
| `daemon.stderr.log` | 24026 B → 0 B |
| `daemon.stderr.log.previous` | 18943 B → 24026 B |
| `daemon-updater.stderr.log` | 44939 B → 0 B |
| `daemon-updater.stderr.log.previous` | 24308 B → 44939 B |

其余目录项（包括 lock 文件和 updater socket）按记录的名称、类型、大小均未变；不是逐字节比较。没有手动恢复任何 runtime 文件。按编排者澄清后的验收 #2，**无本次启动的 daemon/updater 遗留，最终状态通过**。

## 结论

1. **仅对 CLI 0.166.0 + managed daemon 0.163.0、`~/.codex`、默认启动路径**：daemon 在场并不导致测得的 MCP 服务器由 daemon 代启。两个并发 TUI 与两个 exec 各自直接启动独立 stdio 服务器。
2. shell 的两项合成 env sentinel 未到达；`-c mcp_servers.<name>.env.<KEY>=…` 在 daemon 缺席 TUI、daemon 在场 TUI/exec 均到达，多个键同时保留。`HUD_CLAIM` 键到达；其精确值被 helper 遮盖，直接字节核对 **unmeasured**。
3. 三次调用的真实元数据匹配 rollout；一次参数伪造没有覆盖真正的 `_meta`，不能升级为授权来源的完整可信证明。
4. 可写 rollout fd 属于对应 TUI/exec，TUI session 有 SQLite 行；测得 exec sessions 无行。仅靠“daemon 正在运行”判断 rollout 写入者不成立。
5. **同版本 0.166 managed daemon、强制 daemon 连接、resume / fork、共享 MCP 实例内多 session、其他 home / 版本 / 传输均 unmeasured。**
6. 自动脚本未达到验收 #1 的 exit 0：vendor stop 留下 updater，正确触发失败与升级。没有为凑 exit 0 再跑模型 / daemon，也没有把事后人工授权清理伪装成脚本成功。

## 对契约的影响

- **契约 01**：本配置落在“CLI 专属 stdio 实例、ppid + procStart 定位 harness、逐调用元数据与 rollout 交叉核验”的分支。不能因共享 daemon 存活就选共享 `caller_contexts` 分支；同版本 / 强制连接下的 daemon 代启分支仍 unmeasured，保留其可信逐调用来源条件门。本次 spoof 不能替代 stamping / 覆盖规则证据。
- **claim 通道（契约 01 / 04）**：per-launch dotted `-c mcp_servers.hud.env.HUD_CLAIM=…` 可作为本配置的显式 env claim 注入路径，服务器名须已知，正确做 TOML 与 argv 引用；无需整体替换 env 表。直接依赖 launching shell 的 claim 继承没有本次证据支持。helper 只证明 `HUD_CLAIM` 键与同语法 sentinel 的传递，真实 claim 的兑换、保密及逐字节核对 unmeasured。
- **现有 `src/collectors/daemon-binding.ts`**：日志中的 app-server target 可以来自 TUI 自身的 in-process server；不要把 rollout 写入者恒定等同于 shared daemon。保留启动行 / connection / thread 证据路径与 fallback；本补测未执行该 resolver 的端到端调用，不能声称它在本配置已验收。
- **契约 04 / B3a**：文档的 `daemon stop` 不保证清理 `daemon start` 启动的全部进程。hud-run 须按已记录的启动回执 / pid + procStart / 受管范围核实终结，不能用 vendor stop 的 `status=stopped` 代替所有受管进程已退出的证据。此次 updater 在授权前未被脚本自行停止；这是观察结果，不自动扩大未来 supervisor 的信号权限。
