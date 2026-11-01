# 探针 P3：Herdr `--env` 的到达范围

- 日期：2026-11-01
- 版本：herdr 0.9.5、codex-cli 0.166.0、pi 1.4.0、Claude Code 2.1.305、Node v24.22.1
- 脚本：`tests/probes/herdr-env.sh`（内部 `timeout 300`）
- 原始证据：`tmp/tasks/A3/evidence/herdr-env/`（git-ignored）

## 方法

在一个 `herdr tab create --workspace w3Q --label probe:p3-tab --no-focus --cwd <临时 cwd> --env HUD_HOME=<临时 HUD_HOME> --env PROBE_ENV_TAG=probe-tab-env --env HUD_LINK=probe-env-tab` 创建的 tab 里（`HUD_HOME` 由 `probe_tab_create` 自动注入，指向本次运行的临时目录）：

1. 在 pane 的 shell 里执行 `env | grep -E '^(PROBE_ENV_TAG|HUD_LINK)='`，写入 `shell-env.txt`。
2. 用 `herdr pane run` 启动一个**无提示**的 Codex TUI（不产生模型调用），用 `-c` 注册探针 MCP 服务器；等服务器 start 记录后，读取 Codex 进程的 `/proc/<pid>/environ` 和服务器自己的环境记录。
3. 用 `herdr pane split --direction down --no-focus --env PROBE_ENV_TAG=probe-split-env --env HUD_LINK=probe-env-split --env HUD_HOME=<临时 HUD_HOME> --env PROBE_OUT=…` 开一个 split，先在 split 的 shell 里做同样的检查。
4. 用 `herdr agent start probe-pi-env --kind pi --pane <split> -- pi --mcp-config … --session-dir <tmp> …` 启动 pi（无提示，不产生模型调用）；等探针服务器 start 记录后，读取 pi 进程环境和服务器环境。

pi 的 MCP 配置只写 `command` / `args`，不写 `env`，这样服务器继承 pi 的环境；配置文件放在临时目录。`args` 里带一个每次运行不同的值，用来绕过 pi MCP 适配器的元数据缓存（缓存命中时它会延迟连接，见文末）。

所有合成环境值都带 `probe-` 前缀（`probe-tab-env` / `probe-split-env`）；探针服务器的环境记录只保留这种哨兵值或它自己的输出路径，其余值（`HERDR_*`、临时 `HUD_HOME`）记为 `<redacted>`。`HUD_HOME` 由 `probe_begin` 在本次运行的临时工作目录下创建并导出，`probe_tab_create` 和 `pane split` 都通过 `--env` 注入，避免 harness 读到用户的 `~/.hud`。

## 原始观测（脱敏）

本节所有数字均来自 `tmp/tasks/A3/evidence/herdr-env/` 中当前保存的运行。

**（a）pane 的 shell**

```
tab 根 pane：  HUD_LINK=probe-env-tab   PROBE_ENV_TAG=probe-tab-env
split pane：   HUD_LINK=probe-env-split PROBE_ENV_TAG=probe-split-env
```

**（b）agent 进程**

```
Codex 进程（pane run）：PROBE_ENV_TAG=probe-tab-env HUD_LINK=probe-env-tab HUD_HOME=…/hud-home
                        HERDR_ENV=1 HERDR_PANE_ID=w3Q:p41 CODEX_HOME=~/.codex-account2
pi 进程（agent start）：PROBE_ENV_TAG=probe-split-env HUD_LINK=probe-env-split HUD_HOME=…/hud-home
                        PROBE_OUT=…/pi.jsonl HERDR_ENV=1 HERDR_PANE_ID=w3Q:p42
```

`herdr agent start` 本身没有 `--env` 参数；pi 拿到的是 split pane 的环境。

**（c）agent 的 MCP 服务器**

```
Codex 的探针服务器（pid 257368，ppid 257049）：
  env={"PROBE_OUT":"…/codex.jsonl"}
  chain: codex(257049) <- zsh(256645) <- herdr(394888)
  → PROBE_ENV_TAG / HUD_LINK / HERDR_* 都没有到达

pi 的探针服务器（pid 258166，ppid 258098）：
  env={"HERDR_PANE_ID":"<redacted>","HERDR_TAB_ID":"<redacted>","HERDR_WORKSPACE_ID":"<redacted>",
       "HERDR_BIN_PATH":"<redacted>","PROBE_OUT":"…/pi.jsonl","HUD_HOME":"<redacted>",
       "HERDR_SOCKET_PATH":"<redacted>","HUD_LINK":"probe-env-split","HERDR_ENV":"<redacted>",
       "PROBE_ENV_TAG":"probe-split-env"}
  chain: pi(258098) <- zsh(257726) <- herdr(394888)
  → 键全部到达；非 `probe-` 哨兵值（`HERDR_*`、`HUD_HOME`）在证据里记为 `<redacted>`，
    只有 `HUD_LINK` / `PROBE_ENV_TAG` 的哨兵值和服务器自己的输出路径保留原值
```

## 结论

| 目标 | `tab create --env` | `pane split --env` |
|---|---|---|
| （a）pane 的 shell | 到达 | 到达 |
| （b）Codex（`pane run`）进程 | 到达 | 未测量（推断） |
| （b）pi（`agent start`）进程 | 未测量（推断） | 到达（split 的值） |
| （c）Codex 的 MCP 服务器 | **不到达**（Codex 清空 stdio MCP 的环境，P1） | 未测量（推断；按 Codex 的行为推断为不到达） |
| （c）pi 的 MCP 服务器 | 未测量（推断；按 pi 的行为推断为到达） | 到达 |

脚本只在 tab 根 pane 测了 Codex（`pane run`）、只在 split pane 测了 pi（`agent start`）；交叉组合（Codex/split、pi/tab 根）没有对应的 agent 调用或服务器 start 记录，表中标为**未测量（推断）**。两个 pane 路径的 shell 投递都测到了，但 shell 投递成功不能替代 agent/MCP 的观测。

Herdr 的 `--env` 只负责把值交给 pane 的 shell；之后是否继续传递取决于 agent 自己。在测得的组合里，Codex 不把进程环境传给 stdio MCP 服务器，pi 会传。

**实用注意**：pi 的 MCP 适配器会缓存服务器元数据（`~/.pi/agent/mcp-cache.json`）。当服务器名与配置哈希都命中缓存时，它可能把连接推迟到第一次工具调用；探针脚本在 `args` 里加一个每次运行不同的值，使配置哈希变化、连接在启动时发生。这个缓存文件是 pi 自己写的，脚本不修改它。

## 对契约的影响

- **契约 04（运行托管）/ 契约 05（能力矩阵）**：在**测得的组合**（tab 根 Codex、split pi）下，Herdr `--env` 可以把 `HUD_LINK` / `HUD_RUN` 交给 pane 的 shell 和 agent 进程，但不能保证到达 Codex 的 hud-mcp。可见模式的 Codex 启动仍然需要 prompt claim 或 `-c mcp_servers.hud.env=…` 覆盖（P1）；pi 的 env claim 路径可用。交叉组合未测量，契约不能把 Codex/split 或 pi/tab 根写成已验证的能力。
- **契约 01（env claim 路径）**：按 harness 分开写，且只写测得的组合：cc 可用（P5：服务器继承完整环境）、pi 在 split pane 可用（本探针）、Codex 在 tab 根 pane 不可用（本探针 + P1）。契约不能写一条"`hud-run` 注入环境变量，子侧自动握手"的通用规则，也不能把未测的交叉组合当作已验证。
- **契约 04 的可见模式**：`herdr agent start` 没有 `--env`，只能靠 pane 的环境；如果 hud-run 需要给 pi 传 claim，应该在 `pane split --env` / `tab create --env` 时注入，而不是在 `agent start` 之后（pi 只在 split pane 测过，tab 根的组合未测量）。
