# 探针 P2：两个 Codex home、同一个 cwd

- 日期：2026-11-01
- 版本：codex-cli 0.166.0、Claude Code 2.1.305、pi 1.4.0、herdr 0.9.5、Node v24.22.1
- 脚本：`tests/probes/codex-dual-home.sh`（内部 `timeout 300`）
- 原始证据：`tmp/tasks/A3/evidence/codex-dual-home/`（git-ignored）

## 方法

在同一个临时 cwd 里各跑一次 `codex exec`：

- home A：zsh 函数 `codex` → `CODEX_HOME=~/.codex-account2`
- home B：zsh 函数 `codex2` → `CODEX_HOME=~/.codex`

两次都用探针 MCP 服务器（`-c mcp_servers.probe.env` 只放 `PROBE_OUT`），提示为一次 `probe_whoami`；模型 `gpt-6-luna`、effort `low`。随后每个 home 再启动一个**无提示**的 TUI（不产生模型调用），用来观察 TUI 进程环境与 `logs_2.sqlite`。脚本按 marker 时间收集两个 home 的新 rollout、`logs_2.sqlite` 行、daemon 状态和 MCP 服务器进程，并用探针 id 做跨 home 命中检查。

## 原始观测（脱敏）

**rollout（同一个 cwd，两个 home）**

```
home A  ~/.codex-account2/sessions/2026/11/01/rollout-2026-11-01T09-25-43-01a19825-4a16….jsonl
        {"type":"session_meta","id":"01a19825-4a16…","cwd":"/tmp/a3-codex-dual-home.RTWpEO/cwd",
         "source":"exec","thread_source":"user"}
home B  ~/.codex/sessions/2026/11/01/rollout-2026-11-01T09-26-01-01a19825-863b….jsonl
        {"type":"session_meta","id":"01a19825-863b…","cwd":"/tmp/a3-codex-dual-home.RTWpEO/cwd",
         "source":"exec","thread_source":"user"}
```

两个 session id 不同（`01a19825-4a16…` 与 `01a19825-863b…`），cwd 相同。

**MCP 服务器与父进程**

```
home A exec  pid 64021  ppid 63748  codex(63748) <- zsh(…) <- timeout(…) <- … <- pi(…) <- herdr(394888)
home B exec  pid 65184  ppid 64915  codex(64915) <- zsh(…) <- timeout(…) <- … <- pi(…) <- herdr(394888)
home A TUI   pid 66323  ppid 66045  codex(66045) <- zsh(…) <- herdr(394888)
home B TUI   pid 67308  ppid 67087  codex(67087) <- zsh(…) <- herdr(394888)
```

每个 home 的服务器都是各自 Codex 进程的子进程，pid 互不相同。exec 进程环境确认了 home：

```
home A  CODEX_HOME=~/.codex-account2  HUD_LINK=probe-codex
home B  CODEX_HOME=~/.codex           HUD_LINK=probe-codex2
```

**daemon**

```
~/.codex-account2/app-server-daemon/daemon.pid → pid 1869484: dead
~/.codex/app-server-daemon/daemon.pid          → pid 1909540: dead
```

`ps` 里没有这两个 home 的 `app-server` 进程。daemon 状态目录、`sessions/`、`hud/` 都是按 home 分开的。

**`logs_2.sqlite`（marker 之后的行）**

```
home A  285 行，process_uuid 只有 pid:4117900:…（用户正在运行的另一个 TUI）；
        探针 id 命中：session A 0、session B 0、pid:66045: 0、pid:67087: 0
home B  0 行；探针 id 命中全部 0
文件：~/.codex-account2/logs_2.sqlite（78 MB）与 ~/.codex/logs_2.sqlite（101 MB）是两个独立文件
```

在**这次测量的配置**（两个 daemon 都 dead、两个探针 TUI 都无提示、exec 各一次）下，这些调用在 `logs_2.sqlite` 里**没有观察到行**；home A 的 285 行全部来自另一个已经在运行的用户 TUI（`pid:4117900:…`），home B 为 0 行。这次观测不能区分“活动依赖的写行”和“daemon/配置依赖的写行”，因此**活跃-vs-空闲的写行规则未验证**。两个 home 的库互不包含对方的 pid / thread id。

## 结论

| 问题 | 结论 |
|---|---|
| rollout 分开？ | **是**。各自在 `$CODEX_HOME/sessions/` 下，session id 不同，cwd 相同。 |
| daemon 分开？ | **是**（按 home 的 `app-server-daemon` 目录与 pid 文件）；本机两个 daemon 都没在运行。 |
| MCP 服务器分开？ | **是**。每个 home 的 Codex 进程各自启动实例。 |
| `logs_2.sqlite` 分开？ | **是**，两个独立文件；在本次配置下 `codex exec` 和空闲 TUI 的调用**没有观察到行**（活跃-vs-空闲规则未验证）。 |
| 只按 cwd 会不会把 A 认成 B？ | **会**。两个 rollout 的 `cwd` 完全相同，只有 id 与所在 home 不同；任何只存 cwd 的键都会混淆。按 session id 查是安全的，但 id 本身不说明去哪个 home 读文件。 |

## 对契约的影响

- **契约 01 / 契约 05**：Codex 的 `SessionRef` 必须带 home（或一个 home 作用域的键：`CODEX_HOME` + session id），不能只有 cwd 或只有 id。home 可以从 pane 进程的 `CODEX_HOME` 环境或 rollout 路径解析；MCP 服务器自身环境里没有 `CODEX_HOME`（P1），所以 hud-mcp 不能从自己的环境推断 home，必须从 ppid 链上的 Codex 进程或 `_meta`/rollout 路径取。
- **契约 01 的注册表路径**：在本次测量配置下，`logs_2.sqlite` 对 headless `codex exec` 和空闲 TUI **没有观察到行**。这不足以证明它不能作为注册表，也不足以确立"只有活跃 TUI 写行"的规则（活跃-vs-空闲规则未验证，daemon 在场 / 受控活跃 TUI 的对照未做）。契约不能据此把 daemon/日志绑定限制为"只覆盖活跃 TUI"；headless 运行需要 `_meta`/claim + rollout 绑定作为独立路径，不能只等注册表。
- **契约 02（执行协议）**：后端档案必须把 home 写进启动模板（`codex` vs `codex2`，或显式 `CODEX_HOME`），resume 模板也必须使用同一个 home；否则同一 cwd 下会把 A 的会话当成 B 的。
- **概念 §6.6.3「Codex 用 pane → 现有 daemon 绑定」**：本次测量没有覆盖 daemon 在场或受控活跃 TUI 的日志写入，因此该路径的适用条件**未验证**；headless exec 需要另一条绑定路径，契约不能把它写成唯一来源，也不能把"只覆盖活跃 TUI"写成已证结论。
