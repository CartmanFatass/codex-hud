# 13. 只读的 `hud doctor <jobId>`：一屏看清一个作业的磁盘事实

> **优先级**：P3（排障便利，Owner 挑选后才排期） ｜ **类别**：CLI / 作业诊断 ｜ **预估规模**：S（1 个垂直切片：新增 `src/cli/doctor.ts` ~120–160 行，`hud-main.ts` +2 行，测试 ~100 行，中英 reference 各 ~8 行） ｜ **前置依赖**：无代码前置，零新依赖。文件冲突低：`src/cli/hud-main.ts` 不在任何在途 lane 的改动清单里。只读复用的 `src/roles/cli-turn.ts`、`src/collectors/thin-jobs.ts`、`src/roles/job-checks.ts` 会被 **PRIMITIVES**（方案 05）、**MCP-SPLIT**（方案 02）、方案 08（job index 缓存）改动或搬家，`STATUS.json` 的写入方 `packages/hud-mcp/bin/hud-cli.mjs` 会被 **ASYNC-WATCH**（方案 06）和 **MCP-SPLIT** 改写。所以 doctor 只调用导出函数，并且**原样打印未知字段**，不硬编码字段全集。建议排在 MCP-SPLIT-03 之后，或落地后随这些 lane 一起跑测试 ｜ **`docs/spec.md` 边界影响**：无新边界，但要注意 `docs/spec.md:170-171` 的 Owner 决定（2026-11-11）：面板「delete Timeline, the Activity hub, Summary and the diagnostics pages」。本方案是命令行、按需、只读的，不在面板里加诊断页。它复用 `docs/spec.md:13` 规定的「the panel and the MCP derive a job's state through one shared reader」，不另立一套状态判断。不在 M5 候选里，**由 Owner 决定是否要**

---

## 1. 背景与现状证据

### 1.1 一个作业的事实分散在 10 多个文件里
`$HUD_HOME/jobs/<jobId>/` 下：

| 文件 | 写入方 / 读取方 | 内容 |
|---|---|---|
| `job.json` | MCP 派发；`hud-cli.mjs:150` 读 | 角色、位置、`attempts`、`read_at`、`send_outcomes`、checks 定义 |
| `STATUS.json` | supervisor `write()`，`packages/hud-mcp/bin/hud-cli.mjs:172-190` | `state`、`blocked`、`reason`、`output_written`、`settled_at`、`idle_deadline_at`、`exit_reason`、`quiet_decision`、pid 等 |
| `turn.json` | `src/roles/cli-turn.ts:27-34` `readTurn` | `seq`、`sent_at`、轮次开始时的 `report_sig` |
| `done.json` | `cli-turn.ts:36`、`:43-50` `readDone`；匹配规则见 `:38-40` `receiptForTurn` | 完成回执 |
| `report.md` | `cli-turn.ts:15-25` `reportSignature` | 报告与签名 |
| `qa/q<n>.md`、`q<n>.answer.md` | `src/collectors/thin-jobs.ts`（`openQuestionIds`） | 未答问题 |
| `checks.json` | `src/roles/job-checks.ts:7`、`:54` `readCheckReceipt`、`:63` `jobChecks` | 检查结果及其绑定的报告签名 |
| `progress.jsonl` | `thin-jobs.ts` `readJobProgress` | 最近的里程碑 |
| `supervisor.pid` | `src/mcp/thin-main.ts:596-618` | supervisor 进程号 |
| `STATUS.json.stop-requested` / `.close-requested` | `hud-cli.mjs:156-157` | 停止 / 关闭意图 |
| `worker-tree.json`、`mcp-task.json`、`.sonic/` | `src/roles/worker-tree.ts:54`、`thin-main.ts:1880` | 进程树快照、MCP task 标记、sonic 子任务 |

### 1.2 现有入口看不到这些「为什么」
- `src/cli/hud-main.ts:12-47`：子命令有 statusline、panel、codex、trust、setup、tickets、watch、board，**没有诊断命令**。
- `hud_read` 和面板 Inspector 只给出 `state` 与 `reason`。supervisor 每次判定用的 `Facts`（`src/mcp/cli-judge.ts:163-184`，在 `hud-cli.mjs:147-170` 中收集）只在内存里，不落盘。
- 回答「为什么还没 settle」「为什么没有通知」时，主会话今天要手动读 4–6 个文件，再自己比对 `turn.json`、`done.json` 和 `report.md` 的签名。

### 1.3 必须避开的写操作
`src/mcp/thin-main.ts:760-781` 的 `readRow()` 在作业失败时会调用 `recordFailureExhaustion`，**改写 `STATUS.json`**，所以 doctor 不能用它。应直接用纯函数 `jobRow()`（`src/collectors/thin-jobs.ts:197`），这正是面板与 MCP 共用的读取器。

---

## 2. 目标与非目标

### 目标
1. `hud doctor <jobId>`：校验 id 格式（`/^j[0-9a-f]{16}$/`，同 `packages/hud-mcp/bin/worker-tools.mjs:11`），用 `privateHome()`（`src/cli/private-home.ts:14`）定位 `$HUD_HOME/jobs/<id>`，然后**只读**打印：
   - 身份：`job.json` 的角色、harness、位置或模型、项目、worktree、`attempts` 和 `used_place`；
   - 共享读取器的结论：`jobRow()` 的 `display_state`、`state`、`reason`、`blocked`、`report_unread`、`question_ids`、`checks`；
   - 原始状态：`STATUS.json` 全部字段（未知字段原样列出）；
   - 轮次与回执（仅 CLI 作业）：`turn.json` 的 seq 和 sent_at，`done.json` 是否属于本轮（`receiptForTurn`），回执签名是否等于磁盘上当前的 `reportSignature`，报告是否比轮次开始时新；
   - 未答问题、检查结果是否绑定当前报告、最近一条 progress、stop/close 标记、supervisor 与 worker 进程号及其存活状态。
2. 末尾给出「提示」段：只基于上面这些字段的**直接比较**，每条引用具体字段，比如 “done.json is for turn 3 but report.md changed after it: no valid receipt”。不复制 `judge()` 的状态机。
3. 文件缺失、JSON 损坏、超出大小上限时，显示 `missing` / `unreadable`，不报错退出（遵守 `docs/ARCHITECTURE.md:436`）。

### 非目标
- 不做整条链路的体检（Node 版本、dist 新旧、herdr socket、trust、僵尸 tab、API key 有效性等）。
- **不发任何网络或 API 请求**，也不连接 herdr socket。
- **不新增任何落盘事实**：不持久化 `Facts`，不写任何文件，不改 `STATUS.json`。
- 不加 MCP 工具，不加面板页面，不自动修复，不给出「建议执行的命令」。

---

## 3. 核心设计方案

### 3.1 结构
- `src/cli/doctor.ts`：
  - `collectDoctor(dir): DoctorReport`：纯读取，返回结构化对象，便于测试；
  - `formatDoctor(report): string`：纯格式化，固定英文、无颜色，和其他 CLI 输出一致；
  - `doctorCommand(args, io)`：参数解析与输出。
- `src/cli/hud-main.ts`：加一行 `if (args[0] === 'doctor') return await doctorCommand(args.slice(1), io);`，并在 help 和 `invalid_command` 列表里补上 `doctor`。
- 读取一律复用已有导出：`readTurn`、`readDone`、`receiptForTurn`、`turnToken`、`reportSignature`（`cli-turn.ts`），`jobRow`、`readJobProgress`（`thin-jobs.ts`），`readCheckReceipt`、`jobChecks`（`job-checks.ts`），`workerAlive`（`src/mcp/cli-judge.ts:39`，只读 `/proc`）。
- 单个文件读取设上限（例如 64 KiB），`report.md` 只算签名，不打印正文。

### 3.2 输出示例（合成数据）
```
job        j0000000000000001  role imp  harness claude  place synthetic/model (high)
project    /tmp/synthetic-project   worktree  none
shared     display working · state working · reason — · blocked no · unread report no
turn       seq 3 · sent 2026-01-01T10:02:11Z · by hud
report     present · changed since turn start yes
receipt    done.json turn 3 yes · matches report on disk no
questions  open q2
checks     2 bound · result for current report none
processes  supervisor 41200 alive · worker 41203 alive
markers    stop-requested no · close-requested no
progress   10:05 running synthetic tests
status     {raw STATUS.json fields, one per line}
notes
  - report.md changed after done.json was written: the receipt no longer matches, so the turn is not declared.
  - q2 is unanswered: the job waits for the orchestrator.
```

### 3.3 不同作业类型
- pi 作业没有 turn 和 done：这两行显示 `n/a (pi settles natively)`。
- browser（`bro`/`jev`）作业：只显示身份、共享结论、原始状态、问题和报告。

---

## 4. 垂直切片与实施路线

### Slice 1：`hud doctor <jobId>`（单个 imp 会话）
- **依赖**：无。推荐在 MCP-SPLIT-03 之后，届时 `hud-cli.mjs` 已经迁到 TS，字段来源更稳定；提前做也可以，因为只依赖导出函数。
- **改动文件**：
  1. 新增 `src/cli/doctor.ts`（~120–160 行）。
  2. `src/cli/hud-main.ts`（+2 行，help 加 1 行）。
  3. 新增 `tests/unit/hud-doctor.test.mjs`（~100 行）。
  4. `docs/reference.md`、`docs/reference.zh.md` 的命令一节各加一段。
- **完成标准**：§5.1 全绿；对一个真实作业目录运行前后，目录内所有文件的 mtime 和内容不变；`npm test` 全绿。

---

## 5. 验证与验收方案

### 5.1 单测（用 `tests/fixtures/hud-home.ts` 的临时 HUD home，见 `docs/testing.md:183`；全部为合成作业目录）

| # | 场景 | 断言 |
|---|---|---|
| 1 | 只读保证：完整合成 CLI 作业，全部文件齐全 | 运行前后目录树的 mtime、大小、内容完全一致；不新增任何文件 |
| 2 | `STATUS.json` 为 `failed`，`job.json` 未设 `exhaustion_marked` | `STATUS.json` 不被改写（防止误用 `readRow`） |
| 3 | 报告在 done.json 之后被改写 | `receipt … matches report on disk no`，提示里有对应一行 |
| 4 | done.json 属于上一轮 | `done.json turn 2 (current 3)`，判断为不属于本轮 |
| 5 | 有未答问题 `qa/q2.md` | `questions open q2` |
| 6 | `STATUS.json` 损坏或缺失 | 显示 `unreadable` / `missing`，退出码 0，其余部分照常 |
| 7 | 非法 id 或目录不存在 | 退出码非零，错误码风格与其他子命令一致（`CliError`） |
| 8 | pi 作业、bro 作业 | turn 和 done 显示 `n/a`，不报错 |
| 9 | `STATUS.json` 有未知新字段 | 原样出现在 `status` 段 |
| 10 | 不访问网络 | 在没有 HERDR_* 和凭据环境变量的 env 下运行成功 |

### 5.2 Owner 试用清单
- [ ] 派一个 sonic，运行中执行 `hud doctor <id>`：显示 working、当前轮次和最新进度。
- [ ] 它结束后再执行：回执与报告匹配，状态为 settled 或 closed。
- [ ] 对一个卡住或等待中的作业执行：「提示」段能直接说出原因（未答问题、回执失效、报告未更新等）。
- [ ] 执行后在面板和 `hud_read` 里看同一作业：状态没有任何变化。

---

## 6. 需要 Owner 拍板的开放问题

| # | 问题 | 推荐默认 |
|---|---|---|
| 1 | 要不要 `--json` 输出给主会话或脚本用？ | 要，直接序列化 `collectDoctor()` 的结果，约 5 行 |
| 2 | 进程存活检查（读 `/proc`）算不算「磁盘上的事实」？ | 算，只调用现有的 `workerAlive`，不连接 herdr，不发信号 |
| 3 | 不带 id 运行 `hud doctor` 时做什么？ | 打印用法并退出 2，不做整条链路体检 |
| 4 | 以后要不要通过 MCP（例如 `hud_read` 的 `detail`）暴露？ | 暂不。先看 CLI 是否真的常用 |
