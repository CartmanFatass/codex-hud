# 探针 P5：Claude Code 的 MCP 服务器环境与父进程

- 日期：2026-11-01
- 版本：Claude Code 2.1.305、Node v24.22.1
- 脚本：`tests/probes/cc-mcp-env.sh`（内部 `timeout 300`）
- 原始证据：`tmp/tasks/A3/evidence/cc-mcp-env/`（git-ignored）

## 方法

用临时 JSON 配置（`{"mcpServers":{"probe":{"command":"node","args":[…],"env":{"PROBE_OUT":…,"PROBE_OUT_SHARED":…}}}}`）注册探针 MCP 服务器，运行一次：

```
claude -p --mcp-config <tmp.json> --strict-mcp-config --model haiku --effort low \
  --allowedTools mcp__probe__probe_whoami --output-format json \
  "Call the probe_whoami tool exactly once, then reply OK."
```

shell 环境额外放 `PROBE_SHELL_TAG=cc-shell` 和 `HUD_LINK=probe-cc`。`claude` 在后台运行；探针服务器 start 记录出现后，趁 `claude` 还活着读取父进程的 `/proc/<pid>/stat`、`/proc/<pid>/environ`，并复制 `~/.claude/sessions/<ppid>.json`；等 `claude` 退出后再读 `tools/call` 的 `_meta`。

## 原始观测（脱敏）

**父进程链**

```
探针服务器 pid 71415  ppid 71335
chain: claude(71335) <- timeout(71333) <- bash(71041) <- … <- pi(4120719) <- zsh(4119956) <- herdr(394888)
```

父进程就是 `claude` 本身（`ps` 里 `claude -p --mcp-config …`），不是 daemon 或 wrapper。

**服务器环境（`envNames`，只列名字）**

```
AI_AGENT, CLAUDECODE, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, CLAUDE_CODE_ENTRYPOINT,
CLAUDE_CODE_MAX_CONTEXT_TOKENS, CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN,
CLAUDE_CODE_SESSION_ID, CLAUDE_PROJECT_DIR, COLORTERM, …, HERDR_BIN_PATH, HERDR_ENV,
HERDR_PANE_ID, HERDR_SOCKET_PATH, HERDR_TAB_ID, HERDR_WORKSPACE_ID, HOME, …, HUD_LINK,
…, PI_CODING_AGENT, …, PROBE_OUT, PROBE_OUT_SHARED, PROBE_SHELL_TAG, …, TERM, USER, …
```

`CLAUDE*` 键名（值一律不记录）：`CLAUDECODE`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_PROJECT_DIR`。

与 Codex 不同，Claude Code **不清空**环境：服务器同时拿到父进程的 `HUD_LINK=probe-cc`、`PROBE_SHELL_TAG=cc-shell`、`HERDR_*`，以及 Claude 自己加的 `CLAUDE_*`。

**`~/.claude/sessions/<ppid>.json`（运行中复制）**

```
{"pid":71335,"sessionId":"ab0a3ea6…","cwd":"~/projects/MyHUD","procStart":"16217704",
 "kind":"interactive","entrypoint":"sdk-cli","pidDomain":"linux:…:pid:[…]"}
```

`/proc/71335/stat` 的 starttime（第 22 字段）= `16217704`，与 `procStart` 一致；`pid` 与父进程一致；`sessionId` 与 `claude -p --output-format json` 的 `session_id` 一致（`ab0a3ea6…`）。父进程自己的 `/proc/<pid>/environ` 有 `PROBE_SHELL_TAG` / `HUD_LINK`，但没有 `CLAUDE*` 键——这些是 Claude 只给子进程加的。

**每次调用的 `_meta`**

```
{"claudecode/toolUseId":"toolu_01Vj8n6ps57iA12skj4bXfR3","progressToken":2}
```

没有 session id。`claude -p` 的输出：`{"type":"result","session_id":"ab0a3ea6…","subtype":"success","is_error":false,"result":"OK","num_turns":3,"duration_ms":5346}`。

## 结论

| 问题 | 结论 |
|---|---|
| 服务器父进程 | **`claude` 本身**（直接子进程）。 |
| 服务器看到哪些环境键 | 完整继承的环境 + Claude 加的 `CLAUDE_*`（含 `CLAUDE_CODE_SESSION_ID`）；`CLAUDE*` 只记录名字。 |
| `~/.claude/sessions/<ppid>.json` 存在且匹配？ | **是**。`pid` 与父进程一致，`procStart` 与 `/proc/<pid>/stat` 的 starttime 一致，`sessionId` 与 `claude -p` 输出一致。 |
| `_meta` 有 session id？ | **否**。只有 `claudecode/toolUseId` 和 `progressToken`。 |

## 对契约的影响

- **契约 01（身份与握手）**：cc 的 caller 登记可以走 ppid → `~/.claude/sessions/<ppid>.json` → `sessionId`，并用 `procStart` 校验（本探针确认匹配）。服务器环境里的 `CLAUDE_CODE_SESSION_ID` 是第二条交叉核验来源；`_meta` 不能作为 cc 的会话来源（只有 toolUseId）。env claim 路径对 cc **可用**：服务器继承完整环境，`HUD_LINK` / `HUD_CLAIM` 能到达。
- **契约 05（能力矩阵）**：cc 的 MCP 服务器父进程就是 `claude`，不需要 daemon 绑定；`~/.claude/sessions/<pid>.json` 的 `pid` / `procStart` 是可信的本地证据。注意 `pidDomain` 字段（多个 PID 域），跨 PID 域时"本地看不见"不等于已退出——契约 01 的失效规则要保留这一点。
- **概念 §6.6.3**："本机已验证 cc 的 MCP 服务器父进程是 `claude` 本身"在本版本仍然成立；补充的是 `procStart` 匹配与 `CLAUDE_CODE_SESSION_ID` 环境键，以及 `_meta` 不含 session id 这一反例。
