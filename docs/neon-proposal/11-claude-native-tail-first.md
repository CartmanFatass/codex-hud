# 11. Claude 原生子代理 transcript：首次打开先读尾部

> **优先级**：P3（体验优化，Owner 从 M5 候选中挑选后才排期） ｜ **类别**：面板采集 / 原生子代理树 ｜ **预估规模**：S（1 个垂直切片，`claude-native-tree.ts` 净改动 ~80–110 行 + 测试 ~120 行，含 2 个现有用例的预算断言调整） ｜ **前置依赖**：无代码前置。文件冲突低：`src/collectors/claude-native-tree.ts` 不在任何在途 lane 的改动清单里；方案 01（**PRUNE-OBS-02..04**）只把它当作 `headTail`（`model-jobs.ts`）与 `makeSourceId`（`core/identity.ts`）的使用方，且这两个函数都保留。测试文件 `tests/unit/claude-nested-replay.test.mjs`、`tests/fixtures/native-tree.mjs` 会被 PRUNE-OBS 回归跑到，但不会被改写 ｜ **`docs/spec.md` 边界影响**：无新边界。即 `docs/spec.md:197-199` 的 M5 候选 “a transcript is read tail-first on open so status shows at once, with the nesting filled in behind”，M5 候选未排期，**由 Owner 决定是否挑选**。本方案只覆盖 Claude 原生子代理 transcript（见 §6 Q1）

---

## 1. 背景与现状证据

### 1.1 现在只有一个从 0 开始的前向游标
`src/collectors/claude-native-tree.ts`（`ClaudeNativeTree.refresh`）：

| 事实 | 位置 |
|---|---|
| 新行的读取偏移从 0 开始 | `:112` `offset: previous?.offset ?? 0` |
| 每个文件每次刷新最多读 1 MiB | `:154` `Buffer.alloc(Math.min(1048576, stat.size - row.offset))` |
| 每次刷新预算：`reads >= 8` 即停，每个文件计 2 次（meta + 正文），所以最多 4 个文件 | `:91`、`:97` |
| 超出预算的文件只有在已有 `row` 时才推出节点；**从没读过的文件不出现** | `:94` `if (row) nodes.push(...)` |
| 读取游标每次轮转 4 个文件 | `:238` |
| 显示字段随前向解析覆盖：`lastEventAt`、`endTurn`、`model`、`action`、`lastReport` | `:179`、`:186`、`:193`、`:199`、`:201` |
| 状态性集合：`openTools`（`:189`、`:197`）、`calls`（嵌套 Agent/Task id，`:198`）、`resumed`（`:213-217`） | 同上 |
| 节点在读完之前标记为 `replaying`，`incomplete` 为 true | `:234`，`:221-222` |
| 嵌套靠 `calls` 与 `meta.toolUseId` 匹配；`spawnDepth > 1` 的节点在回放期间隐藏 | `:244`、`:252-254` |
| 任务卡一句话摘要跳过 `replaying` 节点 | `src/collectors/job-sentences.ts:236` |

### 1.2 实际表现
- 默认 `refreshMs` 为 1000（`src/settings.ts:71`）。一个 5 MiB 的子代理 transcript 要大约 5 次刷新（约 5 秒）才读到尾部，期间卡片显示的是会话开头的旧动作和旧文字。
- 有 20 个子代理文件时，按每次 4 个轮转，最后几个要约 5 秒后才**出现**。
- 状态（完成/运行）主要来自 `meta.finished`（`:142-146`），不是 transcript 正文。所以真正滞后的是「最新动作 / 最新文字 / 是否出现」，不是完成标记。

### 1.3 为什么不能整体改成从尾部读
`openTools`、`calls`、`resumed` 是从头累积出来的状态：只读尾部会漏掉更早的 `tool_use`，导致嵌套缺失和恢复判断错误。spec 原文本身也写的是 “nesting filled in behind”。

---

## 2. 目标与非目标

### 目标
1. 首次见到一个子代理文件时，如果正文大于 64 KiB，在**同一次刷新**里额外读 meta 和正文最后 64 KiB（预览），让节点立即出现，并带上最新的 `action`、`lastReport`、`model`、`lastEventAt`、`endTurn`。
2. 前向游标照旧从 0 开始补齐；它的进度还没越过预览起点时，**不得用更旧的值覆盖**预览得到的显示字段。
3. `calls`、`openTools`、`resumed` 和嵌套只由前向读取建立；节点在前向读完前保持 `replaying: true`，树保持 `incomplete: true`（遵守 `docs/ARCHITECTURE.md:438-439`）。

### 非目标
- 不改主会话 rollout、Codex 原生树或 pi 的读取。
- 不改 1 MiB 块大小、4 文件前向预算和轮转逻辑。
- 不让 `JobSentences` 或 `DecisionLabels` 对预览节点发起模型调用：`replaying` 语义不变，没有新增的出站模型输入（`ARCHITECTURE.md:444`）。
- 不新增磁盘缓存或常驻进程。

---

## 3. 核心设计方案

### 3.1 `Row` 新增字段（`:8-24`）
```ts
previewEnd?: number;            // 预览读到的文件大小；前向 offset 超过它后清除
preview?: Pick<SubagentTreeNode, 'action' | 'lastReport' | 'model' | 'lastEventAt'> & { endTurn?: Date };
```

### 3.2 预览读取（只针对首次见到的文件）
- 条件：`row === undefined`，`stat.size > 65536`，且本次刷新的预览预算没用完（推荐每次最多 16 个文件，即 ≤ 1 MiB 正文 + 16 × 8 KiB meta；见 §6 Q2）。
- 读 `[size - 65536, size)`，丢掉第一行（可能不完整），后面每行用与前向**同一个**解析函数处理，但传入 `mode: 'preview'`：只写 §3.1 的显示字段，不碰 `calls`、`openTools`、`resumed`、`startedAt`。
- 预览不在预算内（超出 16 个）的新文件，行为与今天相同。
- 如果文件不大于 64 KiB，直接走前向（一次就读完），不做预览。

### 3.3 前向补齐时保护显示字段
- 把现在 `:164-207` 的解析循环抽成 `applyLine(row, entry, mode)`，前向与预览共用，不复制逻辑。
- 前向每处理完一个块后，如果 `row.offset < row.previewEnd`，就把 `row.preview` 写回 `node.action`、`lastReport`、`model`、`lastEventAt` 和 `row.endTurn`；`calls`、`openTools`、`startedAt` 保留前向的结果。
- 当 `row.offset >= row.previewEnd` 时删除 `preview` 和 `previewEnd`，之后完全由前向接管。这样不会出现「先新后旧再新」的闪回。
- 预览期间 `startedAt` 还没有。节点排序（`:240-241`）可以用 `metaStat.birthtimeMs`（> 0 时）作为临时开始时间，前向读到第一行后改用真实时间（见 §6 Q3）。

### 3.4 对 `incomplete` 与 `bytes` 的影响
- 预览读取计入 `this.bytes`；单次刷新的上限从 `4 × (1 MiB + 8 KiB)` 变为再加 `16 × (64 KiB + 8 KiB)`。
- 有预览但未读完的行，`replaying` 仍为 true（`:234` 的条件不变，因为 `offset < size`）。

---

## 4. 垂直切片与实施路线

### Slice 1：尾部预览 + 前向保护（单个 imp 会话）
- **依赖**：无。
- **改动文件**：
  1. `src/collectors/claude-native-tree.ts`：抽出 `applyLine`，加预览读取、预览预算、写回保护（~+90/-30）。
  2. `tests/unit/claude-nested-replay.test.mjs`：`drain()` 的字节断言（`:25-32`）以及 “exact bounded forward byte ranges” 用例（`:70`）按新上限调整，并补充 §5.1 的新用例（~+120）。
  3. `docs/reference.md` 和 `docs/reference.zh.md`：原生代理一节加一句 “a long transcript shows its latest step at once; nesting fills in as it replays”。
- **完成标准**：§5.1 全绿；`claude-nested-replay`、`native-tree`、`panel-scope` 原有用例全绿；`npm test` 全绿。

---

## 5. 验证与验收方案

### 5.1 单测（`fs.mkdtempSync(join(tmpdir(), 'claude-tail-'))`，复用 `tests/fixtures/native-tree.mjs` 的 `nativeFixture`，全部为合成数据）

| # | 场景 | 断言 |
|---|---|---|
| 1 | 3 MiB 合成 transcript，最后一行是 `text: "SYNTH-LATEST"` 加 `end_turn` | 第一次 `refresh` 后节点就存在，`lastReport.text` 含 `SYNTH-LATEST`，`replaying === true`，`incomplete === true` |
| 2 | 同一文件继续刷新直到读完 | 每次刷新 `lastReport` 都**不回退**到更早的填充文本；读完后 `replaying === false`，`preview` 已清除 |
| 3 | 文件开头有 `Agent` 调用，`meta.toolUseId` 指向它的子代理 | 预览阶段子节点不挂到父节点下；前向越过调用后才嵌套；`calls` 只来自前向 |
| 4 | 20 个大于 64 KiB 的新文件 | 第一次刷新出现 16 个节点（预览预算），`bytes ≤ 4×(CHUNK+8192) + 16×(65536+8192)` |
| 5 | 小于 64 KiB 的文件 | 不走预览，读取字节与今天完全相同（锁住 “exact byte ranges”） |
| 6 | 预览窗口里有一个跨 64 KiB 边界的超长行 | 第一行被丢弃，不抛错；不标记 `omitted` |
| 7 | 预览完成后文件继续增长（追加 `SYNTH-NEWER`） | 前向越过 `previewEnd` 后，`lastReport` 变为 `SYNTH-NEWER` |
| 8 | `JobSentences.update` 收到一个预览节点 | 不提交模型请求（`replaying` 仍跳过） |

### 5.2 Owner 试用清单
- [ ] 在一个开过多个长子代理（transcript 好几 MiB）的 Claude 会话里打开 `/hud`：所有子代理卡片在约 1 秒内出现，并显示最新的动作或文字。
- [ ] 观察几秒：嵌套的子代理随后挂到父卡片下面，卡片文字不会闪回旧内容。
- [ ] 一句话摘要在回放完成后才出现（行为与今天一致）。

---

## 6. 需要 Owner 拍板的开放问题

| # | 问题 | 推荐默认 |
|---|---|---|
| 1 | spec 原文是 “a transcript”。要不要扩展到主会话 rollout 或 Codex 原生树？ | 不扩展。本方案只做 Claude 子代理；主会话与 Codex 另行评估，它们的读取路径不同 |
| 2 | 每次刷新的预览预算（文件数 × 64 KiB） | 16 个文件，即单次刷新最多多读约 1.1 MiB，且只在首次见到文件时发生 |
| 3 | 预览期间节点用什么排序？ | 用 meta 文件的 birthtime 作为临时开始时间，前向读到第一行后改用真实时间；没有 birthtime 时排到末尾 |
| 4 | 预览得到的文字要不要喂给一句话摘要？ | 不喂。保持 `replaying` 跳过，没有新增模型调用 |
