# CodeGraph 索引与 HUD bug 排查

审查基线：`f95f976` 加当前工作区已有未提交改动，包括 Monitor、worktree collector、设置与 tmux wrapper。以下问题描述和行号记录修复前的观察。日期按工作区时区 America/Los_Angeles 记录。

## 修复状态

本文七项复现路径均已修复：过滤过期 snapshot 与其他 tmux server 的 snapshot、保留未完成 JSONL 尾部、隔离读取代次与速率状态、通过已打开的文件描述符安全读取、失败后释放队列并重放、识别文件替换、使用目录 watcher。会话查找仍保留定时轮询；跨午夜新目录依赖轮询兜底。缺少 server 元数据的 snapshot 仍不能提供完整身份保证。

另已修复上下文计算口径：按 Codex `rust-v0.154.0` 的 `percent_of_context_window_remaining` 扣除 12,000 token 基线，再计算占用；移除累计 session token 作为上下文的回退。默认仍显示 used，可配置 remaining。开始新轮次或压缩后尚未收到用量时显示 `Ctx~`，读取异常保留最后快照并标记过期；不再把旧速率当作当前速率。状态栏默认开启，支持设置页持久开关和环境变量覆盖，工作/空闲/中断/错误采用语义颜色与图形。

计算依据：[OpenAI Codex protocol.rs](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs#L2258)。HUD 对不超过 12,000 的自定义小窗口仍使用原始比例回退，详见 README。七项诊断复现脚本重跑结果为 `0 reproducible bugs`。

修复后验证：构建通过，`npm test` 的 28 个测试文件通过；集成脚本 14 项实际通过，1 项 native Windows 检查在 WSL 跳过（runner 将其计入 passed=15）。新增真实 PTY 回归和增量日志/状态栏测试。原有 `.mjs` 测试的 identity-line-effort 已通过，model-glyphs、subagent-tree、tree-keys 三项旧断言尚未更新；下方基线统计保留用于对照。

用户后续要求优先关注 WSL 的键鼠事件拦截，已另行完成 [输入事件专项排查](2026-09-21-input-review.md)，包含真实 PTY 滚轮与右键复现。

CodeGraph 1.6.0 已通过 `codegraph init --yes .` 建立本地 `.codegraph/` 索引。初始覆盖 122 个文件、1,992 个节点、6,525 条关系，状态 complete、pendingRefs=0。已使用 `explore`、`callers` 追踪 SessionFinder、RolloutParser 与 Monitor。索引语言为 TypeScript、JavaScript、Python；Bash/tmux 入口另行阅读和测试。

修复后已同步到 127 个文件、2,144 个节点、6,895 条关系，状态 complete、pendingRefs=0，无待同步代码变化。

## 已复现的问题

### 1. P1：旧 shell snapshot 可以把新 HUD 绑定到其他项目

位置：`src/collectors/session-finder.ts:388`、`:595`。

`findThreadIdForPane()` 仅凭 `TMUX_PANE` 和 snapshot 文件名中的 nonce 选会话。tmux pane ID 只在所属 server 内唯一，server 重启或多个 server 共用 CODEX_HOME 时会重复。绑定分支没有验证启动时间或工作目录，并优先于正确的 cwd fallback。

复现：保留旧项目 A 的 `%70` snapshot，在新项目 B 启动同 pane ID 的 HUD，B 的 rollout 已存在且当前活跃。finder 仍返回 A。新会话没有写出可匹配 snapshot 时，错误会持续存在，token、模型和代理树都可能来自其他任务。

修复方向：增加 server/启动代次身份，不把历史 pane ID 当作当前归属的充分证据；不能简单只按 cwd 拒绝合法 resume 或跨 cwd 导航。

### 2. P1：半行 JSONL 会被永久跳过

位置：`src/collectors/rollout.ts:588`、`:593`。

readline 在 EOF 也发出没有换行的尾行；不完整 JSON 解析失败后被丢弃，但 offset 仍按全部 bytesRead 前进。写入剩余部分时，下一次只读到 JSON 后半段，同样解析失败。

复现：将一个 function_call 记录分两次追加，在两次追加之间执行 parse。预期 totalCalls=1，实际为 0。token、工具完成或代理事件也走同一读取路径。

修复方向：只提交完整记录的 offset，保留未完成尾部，并明确兼容完整但无末尾换行的记录。

### 3. P1：解析中切换会话后，旧结果覆盖新缓存

位置：`src/collectors/rollout.ts:627`、`:647`；入口 `src/index.ts:59`。

`setRolloutPath(B)` 清空缓存后，已经启动的 A 读取仍会完成；parse 在 await 后直接回写 lastOffset、runningCalls 和 cachedResult，没有检查读取所属的会话代次。解析队列只串行化 parse，不保护 setRolloutPath。

复现：启动 A.parse，立即切换到等长的 B，等待旧读取结束，再 parse。预期 session B/new，实际仍为 A/old，B 内容被旧 offset 跳过。主入口的定时 SessionFinder 和 watcher 回调可在读取期间改变路径；tree-page 自身的 collecting 锁不能修复主入口问题。

修复方向：读取绑定 generation/path，完成时丢弃过期结果；token rate tracker 也应隔离代次。

### 4. P1：读取过程中日志被移走，错误处理自身抛异常，HUD 退出

位置：`src/collectors/rollout.ts:593`、`:602`、`:606`。

close/error 回调通过 `computeNewOffset()` 再次对原路径 statSync。文件已被删除或归档时，这里抛 ENOENT；异常发生在事件回调中，没有转化为 Promise rejection，外层 try/await/catch 无法捕获。

复现使用子进程故障注入，在初次 stat 与 createReadStream 打开之间 unlink 文件。即使调用方包裹 try/catch，进程仍 exit=1，堆栈指向 computeNewOffset 的 statSync。

修复方向：错误收尾路径不能再次执行未保护的路径 stat；使用打开文件的信息或安全处理文件消失。

### 5. P1：一次解析失败后，队列永久停在 rejected Promise

位置：`src/utils/parse-queue.ts:23`。

parseInFlight 只在 await 成功后置 null。parseFn 一旦 reject，之后的每次调用都直接返回同一个 rejected Promise，不再实际读取。初始 stat 的临时权限或文件消失竞态都可走到这一分支。

复现：让 parseFn 第一次抛错、第二次本应返回 recovered，连续调用队列。第二次仍 rejected，底层函数只执行过一次。主 HUD 会不断报错，不能自行恢复。

修复方向：在 finally 中释放 in-flight 状态，并定义失败时 queued 请求的处理方式。

### 6. P2：同路径日志替换不能被识别

位置：`src/collectors/rollout.ts:351`、`:627`。

只用 fromOffset > fileSize 判断截断，没有记录文件 identity；相同路径 setRolloutPath 直接返回。当日志 rename-over 后大小等于或大于旧 offset，解析器跳过新文件前缀，保留旧统计。

复现：读完 A 后，把等长 B rename 覆盖 A 的路径，再 parse；实际仍是 A/old。较大的替换文件还可能在旧会话缓存上合并新尾部。

修复方向：检测 inode/device 或适当的文件代次信息，再重置 offset、缓存及速率状态。这里是重放/文件替换边界，未声称 Codex 必然执行这种轮转。

### 7. P2：会话和 snapshot watcher 的 glob 永远不匹配

位置：`src/collectors/file-watcher.ts:108`、`:118`。

当前安装的 chokidar 5 不支持 glob；其本地 README 也明确记录自 v4 移除 glob 支持。代码仍传入 `rollout-*.jsonl` 和 `*.sh`，被当作字面路径。

复现：等待 watcher ready 后创建两个匹配文件，直接监听目录的对照 watcher 收到 2 次通知，产品的两个 watcher 都收到 0 次。主入口每秒轮询和具体 rollout 文件 watcher 掩盖了部分影响，所以这不等于 HUD 完全不刷新。

修复方向：监听目录并过滤事件文件名，同时处理跨天目录切换。

## 验证结果与边界

- `npm run build`：通过。
- `npm test`：26 个测试文件通过。
- `node --test 'tests/unit/*.mjs'`：16 个文件中 12 通过、4 失败。失败文件是 test-identity-line-effort、test-model-glyphs、test-subagent-tree、test-tree-keys。包含过期导出、格式与按键语义断言，不能算成 4 个已确认产品 bug；这些文件没有纳入默认 npm test，存在测试维护缺口。
- 集成脚本：13 项通过，1 项 native Windows 脚本在 Linux 跳过。runner 把该 exit=0 的 SKIP 计入 passed，故打印的 passed 数会包含跳过项。4 项真实 tmux 测试初次因沙箱禁止 socket 失败，在隔离临时 socket/settings 环境重跑后全部通过，其中 toggle 51 个检查通过。
- 未验证真实 Windows/macOS 环境；本文不依赖线上 Codex 协议假设，复现使用本地合成 rollout。
- 旧 ISSUES.md 并非当前状态的可靠依据。例如 session timer 的 renderer 已优先读取 session.startTime；CRLF/no-newline offset 已使用 bytesRead，但半行事件问题仍存在。

复现以上 7 项（退出码 1 表示仍有问题；构造临时文件并自动清理，不接触真实 Codex 数据）：

```bash
npm run build
node docs/reviews/reproduce-2026-09-21.mjs
```

索引可用 `codegraph sync .` 更新，用 `codegraph status --json` 检查。以上复现脚本保留为修复后的验证入口。
