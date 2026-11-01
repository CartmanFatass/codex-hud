# 探针 P4：pi `--session` resume 是续写还是新文件

- 日期：2026-11-01
- 版本：pi 1.4.0、Node v24.22.1
- 脚本：`tests/probes/pi-resume.sh`（内部 `timeout 300`）
- 原始证据：`tmp/tasks/A3/evidence/pi-resume/`（git-ignored）

## 方法

在同一个临时 `--session-dir` 下跑四次 headless pi（`pi -p`），模型 `anthropic/claude-haiku-4-5`、`--thinking off`、`--no-tools`，提示都是 "Reply with exactly OK."：

1. `--session-id <uuid>`：指定精确 id，观察是否创建文件、文件名与 id。
2. `--session <id>`：用 id 恢复。
3. `--session <path>`：用文件路径恢复。
4. `--fork <path>`：从该文件 fork。

每次运行后立即快照：目录里的 `.jsonl` 文件名、字节数、行数、首条 `type: session` 记录的 `id` / `cwd` / `version`。同时对比 `~/.pi/agent/sessions` 前后是否变化（确认 `--session-dir` 没有写用户目录）。

## 原始观测（脱敏）

| 步骤 | 文件 | 行数 | `type: session` id |
|---|---|---|---|
| 初始（`--session-id 6a2d8e4d-…`） | `2026-11-01T17-26-56-749Z_6a2d8e4d-….jsonl` | 7 | `6a2d8e4d…`（等于请求的 uuid） |
| `--session 6a2d8e4d-…` | 同一个文件 | 10 | `6a2d8e4d…` |
| `--session <path>` | 同一个文件 | 13 | `6a2d8e4d…` |
| `--fork <path>` | 原文件 + 新文件 `2026-11-01T17-27-03-225Z_01a19826-….jsonl` | 原 13 / 新 16 | 原 `6a2d8e4d…` / 新 `01a19826…` |

初始运行的 stderr：

```
Warning: No project session found with id '6a2d8e4d-…'; creating a new session with that id.
```

四次运行都 `exit=0`，stdout 都是 `OK`。`~/.pi/agent/sessions` 没有新增会话文件（只有父目录 mtime 变化；`--session-dir` 覆盖生效）。fork 的新文件行数（16）大于原文件的 13，说明它复制了原历史并追加了 fork 后的新记录；原文件保持 13 行。

## 结论

| 标志 | 行为 |
|---|---|
| `--session-id <uuid>` | 在该 `--session-dir` 下创建 `2026-11-01T17-26-56-749Z_<uuid>.jsonl`，`type: session` 的 `id` 就是请求的 uuid。 |
| `--session <id>` | **续写同一个 `.jsonl`**（7 → 10 行，id 不变）。 |
| `--session <path>` | **续写同一个 `.jsonl`**（10 → 13 行，id 不变）。 |
| `--fork <path>` | **新建一个 `.jsonl`**，新 id（`01a19826…`），原文件不变；不是续写。 |

## 对契约的影响

- **契约 03（生命周期 / resume）**：pi 的 `--session <id|path>` 是同一 `SessionRef` 的续写，`--fork` 是新 `SessionRef`（分支），不能当作 resume。resume 的允许条件与运行槽可以按"同一文件、同一 id"判断；fork 出来的新会话在 v1 不建关系，只作候选（与概念 §6.6.5 的 fork 规则一致）。
- **契约 05（能力矩阵）**：`delegate.json` 的 pi resume 模板用 `pi --session <id>`（headless 加 `-p`），预期追加到同一文件；不要用 `--fork` 做 resume。`--session-id` 可以用来在启动时固定 id，便于 claim / 账本在会话创建前就写入 `SessionRef`。
- **概念 §7.3**："续写还是新文件，阶段 C 实测后写定"——本探针给出答案：`--session` 续写，`--fork` 新文件。pi 适配器可以把新旧文件归到同一 `SessionRef` 的逻辑只用于 fork 场景（如果将来要支持），resume 不需要。
