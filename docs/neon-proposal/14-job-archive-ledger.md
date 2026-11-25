# 14. 删除已结束任务目录前追加一行事实归档（`$HUD_HOME/archive/YYYY-MM.jsonl`）

> **优先级**：P3（被动记录，不改变任何现有行为） ｜ **类别**：状态卫生 / 被动记录 ｜ **预估规模**：S（1 个垂直切片，源码 ~80 行 + 测试 ~140 行 + 文档 ~10 行） ｜ **前置依赖**：无硬依赖；与 **ASYNC-WATCH（方案 06）** 存在文本冲突风险（06 重写 `scan()` 并改动同一删除分支），**建议在 06 落地之后实施**，届时只需在新的删除点加一行调用；与方案 02（bin 迁 TS）、08（共享 mtime 缓存）同理，归档逻辑放在独立 TS 模块中，调用点只有一行，随任何重写平移 ｜ **`docs/spec.md` 边界影响**：小幅新增一行事实性规格（新状态文件，仅记录、无读取方）；不改变保留期（JOB-RETENTION 仍为“关闭一天后删除”），保留期调整仍属 M5 候选（`docs/spec.md:197`）；按 spec 规则，由 owner 同意后再写入 spec

---

## 1. 背景与现状证据

### 1.1 删除点

- `packages/hud-mcp/bin/hud-watch.mjs:301-307`：`expires = ended + 86400000`；过期且（无 tab 或已 `reaped_at`）时，若为 pi 任务先经 `preserveSessions(dir)`（`:153`、`:305`）把会话迁入 pi 自有存储，失败则保留目录；随后 `fs.rmSync(dir, { recursive: true, force: true })`（`:306`）并 `log('delete …')`（`:307`）。
- 路径说明：`hud-watch.mjs` 目前仍在 `packages/hud-mcp/bin/`，而原 `packages/hud-mcp/src/*.ts` 已于 f9de5b72 移至 `src/mcp/*.ts`，编译到 `dist/`；watcher 通过 `../../../dist/...` 引入共享模块（`hud-watch.mjs:10-15`，其中 `:14` 已引入 `dist/roles/job-checks.js`）。
- 这是 owner 已接受的 JOB-RETENTION（`docs/handoff/STATE.md:131`），文档见 `docs/ARCHITECTURE.md:405-407`、`docs/reference.md:298-301`、`docs/reference.zh.md:188`。

### 1.2 删除时丢失了什么

| 内容 | 现状 | 删除后 |
|---|---|---|
| pi 会话 | 链接到 pi 自有存储 | 保留 |
| CLI / 浏览器会话 | 在各 CLI 自有存储 | 保留 |
| pi worker 运行事实 | pi-roles 的 `extensions/ledger.ts` 追加到 `~/.local/share/pi-roles/runs.jsonl`（role、model、state、时间、tps 等） | 保留（仅 pi） |
| CLI / 浏览器任务事实：role、place、preset、启动尝试、失败原因、时间、checks | 只在 `job.json` / `STATUS.json` / `checks.json` | **全部丢失** |
| brief.md、report.md、qa/ | 只在任务目录 | 丢失（本方案默认不保留，见 §6） |

可用事实的来源（均已在磁盘上，无需新采集）：

- `job.json`：`Job` 接口 `src/mcp/thin-main.ts:63-100`；`project_root`（`:68`）、`preset`（`:72`）、`checks`（`:75`）、`repair_of`（`:76`）、`model`/`thinking`（`:79-80`）、`attempts: {index, place, reason?}[]`（`:62`、`:97`）、`used_place`（`:98`）、`dispatch_exit_code`/`dispatch_code`；写入点 `:1288-1305`。
- `STATUS.json`：`hud-cli.mjs:37-47`（`agent`、`role`、`model`、`thinking`、`state`、`started_at`、`settled_at`、`ended_at`、`exit_reason`）。
- checks：`src/roles/job-checks.ts:63` `jobChecks(dir, job)` 返回 `CheckSummary`（`passed`、`total`、`stale`，`:15-17`）。
- 结果标签（仅当面板已经算过）：`src/collectors/decision-labels.ts:59,85`，缓存位于 `$HUD_HOME/display/model-cache/decision-labels/<sha256("thin-job:<id>:outcome")>.json`（目录见 `src/tree-page.ts:370`）。

---

## 2. 目标与非目标

### 目标

1. 在 `hud-watch` 删除已结束任务目录**之前**，向 `$HUD_HOME/archive/YYYY-MM.jsonl` 追加**一行**该任务的事实记录（约 0.5–1 KB）。
2. 只记录已在磁盘上的事实，不调用模型、不新增进程、不增加扫描。
3. 尽力而为：归档失败只记一行 `watch.log`，**不阻塞、不推迟删除**，也不改变任何任务状态。
4. 私有：目录 `0700`，文件 `0600`（`docs/ARCHITECTURE.md:445`）。

### 非目标

1. 不做 `hud history` 搜索、跨周检索。
2. 不做指标看板、按 role/model 的效率统计，也不把数据反馈给 Control 的默认链或 preset。
3. 不改保留期，不改删除条件；保留期仍是 M5 候选，由 owner 先看删除清单（`docs/spec.md:197`）。
4. 默认不复制 report/brief/qa 文本，也不记录面板标题。
5. 不为已删除的历史任务补录；现存目录在各自到期删除时自然归档。
6. 不替代 pi-roles 的 `runs.jsonl`。

---

## 3. 核心设计方案

### 3.1 位置

新模块 `src/roles/job-archive.ts`，导出 `archiveJob(home, dir, id, job, status, now)`，编译为 `dist/roles/job-archive.js`。`hud-watch.mjs` 只在 `:305`（`preserveSessions` 判断）与 `:306`（`rmSync`）之间加一行调用。

### 3.2 一行记录（字段缺失即省略，不伪造 `null`/0，见 `docs/ARCHITECTURE.md:427`）

```json
{"v":1,"job":"j0123456789abcdef","archived_at":"2026-11-22T08:00:00Z",
 "project":"/work/demo","role":"imp","harness":"claude","model":"example-model","thinking":"high",
 "preset":"default","used_place":"claude example-model high",
 "attempts":[{"place":"pi example-model","reason":"launch timeout"}],
 "dispatch_exit_code":0,"state":"closed","exit_reason":"report read",
 "created_at":"…","started_at":"…","settled_at":"…","ended_at":"…","read_at":"…","reaped_at":"…",
 "checks":{"passed":2,"total":3,"stale":false},
 "repair_of":"j…","parent_job":"j…","package":"…","outcome":"partial"}
```

- `harness`：`job.cli?.agent`；`job.bro` → `bro`；`job.jev` → `jev`；否则 `pi`。
- `exit_reason`、`attempts[].reason` 截断到 200 字节（可能含屏幕引用，如额度提示）。
- `outcome`：只读已有的 decision-labels 缓存文件；不存在或解析失败则省略，绝不为归档发起模型请求。
- 不写 `request_key`、`herdr_pane`、brief/report 任何内容。

### 3.3 写入与去重

1. `openSync(join(dir, '.archived'), 'wx', 0o600)` 作为一次性声明；`EEXIST` 则跳过（上次已归档、但删除失败的情况）。
2. `mkdirSync($HUD_HOME/archive, { recursive: true, mode: 0o700 })`，月份取 `ended_at`（或 `reaped_at`，均无则当前时间）的 UTC `YYYY-MM`。
3. 一次 `appendFileSync(file, JSON.stringify(row) + '\n', { flag: 'a', mode: 0o600 })`。watcher 由 `watch.pid` 保证单实例，单行小写入，不需要锁。
4. 任意异常：每进程每类错误记一行 `archive <id> failed: <code>`，然后照常 `rmSync`。

先声明后追加：崩溃窗口里最多丢一行，绝不重复；与 pi-roles ledger 的 `.ledger-recorded` 做法一致。

### 3.4 体量

每任务一次 open + 一次 append，约 1 KB；按每天数十个任务计，每月约 1–3 MB，对 SSD 写入可忽略。

---

## 4. 垂直切片与实施路线

### Slice 1：JOB-ARCHIVE（唯一切片，S）

| 文件 | 改动 |
|---|---|
| `src/roles/job-archive.ts`（新） | `archiveJob` + 字段映射，~70 行 |
| `packages/hud-mcp/bin/hud-watch.mjs` | 引入并在删除前调用，~3 行（若 06 已落地，则加在其新删除点） |
| `tests/unit/job-archive.test.mjs`（新）或扩展 `tests/unit/job-retention.test.mjs` | ~140 行，见 §5.1 |
| `docs/ARCHITECTURE.md:388` 状态文件表、`docs/reference.md` / `docs/reference.zh.md` 保留段落 | 各加一句 |
| `docs/spec.md` | owner 同意后加一行（见 §6 Q3 之后） |

**Done**：§5.1 全部通过；`npm test` 全绿；现有 `job-retention.test.mjs` 断言不变。

---

## 5. 验证与验收方案

### 5.1 单元测试（临时 `HOME`/`HUD_HOME`/`PI_CODING_AGENT_DIR`，全部合成数据，沿用 `job-retention.test.mjs:44,65` 的假时钟写法）

1. 过期 CLI 任务（含 checks、attempts）：删除后归档恰好一行，字段与 §3.2 一致；文件 `0600`、目录 `0700`。
2. 隐私：report.md / brief.md / qa 中放入唯一标记串，归档文件中不得出现。
3. `preserveSessions` 失败而保留目录：不写归档。
4. 归档不可写（`archive` 是普通文件）：目录仍被删除，`watch.log` 有一行错误，watcher 不退出。
5. 已有 `.archived` 但目录残留：再次扫描不重复追加。
6. 存在合成 decision-labels 缓存时带 `outcome`；不存在时字段缺失。
7. `ended_at = 2026-10-31T23:59:00Z` 写入 `2026-10.jsonl`。
8. 未过期任务、working 任务：无归档、无 `.archived`。

### 5.2 Owner 试用清单

- [ ] 正常用一天；次日任务到期删除后，`ls -l ~/.hud/archive` 有当月文件，权限 `-rw-------`。
- [ ] `tail -n 3 ~/.hud/archive/<月份>.jsonl | jq .` 能看出 role、place、尝试、时间、checks。
- [ ] 用某份已读报告里的一句话 `grep` 归档文件，无结果。
- [ ] `~/.hud/watch.log` 无 `archive … failed`；面板、`hud_read`、删除时机与之前一致。

---

## 6. 需要 Owner 拍板的开放问题

| # | 问题与选项 | 默认及理由 |
|---|---|---|
| **1** | **是否附带报告摘要**<br>• A：不带任何文本（含面板标题）<br>• B：报告首行或前 ~300 字节<br>• C：完整复制 report.md 到 `archive/reports/<id>.md` | **A**。报告含项目内容，归档无保留期；先只存事实，需要时再开 B。 |
| **2** | **是否有读取方**<br>• A：无，仅记录<br>• B：`hud_read` 查询已删除任务时返回该行<br>• C：`hud history` | **A**。owner 偏好被动记录；B/C 属新功能，另行决定。 |
| **3** | **归档本身是否要保留期** | **暂不删除**（每月约 1–3 MB）；并入 M5 保留期候选一起决定，届时同样先看删除清单。 |

建议的 spec 新增句（owner 同意后写入，位置在 JOB-RETENTION 相关描述旁）：“Before deleting a closed job directory, the watcher appends one line of the job's facts (no report text) to `$HUD_HOME/archive/YYYY-MM.jsonl`; nothing reads it yet.”
