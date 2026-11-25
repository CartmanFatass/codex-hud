# 15. 在 `hud_read` 的 `git_summary` 中报告并行 worktree 的改动重叠（§3.7 精简版）

> **优先级**：P3（小改动，低风险，提前暴露 cherry-pick 冲突） ｜ **类别**：MCP / 托管 worktree / 只读 Git 事实 ｜ **预估规模**：S（1 个垂直切片，源码 ~+70 / -10 行，测试 ~+80 行） ｜ **前置依赖**：无功能依赖。冲突风险：MCP-SPLIT-01..03（提案 02）会拆分 `src/mcp/thin-main.ts` 并给 `managed-worktree.ts` 加 re-export；ASYNC-WATCH（提案 06）在 `reapWorktree` 周围加 per-`main_root` 串行锁；EVENT-WAITS（提案 07）改 `thin-main.ts` 与 `tests/unit/thin-mcp.test.mjs`。建议在 MCP-SPLIT 之前落地，或等其完成后按新文件位置落地，不要与之并行 ｜ **`docs/spec.md` 边界影响**：小幅措辞扩展（spec:13 的 `isolation: "worktree"` 句子 “reporting `git_summary` in `hud_read`” 增加 “including files also changed in other managed worktrees of the same checkout”），需 owner 认可；不触及 §3 禁止项，不新增常驻进程、轮询或通知

---

## 1. 背景与现状证据

行号以 `f0baa540` 为准。

### 1.1 现有工作流已在切片阶段避免重叠，但没有运行期核对

- `docs/delegation.md:23`：“One fresh implementer per slice, in parallel only where slices touch different files.” 文件不重叠是主会话切片时的**计划**，没有任何运行期事实去核对。
- `docs/delegation.md:88-91`：每个 code imp 一个 worktree，主会话在 worktree 中提交后 cherry-pick 到 `universal-hud`。重叠只会在 cherry-pick 时以冲突的形式暴露，往往是两个 worker 都结束之后。
- 全仓库没有 `owns_paths` 或任何声明式路径所有权（`grep owns_paths src .scratch` 无结果）。

### 1.2 `gitSummary` 已经算出改动文件集合，只是丢弃了

`src/mcp/managed-worktree.ts:55-70`：

- `:62-66` 并行执行 `rev-list --count`、`diff --name-only -z <base_head> <head>` 和 `status --porcelain=v1 -z`；
- `:67` 过滤掉自身的 `node_modules` 链接；
- `:68` 把两者合并成 `new Set([...])`，**只返回 `.size`**（`changed_files`），路径列表被丢弃。

也就是说，判断重叠所需的数据已经算好了，只需把集合保留下来，再对同一检出的其他托管 worktree 做一次同样的计算。

### 1.3 调用点与现有测试

- `src/mcp/thin-main.ts:1721`：`git_summary` 只在**单个 job 的** `hud_read` 中计算（`receipt.worktree ? { git_summary: await gitSummary(receipt.worktree) } : {}`），列表读、`hud_wait` 都不算。
- `tests/unit/thin-mcp.test.mjs:2107-2124`：断言 `git_summary` 的精确形状 `{ branch, base_head, head, ahead_commits, changed_files, dirty }`，以及列表、`recent`、`hud_wait` 结果中**没有** `git_summary`。
- `src/mcp/thin-main.ts:176-181` 的 `jobs()` 读取全部 job 目录的 `job.json`；`Job.worktree`、`worktree_removed_at`、`worktree_kept_reason` 定义在 `:88-90`。

### 1.4 cherry-pick 之后 worktree 仍会留下

`reapWorktree`（`managed-worktree.ts:106-109`）只在 worktree 的 `head` 是主检出 `HEAD` 的祖先时才删除。cherry-pick 会产生新哈希，所以已集成的 worktree 会带着 `worktree_kept_reason` 留下（`packages/hud-mcp/bin/hud-watch.mjs:200-204`）。朴素的“改动文件求交集”会把这些**已集成**的旧 worktree 也算进来，产生误报。设计必须过滤掉已集成的改动（见 §3.3）。

### 1.5 面板不适合承担这件事

`src/collectors/diff-stat.ts:99` 的 `DiffStatCollector.job` 只采样当前选中的 job（“Inspect just the selected job”）。在面板上做跨 job 重叠检查，就要对所有打开的 worktree 每个 tick 跑 git，这违背 spec §4 的轻量要求。`hud_read` 是按需调用，正好是合适的位置。

---

## 2. 目标与非目标（Scope / Out of Scope）

### 目标（Scope）
1. 单个托管 worktree job 的 `hud_read` 结果中，`git_summary` 增加 `overlaps: [{ job, files }]`：同一 `main_root` 下**其他**仍存在的托管 worktree 中，与本 job 改动了同一路径、且该改动尚未集成进主检出 `HEAD` 的文件。
2. 只在 `hud_read` 读取该 job 时按需计算，复用已有的安全 Git 参数（`neutralizeFilters`、`worktreeGit`）。
3. 结果有界：最多比较 8 个其他 worktree，每个最多列 20 个文件；读不到时明说“不完整”，绝不伪造“无重叠”（`docs/ARCHITECTURE.md` §8：“Failed reads yield null/unknown, never a fabricated zero or clean state”）。

### 非目标（Out of Scope）
- 不新增 `hud_create` 的 `owns_paths` 参数或任何路径声明（spec §4：新选项需要具体理由）。
- 不做 watcher 轮询，不发通知，不往 `changes` / `hud watch` / MCP task 结果里加内容，面板 Home 卡片不加红色标记。
- 不比较主检出自身未提交的改动，也不比较非托管 worktree（例如手工 `tmp/wt-new.sh` 创建的 `../MyHUD-wt/<WP>`）。
- 不做 hunk 级的冲突预测（不跑 `merge-tree`），文件级就够了。
- 不改变 `reapWorktree` 的删除规则。

---

## 3. 核心设计方案

### 3.1 拆出 `changedPaths`

在 `managed-worktree.ts` 中把 `gitSummary` 的 `:57-68` 抽成内部函数：

```ts
async function changedPaths(wt: ManagedWorktree, head: string) {
  const filters = await neutralizeFilters(git, wt.root);
  const [commits, diff, pending] = await Promise.all([/* 与现 :63-65 相同 */]);
  const dirtyRows = fields(pending).filter((row) => row !== '?? node_modules' || !dependencyLink(wt));
  return { commits: Number(commits), committed: new Set(fields(diff)), dirty: new Set(dirtyRows.map((r) => r.slice(3))) };
}
```

`gitSummary` 的返回值不变，只是改为调用它。

### 3.2 新增 `overlaps`

```ts
export interface OverlapCandidate { job: string; worktree: ManagedWorktree }
export async function gitSummary(wt: ManagedWorktree, others: OverlapCandidate[] = [])
// 返回 { ...现有字段, overlaps: { job: string; files: string[]; more?: number }[] | null, overlaps_incomplete?: true }
```

算法：
1. 自身 `changedPaths` 成功后得到 `mine = committed ∪ dirty`；如果自身摘要失败（现 `:69` 的 catch 分支），`overlaps: null`。
2. 复用同一次 `list(wt.main_root)` 的结果，只保留**仍然注册**、分支与记录一致的 `others`（已不存在的 worktree 直接跳过，不算不完整）。
3. 对每个 other 并行计算 `changedPaths`，取 `candidates = (other.committed ∪ other.dirty) ∩ mine`。
4. 集成过滤（§3.3）后若仍非空，记为 `{ job, files: 排序后前 20 个, more }`。
5. 任何一个 other 的 git 调用失败，或 others 超过 8 个被截断，都设置 `overlaps_incomplete: true`。

### 3.3 集成过滤（消除 cherry-pick 后的误报）

对 other 中**已提交**的候选路径，在 `main_root` 运行一次：

```
git --literal-pathspecs diff --name-only -z --no-renames --no-ext-diff --no-textconv HEAD <other.head> -- <candidates>
```

输出中没有的路径，说明主检出 `HEAD` 中该文件已与 other 的版本一致（已经 cherry-pick 或合并），就丢弃。other 中**未提交**（dirty）的候选路径一律保留，因为它们不可能已集成。`--literal-pathspecs` 保证 `a[1].ts` 这类文件名不会被当成通配符。候选路径上限为 200 条，超出部分记为不完整。

剩余误报：other 已集成后主检出又改了同一文件，该文件仍会被列出。这种情况可接受，而且真的 cherry-pick 时本来也可能冲突。

### 3.4 调用点（`thin-main.ts:1721`）

```ts
const others = receipt.worktree ? jobs().filter((j) => j.job !== receipt.job && j.worktree?.main_root === receipt.worktree!.main_root
  && j.worktree.root !== receipt.worktree!.root && !j.worktree_removed_at)
  .sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];
const git = receipt.worktree ? { git_summary: await gitSummary(receipt.worktree, others.map(({ job, worktree }) => ({ job, worktree: worktree! }))) } : {};
```

`worktree_kept_reason` 不作为排除条件，因为这些 worktree 仍然存在；是否算重叠交给 §3.3 的集成过滤判断。

### 3.5 成本

- 只发生在单个 worktree job 的 `hud_read` 中；常见情况是 0–3 个其他 worktree，每个多 3–4 次 git 调用（每次受 `worktreeGit` 现有超时限制），并行执行。
- 没有其他 worktree 时，开销与现在完全相同（只多一次空数组判断）。
- 不写任何文件，不起进程，不改 watcher。

---

## 4. 垂直切片与实施路线（对齐 `docs/delegation.md`）

### Slice 1：`git_summary.overlaps`（单个 imp 会话可完成）
- **依赖**：无；在 MCP-SPLIT-01 之前或之后落地，避免同时进行。
- **估行**：源码 ~+70 / -10，测试 ~+80。
- **改动文件**：
  1. `src/mcp/managed-worktree.ts`：抽出 `changedPaths`；`gitSummary(wt, others)` 增加 `overlaps` / `overlaps_incomplete`；集成过滤使用 `--literal-pathspecs`。
  2. `src/mcp/thin-main.ts`（约 `:1721`）：组装 `others` 并传入。
  3. `tests/unit/thin-mcp.test.mjs`：更新 `:2119` 的形状断言（`overlaps: []`），新增 §5.1 用例。
  4. `docs/reference.md:171`、`docs/reference.zh.md:111`：一句话说明 `overlaps`。
  5. `docs/spec.md:13`：owner 认可后补上文首“边界影响”所述的措辞。
- **完成标准**：`node --test tests/unit/thin-mcp.test.mjs` 全绿；新用例覆盖 §5.1 第 1–7 项。

---

## 5. 验证与验收方案

### 5.1 自动化单测（临时 `HOME` / `HUD_HOME` / `CODEX_HOME`，合成仓库与合成文件）

复用 `thin-mcp.test.mjs` 现有的 `fixture(t)` 与 `initRepo`（见 `:2107-2113`），以 `isolation: 'worktree'` 创建两个 job：

| # | 场景 | 断言 |
|---|---|---|
| 1 | A、B 都在 worktree 中提交了 `tracked.txt` 的改动 | `hud_read(A).git_summary.overlaps` 为 `[{ job: B, files: ['tracked.txt'] }]`，B 读到的结果反过来对称 |
| 2 | A 改 `a.txt`，B 改 `b.txt` | 双方 `overlaps` 都是 `[]` |
| 3 | B 的提交已 cherry-pick 到主检出 `HEAD` | A 的 `overlaps` 为 `[]`（集成过滤生效） |
| 4 | B 只在工作区修改 `tracked.txt` 未提交 | A 的 `overlaps` 列出 B |
| 5 | B 的 worktree 被手工 `git worktree remove` | A 的结果中不含 B，也没有 `overlaps_incomplete` |
| 6 | 文件名 `a[1].txt` 两边都改 | 正确列出，不被当作通配符 |
| 7 | 9 个其他 worktree（合成） | 只比较 8 个，`overlaps_incomplete: true` |
| 8 | 回归 | 列表读、`view: 'recent'`、`hud_wait` 结果仍不含 `git_summary`（现 `:2120-2123`） |

全量：在 `tmp/env.sh` 隔离环境中跑 `npm test`。

### 5.2 Owner 试用清单

- [ ] 在本仓库用 `isolation: "worktree"` 派发两个 sonic，让两者各改同一个文档文件的一行并提交。
- [ ] 主会话 `hud_read` 其中一个 job：`git_summary.overlaps` 列出另一个 job 和该文件。
- [ ] cherry-pick 其中一个后再读另一个：重叠消失。
- [ ] 只派发一个 worktree job 时，`hud_read` 的耗时与现在没有可感知差别。

---

## 6. 需要 Owner 拍板的开放问题

| # | 问题与选项 | 推荐默认项及理由 |
|---|---|---|
| **1** | **已关闭但被保留的 worktree（`worktree_kept_reason`）是否参与比较？** A：参与，依靠集成过滤去掉已 cherry-pick 的；B：只比较仍在工作（未结算）的 job。 | **A**。未集成的保留 worktree 恰恰是 cherry-pick 时会冲突的来源；集成过滤已经消除主要误报。 |
| **2** | **字段形状**：A：总是返回 `overlaps`（无重叠为 `[]`，自身摘要失败为 `null`）；B：只在非空时出现。 | **A**。符合 §8 “missing evidence stays absent/unknown”，`[]` 与 `null` 含义清楚；代价只是改一处现有断言。 |
| **3** | **是否把主检出自身未提交的改动也算进来？** | **不算**。主会话自己知道它在主检出里改了什么；加上它会让每次读都多跑一次主检出 `status`。 |
| **4** | **是否在 `hud_create` 返回值或通知中提示重叠？** | **不提示**。保持按需；主会话在读报告、准备集成时自然会看到。若试用后觉得太晚，再单独讨论。 |
