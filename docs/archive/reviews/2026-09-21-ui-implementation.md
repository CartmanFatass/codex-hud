# HUD / Tree 展示调整与验证

在用户同意 UI 审查建议后实施，保留当前工作区既有功能与未提交修改。

## 已完成

- 修复 Inspector 把内部 ANSI 颜色码显示成文字的问题，外部名字、模型和 diff 仍先进行控制字符清理。
- Agents 摘要、空白行不再触发会话切换；可见条目的点击与 `o` 切换行为保留。
- 提高上下文优先级。40 列且缓存到 25 分钟的回归样本仍保留 `Ctx` 和缓存提醒；状态栏继续只有一行。
- Tree 为模型/推理图形预留空间，再缩短名字；移除每行重复的 done/error 文本。状态图标着色，名字保持正常前景；选中行有反白/主题背景，`›` 在无色模式仍可辨认。
- 减少 16–20 列的左右边距。只强调当前标题，框线使用次要颜色；Worktrees 按内容收缩，空余高度优先分给 Agents 或当前 Inspector。宽屏 worktree 显示目录尾部而非整条绝对路径。
- Inspector 优先显示角色名、模型、状态、本轮经过时间和最近活动；`v` 展开/收起时间戳、UUID、路径等信息。
- Changes 在窄屏也显示可选文件；`Δ / S / U` 分别表示修改文件、暂存和未暂存数量。打开文件预览自动放大 Inspector，Esc 返回原布局。diff 长行折行，新增/删除/hunk 分别使用绿/红/青色，保留符号。
- 帮助页按词换行，支持上下、滚轮、翻页、首尾跳转；补齐 ultra 图例。窄屏 Settings 保留完整 Back/Save，裁掉的按钮没有隐藏热区；未保存字段标记 `*`，底栏开关提示 Next launch。
- 提亮 Mocha、加深 Latte 次要文字；在报告示例背景上的对比度分别约 5.81:1 和 4.37:1。终端主题继续继承用户配色。
- README 中旧 Details/Activity/Checks 页面说明已替换为当前 Agents/Worktrees/Changes/Inspector 行为。

可配置的“已完成代理自动分组折叠”保留为后续增强；当前仍提供原有筛选、树折叠和稳定 ID 选择，不新增隐藏历史条目的默认策略。

## 验证

- `npm test`：28 个测试文件通过，包含真实 PTY 的导航、滚轮、缩放、自动 diff 放大、设置保存、16 列帮助滚动和终端恢复。
- `npm run build`：通过。
- 完整集成脚本：14 项实际通过，native Windows 项在 WSL 跳过；runner 将该跳过计入 passed，输出 passed=15、failed=0。覆盖 tmux 面板切换、宽度保存、主区输入、真实滚轮与右键。
- 渲染矩阵：420 个 Monitor、840 个 Settings、216 个状态栏、15 个 Unicode/glyph 组合，共 1,491 组，没有计算宽高越界。
- Inspector 字面 ANSI 探针为空；空白行点击探针不再返回 switch；40 列状态栏探针保留上下文；真实 PTY 检查 diff 打开后只显示 Inspector，Esc 恢复原区域。

查看 [改版前](ui-audit/before.png)、[改版后](ui-audit/overview.png)、[可筛选渲染样本](ui-audit/preview.html)及[结构化结果](ui-audit/results.json)。图片使用合成数据、实际 renderer 输出和示例终端配色，不是用户 Windows Terminal 的截图。

重新生成：

```bash
npm run build
npm run build:test
node docs/reviews/ui-audit.mjs
# 可选：使用本机 libcairo 和 DejaVu Sans Mono 绘制概览，无需 Python 第三方包。
python3 docs/reviews/render-ui-preview.py
```
