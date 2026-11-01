# 探针 P1：Codex MCP 服务器的启动路径、环境与 `_meta`

- 日期：2026-11-01
- 版本：codex-cli 0.166.0、Claude Code 2.1.305、pi 1.4.0、herdr 0.9.5、Node v24.22.1（WSL2，kernel 6.18.33.2）
- 脚本：`tests/probes/codex-mcp-launch.sh`（`bash tests/probes/codex-mcp-launch.sh`，内部 `timeout 300`）
- 原始证据：`tmp/tasks/A3/evidence/codex-mcp-launch/`（git-ignored）

## 方法

用一个无依赖的 stdio 探针 MCP 服务器（`tests/probes/lib/probe-mcp-server.mjs`，工具 `probe_whoami`）记录：进程 pid / ppid、ppid 链到 pid 1（每层 `comm` 与 argv[0]）、选定的环境键、每次调用的完整 `params._meta`。服务器只通过命令行 `-c` 覆盖注册，不修改任何用户配置。

五次运行，全部在同一个临时 cwd、同一个 Codex home（`codex` zsh 函数 → `~/.codex-account2`）：

| 运行 | 提示 | `mcp_servers.probe.env` | 目的 |
|---|---|---|---|
| TUI A | 无（只启动，不产生模型调用） | `PROBE_OUT` / `PROBE_OUT_SHARED` | 启动路径 + 配置环境 |
| TUI B | 一次 `probe_whoami` | 同上 | 两个 TUI 是否共享实例 + `_meta`（`turn_trigger=user`） |
| TUI C | 无 | **不配置**（`PROBE_OUT` 只放在 pane 的 shell 环境） | shell 环境是否到达服务器 |
| `codex exec` | 一次 `probe_whoami` | `PROBE_OUT` / `PROBE_OUT_SHARED` | exec 路径 + `_meta`（`turn_trigger=exec`） |
| `codex exec`（spoof） | 一次 `probe_whoami`，参数里伪造 `_meta.sessionId` / `sessionId` | 同上 | 有界伪造检查：模型能否覆盖 `_meta` |

TUI A 先启动并等到服务器 start 记录，再启动 TUI B；三个 TUI 用 `/quit` 退出，脚本用 trap 关闭自己创建的 Herdr tab。模型为 `gpt-6-luna`、effort `low`、`-s danger-full-access -a never`。spoof 运行与普通 exec 使用同一个 `codex` 函数、同一个 home，提示只要求把一段合成的 JSON 原样作为工具参数传入。

## 原始观测（脱敏）

本节所有数字均来自 `tmp/tasks/A3/evidence/codex-mcp-launch/` 中本次保存的运行；更早运行的证据已被本次运行覆盖。

**启动路径（服务器 start 记录，`comm(pid)` 链）**

```
TUI A  pid 281505  ppid 281206  codex(281206) <- zsh(280826) <- herdr(394888)
TUI B  pid 282530  ppid 282190  codex(282190) <- zsh(281782) <- herdr(394888)
exec   pid 285204  ppid 284941  codex(284941) <- zsh(284685) <- timeout(…) <- bash(…) <- pi(…) <- zsh(…) <- herdr(394888)
spoof  pid 286720  ppid 286461  codex(286461) <- zsh(286192) <- timeout(…) <- bash(…) <- pi(…) <- zsh(…) <- herdr(394888)
```

TUI A 与 TUI B 的服务器 pid 不同（281505 ≠ 282530），即同一个 home、同一个 cwd 的两个并发会话各自启动一个实例。TUI A 与 TUI B 的 tab 在 TUI B 调用时都还在（`tabs-tui.json`），TUI A 的 `process-info` 也显示其 codex 进程（281206）在前台。

**daemon 状态（本探针实际运行的配置）**

```
$ cat daemon-liveness.txt
before: codex home .codex-account2 daemon pid 1869484: dead
after:  codex home .codex-account2 daemon pid 1869484: dead
```

进程证据现在只有两项：`daemon-liveness.txt` 按 `~/.codex-account2/app-server-daemon/daemon.pid` 记录的 pid 做存活检查（运行前后都是 dead），`probe_ps` 快照只记录本探针进程树和已记录探针服务器祖先的 pid / ppid / 进程名（`comm`）/ argv[0]，不再记录宿主全量进程或完整命令行。`app-server-ps.txt` 是对这些快照 grep `app-server` 的结果，本次为 0 字节：它只覆盖本探针自己的进程集，不能据此判断宿主上是否存在其他 `app-server`。本探针只检查了它使用的 home（`~/.codex-account2`）；P2 的证据显示 `~/.codex` 的 daemon 同样是 dead。

**环境（服务器 start 记录的 `env` / `envNames`）**

```
TUI A（有 env 表）  env={"PROBE_OUT": "…/tui-a.jsonl", "PROBE_OUT_SHARED": "…/shared.jsonl"}
                    envNames=[HOME, LANG, LOGNAME, PATH, PROBE_OUT, PROBE_OUT_SHARED, SHELL, TERM, USER]
TUI C（无 env 表）  env={}   envNames=[HOME, LANG, LOGNAME, PATH, SHELL, TERM, USER]
TUI C 的 Codex 进程  HUD_LINK=probe-z, PROBE_SHELL_TAG=tui-c, PROBE_OUT=…/tui-c.jsonl,
                    HERDR_ENV=1, HERDR_PANE_ID=w3Q:p49, CODEX_HOME=~/.codex-account2
```

TUI C 的服务器没有拿到 `PROBE_OUT`（`env={}`），但脚本把输出路径作为 `mcp_servers.probe.args` 的第二个参数（argv[2]）传入，服务器按这个绝对路径写 `tui-c.jsonl`；没有默认路径或回退文件。也就是说：Codex 启动 stdio MCP 服务器时使用一个最小环境（`HOME LANG LOGNAME PATH SHELL TERM USER`），再加 `mcp_servers.<name>.env` 表里的键；**不继承** Codex 进程自己的环境。

**每次调用的 `_meta`（`tools/call`）**

```
TUI B  {"callId":"exec-…","x-codex-turn-metadata":{"session_id":"01a1986b-04a8…","thread_id":"01a1986b-04a8…",
        "turn_id":"01a1986b-087f…","reasoning_effort":"low","model":"gpt-6-luna",
        "thread_source":"user","turn_trigger":"user","sandbox_mode":"danger-full-access",
        "codex_version":"0.166.0"},"threadId":"01a1986b-04a8…","sessionId":"01a1986b-04a8…",
        "windowId":"01a1986b-04a8…:0","itemId":"ctc_…","progressToken":1}
exec   {"callId":"exec-…","x-codex-turn-metadata":{"session_id":"01a1986b-5866…","thread_id":"01a1986b-5866…",
        "turn_id":"01a1986b-5d0c…","turn_trigger":"exec","model":"gpt-6-luna",…},
        "threadId":"01a1986b-5866…","sessionId":"01a1986b-5866…","windowId":"01a1986b-5866…:0","itemId":"ctc_…",
        "progressToken":1}
```

`tools/list` 的 `_meta` 只有 `progressToken`；`initialize` 没有会话信息。TUI B 的 pane 输出显示 `Called probe.probe_whoami` 和 `OK`；exec 与 spoof 的 stdout 都有 `mcp: probe/probe_whoami started` / `(completed)` 和 `OK`。

exec 的 stdout 里还有一条与探针无关的 `rmcp` 错误（用户的某个 HTTP MCP 服务器返回 403），探针服务器本身正常启动并完成调用。

**有界伪造检查（spoof `codex exec`）**

提示要求模型把下面这个对象原样作为 `probe_whoami` 的参数传入：

```
{"_meta":{"sessionId":"spoofed-0000","x-codex-turn-metadata":{"session_id":"spoofed-0000"}},"sessionId":"spoofed-0000"}
```

实际到达服务器的 `tools/call`（`spoof-check.json`）：

```
params.arguments = {"_meta":{"sessionId":"spoofed-0000","x-codex-turn-metadata":{"session_id":"spoofed-0000"}},
                    "sessionId":"spoofed-0000"}
params._meta.sessionId                                  = 01a1986b-93b1…
params._meta["x-codex-turn-metadata"].session_id        = 01a1986b-93b1…
rollout id（rollout-…-01a1986b-93b1….jsonl 的 session_meta.payload.id）= 01a1986b-93b1…
```

伪造值**只落在 `params.arguments`**；`params._meta` 里的真实会话 id 仍与 rollout id 一致。Codex 没有按工具的 `inputSchema`（`additionalProperties: false`）在客户端丢弃这些参数，服务器收到了它们，因此这次检查确实覆盖了"模型把伪造值塞进 arguments"的路径。

这是**有界检查**：它只证明这个版本/配置下模型提供的 arguments 没有覆盖 `params._meta`，不证明 harness 的 `_meta` 构造/覆盖规则不可伪造（未来版本、daemon 模式、其他传输都未测）。`_meta` 的可信度因此标为 **bounded check only, harness stamping rules unverified**。

## 结论

| 问题 | 结论 |
|---|---|
| 谁启动 MCP 服务器 | 在**测得的 daemon 缺席配置**下，**TUI 进程和 `codex exec` 进程本身**启动服务器（直接子进程）。daemon 在场时由谁启动**未测量**。 |
| 一个实例服务多个会话？ | 在**测得的 daemon 缺席配置**下，**否**。两个并发 TUI 各有独立实例（pid 不同）。daemon 在场时是否共享实例**未测量**。 |
| 启动 shell 的 env 到达服务器？ | **否**。只有 `mcp_servers.<name>.env` 表里的键到达；Codex 对 stdio MCP 使用最小环境（`HOME LANG LOGNAME PATH SHELL TERM USER`），进程环境（`HUD_LINK`、`HERDR_*`、`CODEX_HOME`）不传递。 |
| 每次调用有会话标识？ | **字段存在**：`params._meta["x-codex-turn-metadata"].session_id` / `thread_id`，以及 `params._meta.sessionId` / `threadId` / `windowId` / `itemId` / `callId`；`turn_trigger` 区分 `user`（TUI）与 `exec`。**可信度未验证**（见 spoof 检查）。 |
| 模型能否覆盖 `_meta`？ | 在**本版本/本配置**下**没有**：伪造值落在 `params.arguments`，`params._meta` 保持真实 id。这是有界检查，不是 provenance 证明。 |

## 对契约的影响

- **契约 01（身份与握手）**：Codex 的 MCP 服务器可以由 ppid 链直接定位到 Codex 进程（TUI 或 exec）——**仅在测得的 daemon 缺席配置下**。真实的字段路径是 `params._meta.sessionId` 与 `params._meta["x-codex-turn-metadata"].session_id`（不是 `_meta.session_id`）。有界伪造检查显示模型提供的 arguments 没有覆盖 `_meta`，但结论只能是 **bounded check only, harness stamping rules unverified**：在拿到版本匹配的 harness stamping / 覆盖证据之前，契约 01 不能把 `_meta` 单独当作授权来源；第一次 `tools/call` 回填 `SessionRef` 时应与 ppid 链 / rollout 交叉核验。**env claim 路径对 Codex 不可用**：`hud-run` 把 `HUD_CLAIM` 放进 Codex 进程环境不会到达 hud-mcp。可用的两条路是（a）prompt 里的 claim，（b）`hud-run` 在 Codex 命令行上用 `-c mcp_servers.hud.env={HUD_CLAIM="…"}` 覆盖（需要保留用户原有的 env 表项）。契约 01 不能把 env claim 写成 Codex 的默认路径。
- **概念 §6.6.3「daemon 代启 MCP 的 Codex」**：本机 0.166 的观测只覆盖 **daemon 缺席**——TUI / exec 直接启动 MCP，daemon 不参与。**daemon 在场的当前版本行为未测量**（不能启动用户 daemon），因此不能说该分支不需要触发；概念 §6.6.3 的**条件支持门继续保留**：若 daemon 代启且没有可信的逐调用会话来源，该路径标为不支持，不用 prompt claim 冒充会话识别。`_meta` 的字段存在不等于可信来源（上一条）。
- **契约 05（能力矩阵）**：Codex MCP 服务器的环境里没有 `CODEX_HOME`，服务器无法从自身环境判断 home；home 必须从 ppid 链上的 Codex 进程环境或 `_meta`/rollout 路径解析（见 P2）。
- **契约 04（运行托管）**：可见/headless 启动模板若需要把 claim 交给 Codex 的 hud-mcp，必须在 argv 上注入 `-c mcp_servers.hud.env=…`，不能只依赖 `hud-run` 的进程环境；这也意味着 `hud-run` 需要知道 hud-mcp 的服务器名并合并用户已有的 env 表。

另见 [daemon 在场补测](codex-daemon.md)（CLI 0.166 + managed app-server 0.163，含 dotted env 与清理限制）。
