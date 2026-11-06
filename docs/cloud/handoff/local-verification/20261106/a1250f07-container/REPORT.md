# codex-hud 本地统一验证报告（a1250f07）

日期：2026-11-06。执行者：本地 Claude Code（owner 授权：容器隔离、允许安装、按实际情况完成）。
目标：commit `a1250f07995465b40e29a284a732978894c3e7ee`，tree `708eb6a30002ca749ba27d00aadb7d10dcd2265d`，每份 checkout 测试前后 `git status` 均为空。
模式：全部为 **synthetic**；无真实 provider、真实安装／全局 shim、tmux/Herdr、外发或付费调用。

## 一页结论

本次完成的合成验证（以第 2 轮容器结果为准）：

| 组 | Node 24.22.1 | Node 22.23.4 | 结论 |
|---|---|---|---|
| A 三次普通构建 | PASS ×3 | PASS ×3 | 构建通过 |
| B check-cloud（35 focused + workbench + pi bridge + managed-targets + delegate-list + observer + 9 demo） | 首轮 FAIL（focused 285/286，statusline 间歇），重跑 PASS | PASS | 1 个间歇失败（见 F-4） |
| C runtime-compose / installer / managed | 32/32、70/70、141/141、79/79、3/3 全 PASS | compose 两项 BLOCKED（夹具固定 Node 24.22.1）；installer 140/141 FAIL；其余 PASS | Node 22 有 1 个测试夹具缺陷（F-3） |
| D headless close / authz / run-control / budget | close 29/31 FAIL；64/64、68/68、12/12 PASS | 同左 | 2 个测试缺陷（F-2），自 36583094 起即失败 |
| E hud-env / settings / visual / panel help | 106/106、1/1、331/331 PASS；`panel --help` 未建 home | 同左 | 全部通过 |
| F digest CLI | 142/143 FAIL；`digest --help` PASS | 同左 | 1 个测试缺陷（F-1） |
| G 完整性 | format:check FAIL（27 文件）；fixtures OK；diff --check 空；status 干净；HEAD/tree 正确 | 同左 | 格式未清（F-5） |

**没有发现产品越权或安全门槛被放宽的失败。** 所有确定性失败都是测试夹具与既有 schema 触发器／Node 版本行为不一致，或格式问题；但这意味着相应行为（thread-mismatch 读取拒绝、close 后 handover 不写、release capacity）**在本次没有被真正断言**，不能记为已验证。不是全绿。

## 环境

- 宿主：WSL2 Linux 6.18.33.2，x86_64，Git 2.43.0，宿主 Node v24.22.1（nvm）。
- 容器：Docker 29.7.2；`node:24.22.1-bookworm`（sha256:d862bb5d…08ea）、`node:22.23.4-bookworm`（sha256:7702d8aa…0d3f）；Debian 12.15，/usr/bin/cc、Python 3.11.2、Git 2.39.5。
- 运行：`--network none`、`--user 1000:1000`、`--init`、`--pids-limit 4096`、`--rm`；只挂载本轮私有目录；HOME/HUD_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR/PI_CODING_AGENT_DIR/TMPDIR/TMUX_TMPDIR 全指向私有目录；`LANG/LC_ALL=C.UTF-8`、`NO_COLOR=1`、`CI=1`。容器结束后无残留（cleanup CONFIRMED）。
- 依赖：仓库自带受跟踪 `node_modules`（typescript、@types、chokidar…）；缺 prettier → 在容器内 `npm pack prettier@3.9.9`（唯一联网步骤），sha512 与 lockfile integrity 一致后解压到未跟踪的 `node_modules/prettier`。未 `npm ci`，未改受跟踪文件。
- package-lock.json SHA-256 `67b18477…ed56`；package.json blob `04e5c19e…`；check-cloud.mjs blob `5768a785…`（与任务书一致）。
- 身份：8 个祖先 `merge-base --is-ancestor` 均 0；60625488 父提交为 managed、installer；远端分支和 `main=91084827` 与任务书一致。

## 与任务书的偏离（及原因）

1. **容器补 `/etc/machine-id`**：Debian 镜像没有该文件，产品的进程域读取按设计 fail-closed（`supervisor_stamp_unavailable`），导致第 1 轮 C/D/B 大量失败。第 2 轮给每个容器只读挂载一个**随机合成** machine-id（非宿主值）。正常 systemd Linux 主机都有此文件，第 1 轮失败归类为环境问题，日志保留在 `n24/`、`n22/`。
2. prettier 的获取方式见上；宿主初轮 A/B 的结果（全 PASS）保留在 `logs/`、`evidence/` 作参考。
3. 额外加了 `E4-panel-help-nohome`：`node bin/hud panel --help` 在不存在的 HOME 下运行后确认未创建目录（PASS）。

## 发现（需要作者处理，未修改任何代码）

**F-1 digest：thread-mismatch 用例无法建立前置条件（两版本、宿主均复现）**
- `dist-test/tests/unit/delegated-report-read.test.js` → `actual metadata selection refuses thread mismatch`
- 测试用 `UPDATE runs SET target_session_ref=…` 制造坏数据，被 `src/ledger/schema.ts:260` 触发器 `known target ref cannot be replaced` 拒绝（ERR_SQLITE_ERROR 1811），产品读取端的拒绝断言从未执行。
- 复现：`node --test --test-name-pattern='refuses thread mismatch' dist-test/tests/unit/delegated-report-read.test.js`
- 建议：夹具里在注入前绕开该触发器（如临时 DROP/重建 trigger）或在插入阶段就用不一致的 ref 构造。

**F-2 headless close：两个用例自 36583094 起即失败（非后续回归）**
- 在独立目录 `hist-3658/` 固定 `36583094`（tree e2263e46）复现同样 29/31。
- (a) `E4 resume commits first … replay untouched`：被拒绝的 handover 后 `total_changes()` 58 ≠ 56（编译后 test.js:231）。注意 SQLite `total_changes()` 也计入随后回滚的语句，因此这可能是断言方式错误，也可能是确实有写入；**持久状态是否改变尚未确认**，需要作者用表内容比较判断。
- (b) `E4 target after acceptance preserves intent and never closes a successor`：测试事务（test.js:323）改 child ref，被 `schema.ts:176` 触发器 `known child ref cannot be replaced` 拒绝，同 F-1 类型。
- 复现：`node --test --test-name-pattern='E4 resume commits first|E4 target after acceptance' packages/hud-mcp/dist/tests/hud-mcp/headless-close.test.js`
- 自然 CI 未选择该套件，所以一直没被发现。

**F-3 installer：Node 22 上 release capacity 用例确定性失败（5/5）**
- `tests/unit/runtime-install.test.mjs:554` `fix1 release capacity reserves a slot…` → `unsafe_owned_directory`（installer.mjs:199）。
- 根因已验证：测试用 `fs.cpSync` 复制 0700 bundle，Node 22.23.4 产生 0755 目录，Node 24.22.1 保留 0700；安装器正确拒绝。生产代码不使用 cpSync。
- 建议：测试复制后显式 `chmod 0700`（递归）。

**F-4 statusline-summary 间歇失败（仅 Node 24 容器 focused 批量中 1 次）**
- `actual hud-statusline and hud statusline render line 2 …`：第 2 行为空。单独重跑容器 2 次、宿主 1 次均 11/11；check-cloud 重跑 PASS。首次日志：`n24b/src/tmp/cloud-development/checks-PZ7mVH/focused.log`。疑似负载/时间敏感，建议作者看该路径的新鲜度窗口。

**F-5 format:check 不通过（prettier 3.9.9）**
- 27 个文件；其中 22 个是五阶段新增／修改（digest、small-model、delegated-report-read、ledger close/reconcile、runtime-compose 夹具与测试、headless-close/hook-source 测试等），5 个在 ba6887 已存在（ledger-processes、workbench 4 个）。清单见 `n24b/logs/G1-format-check.stdout`。云端从未有 prettier，故此前未检出。

**BLOCKED（设计限制，非产品失败）**：Node 22 上 `runtime-compose.test.mjs` 与 `runtime-compose.mjs --check-runtime-build` 断言 `pinned builtin transform runtime` 必须是 24.22.1。

**skip**：check-cloud managed-targets 1 skip：`optional installed Pi 1.4 parser … # Official Pi package not selected`（无真实 Pi 包，预期）。

## 未执行 / 需单独批准

- 真实 provider／账号、`hud digest run` 触发真实模型、真实安装／升级／回退、全局 shim、tmux/Herdr/lease、panel 实际 UI、浏览器、外发与付费调用：NOT_RUN。
- macOS／Windows／原生非 WSL Linux 平台矩阵：NOT_RUN。
- 可选附录 `9216565`（启动/布局别名，`hud-launch-env.test.mjs`）：NOT_RUN，可按同样容器方式单独测。

## 文件位置

根目录：`$ROOT/`
- `src/`：宿主初轮 checkout；`logs/`、`results.jsonl`、`evidence/checks-JadP17/`（宿主 check-cloud）。
- `n24/`、`n22/`：第 1 轮容器（无 machine-id）完整日志与 `results.jsonl`。
- `n24b/`、`n22b/`：第 2 轮（正式结果）`logs/*.stdout|stderr`、`results.jsonl`、`src/tmp/cloud-development/checks-*/`。
- `hist-3658/`：F-2 历史复现。
- `run-step.sh`、`run-docker.sh`、`sequence.sh`：执行脚本（精确 argv 和环境见此）。
- 未自动删除任何目录；Docker 镜像保留。

## 发布目录对照（本分支）

- 本地 `$ROOT/<round>/src/tmp/cloud-development/checks-*` → 本目录 `<round>/check-cloud/checks-*`。
- 本地 `$ROOT/logs`、`results.jsonl`、`evidence/checks-JadP17` → `host/`；`hist-3658/logs` → `hist-36583094/logs`。
- 私有路径已替换为 `$ROOT`、`$HOST_HOME`、`$NVM_NODE`；空的 stdout/stderr 文件未收录（等价于空输出）。`SHA256SUMS` 覆盖本目录所有文件。
- 本分支只新增本目录，基于 `a1250f07`，不改动任何产品代码、main 或已有分支。
