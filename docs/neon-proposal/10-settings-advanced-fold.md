# 10. Settings 页把低频行折叠进「Advanced」

> **优先级**：P3（纯 UX 打磨，Owner 从 M5 候选中挑选后才排期） ｜ **类别**：面板渲染 / Settings 页 ｜ **预估规模**：S（1 个垂直切片，`settings-page.ts` 净改动 ~90–120 行 + 单测 ~80 行 + 中英 reference 各 ~6 行） ｜ **前置依赖**：无代码前置。文件冲突：`src/render/settings-page.ts` 同时是 **PRIMITIVES-04**（方案 05，改 `:130-137` 的 Model 行与模型目录）的改动文件，二者 hunk 不重叠但须串行落地；本方案刻意不改 `src/tree-page.ts`，以免与 **MCP-SPLIT-04**（方案 02 S4 把 Settings 流程迁到 `panel/settings-flow.ts`）及 **PRUNE-OBS-02..04** 冲突 ｜ **`docs/spec.md` 边界影响**：无新边界。正是 `docs/spec.md:197-199` 的 M5 候选原文 “rarely changed Settings rows fold under "Advanced"”，M5 候选未排期，**由 Owner 决定是否挑选**；落地时需同步改 `docs/reference.md:912-915` 中 “All groups are open … No Reset all, accordion or picture.” 一句

---

## 1. 背景与现状证据

### 1.1 现在 24 行全部常开

- `src/render/settings-page.ts:33`：`SettingGroup = 'Display' | 'Panel' | 'Models' | 'Codex'`。
- `src/render/settings-page.ts:49-162`：`SETTING_ROWS` 共 24 行，分为 Display 4、Panel 12、Models 7、Codex 1。
- `src/render/settings-page.ts:240-242`：渲染循环遍历全部行，每换一组插入一个小节标题，没有任何折叠。
- `src/render/settings-page.ts:381-398`：上下键、PageUp/PageDown、Home/End 都直接在 `SETTING_ROWS` 下标上移动，`selected` 就是该下标。
- `src/render/settings-page.ts:266-304`：`modelCallsPerHour` 行下方挂了「本小时调用」用量条和 `Test API` 探针行，`:314` 的滚动露出逻辑也依赖它。
- `docs/reference.md:903-915`：Settings 小节写明 “All groups are open”。

在 40 列面板里，Panel 组的 12 行会把 Models 组推出首屏。真正常改的只有主题、语言、布局、通知、模型开关这几行。

### 1.2 会被折叠影响的现有契约

| 契约 | 位置 | 折叠后的风险 |
|---|---|---|
| 按组重置 `r` | `settings-page.ts:193-198` `RESET_FIELDS`；`src/tree-page.ts:1020` 用 `SETTING_ROWS[settingsPage.selected].group` 取组 | 若引入虚拟的「Advanced」行下标，`SETTING_ROWS[length]` 是 `undefined`，`tree-page.ts:1020` 会抛错 |
| `t test` 只在 Models 组出现 | `settings-page.ts:325-326`、`:379` | 探针行跟在 `modelCallsPerHour` 下面，这一行不能折叠 |
| 面板热重载恢复 `selected/offset` | `src/tree-page.ts:640` | 恢复的 `selected` 可能落在被折叠的行上 |
| 鼠标点击行映射 | `settings-page.ts:332-333`（`rows`），`:356-363` | 折叠行必须有自己的点击目标 |
| 每行的「已改未存」`*` 和「非默认」高亮 | `settings-page.ts:243-252` | 折叠后用户看不到被藏起来的改动 |

### 1.3 不在本方案内的问题

`settings-page.ts:130-137` 的 Model 行只有 `['deepseek-v4-1-flash-1017']` 这一个值，这个问题由**方案 05 / PRIMITIVES-04**（模型目录统一）处理。另外，控制面板的 Model Picker 列的是 pi/CLI 位置的模型（`src/roles/model-discovery.ts`），不是 HUD 自己的 chat-completions 端点（`src/settings.ts:42-43,90-91`）能用的模型，**不能复用**。

---

## 2. 目标与非目标

### 目标
1. Settings 打开时，低频行默认收在每页底部一个「Advanced（n）」行之下；Enter、左右键或点击可以展开或收起。
2. 折叠状态下，如果被藏起来的行里有未保存改动或非默认值，「Advanced」行同样显示 `*` 和高亮，不会把改动藏掉。
3. 上下键、PageUp/PageDown、Home/End 只走可见行，鼠标映射同步。
4. `r`、`s`、`t`、Esc 的语义不变；在「Advanced」行上按 `r` 不做任何事（返回提示，不抛错）。

### 非目标
- 不改 Model 行和模型候选列表（归方案 05 / PRIMITIVES-04）。
- 不改 `hud-settings.json` 的格式。折叠状态只存在于本次 Settings 会话，不落盘。
- 不改 `src/tree-page.ts`，也不加「全部重置」或设置搜索。
- 不调整任何设置项的取值范围或默认值。

---

## 3. 核心设计方案

### 3.1 数据
- 在 `SettingRow`（`settings-page.ts:35-45`）加一个可选字段 `advanced?: true`，给入选的行打标。
- `SettingsPageState`（`:171-179`）加 `advanced?: boolean`，表示是否展开，缺省为收起。
- 新增常量 `ADVANCED = SETTING_ROWS.length` 作为虚拟下标，代表「Advanced」行。

**推荐的默认入选行（共 10 行，待 Owner 拍板，见 §6 Q1）：**

| 组 | 折叠 | 保留可见 |
|---|---|---|
| Display | Bar style、Icons | Theme、Language |
| Panel | Stall threshold、Fold after、Hide after、Refresh、Mouse、Experiments | Home mode、Layout、Project layout、Detail、Width、Notifications |
| Models | Decision cap、Summary interval | Model text、Model、Decision API、Call cap（挂着 Test API）、Sonic auto-thinking |
| Codex | — | Bar on launch |

### 3.2 渲染（`renderSettingsPage`，`:221-340`）
- 收起时，主列表跳过 `advanced` 行。所有组之后插入一个小节标题和一行「Advanced（n）›」，n 是被折叠的行数。
- 展开时，「Advanced」标题之下按原组顺序列出这些行，每行前缀用 `t(row.group)` 标明来源组，方便知道 `r` 会重置哪一组。
- 「Advanced」行的 `*` 和高亮复用 `:243-252` 的判断，只是对被折叠的行取 `some`。
- 所有新文案走 `t()`，并在 `src/render/i18n.ts` 补中文（遵守 `docs/ARCHITECTURE.md:423`）。

### 3.3 输入（`handleSettingsInput`，`:342-415`）
- 引入 `visible(state)`：返回当前可见的行下标，加上 `ADVANCED`。上下键、Home/End、PageUp/PageDown 改为在这个列表上移动；PageDown 仍然按组跳，「Advanced」算一组。
- 在 `ADVANCED` 上按 Enter、左右键或点击，切换 `advanced`。
- 在 `ADVANCED` 上按 `r`：不返回 `'reset'`，而是设置 `message`（“Choose a row to reset its group”）。这样 `tree-page.ts:1020` 永远拿不到虚拟下标，也就**不用改 tree-page**。
- 自愈：渲染或输入时，如果 `selected` 指向一个被折叠的行（比如热重载从 `tree-page.ts:640` 恢复），自动把 `advanced` 置为 true。热重载载荷不用加字段。

### 3.4 不变量
- `settingGroup()`（`:180-184`）已经把下标夹在合法范围内，对虚拟下标也安全。
- `RESET_FIELDS` 不动：被折叠的行仍属于原组，按 `r` 时组内的折叠行照旧一起重置，与今天的行为一致。

---

## 4. 垂直切片与实施路线

### Slice 1：Advanced 折叠（单个 imp 会话）
- **依赖**：无；建议与 PRIMITIVES-04 错开，任一方先落地即可，后者 rebase 一次。
- **改动文件**：
  1. `src/render/settings-page.ts`：给 `advanced` 打标、加虚拟行、渲染、输入（~90–120 行）。
  2. `src/render/i18n.ts`：加 2–4 条中文（“Advanced”、“{n} more”、重置提示）。
  3. `docs/reference.md:903-915`、`docs/reference.zh.md` 对应段落：删掉 “accordion” 一句，写明哪些行在 Advanced 里。
  4. `tests/unit/card-fold.test.mjs` 或新建 `tests/unit/settings-advanced.test.mjs`：见 §5.1。
- **估行**：源码 ~+110/-10，测试 ~+80，文档 ~+12/-2。
- **完成标准**：§5.1 的测试全绿；`npm test` 和 `npm run check:fixtures` 全绿；在 40 列与 100 列下，Settings 首屏能看到 Models 组。

---

## 5. 验证与验收方案

### 5.1 单测（纯函数，零 I/O，复用 `dist-test/src/render/settings-page.js`）

| # | 场景 | 断言 |
|---|---|---|
| 1 | 默认渲染，宽 40、高 24 | 不含任何 `advanced` 行的 label；含 “Advanced (10)”；每行宽度恰为 40（`visualLength`） |
| 2 | 在 Advanced 行按 Enter，再渲染 | 10 个折叠行出现，并带来源组前缀；再按 Enter 收起 |
| 3 | 草稿里改了 `refreshMs`，然后收起 | Advanced 行带 `*`；`settingsDirty` 为 true |
| 4 | 收起状态下按 down 从头走到尾 | 依次经过的下标等于可见行加 `ADVANCED`，不经过任何折叠行 |
| 5 | 在 `ADVANCED` 上按 `r` | 返回的 `action` 不是 `'reset'`；`message` 非空 |
| 6 | 构造 `selected` 指向 `cardFoldMinutes`（模拟热重载） | 渲染后 `state.advanced === true`，选中行可见 |
| 7 | 鼠标点击 Advanced 行 | 切换展开；`frame.rows` 映射到 `ADVANCED` |
| 8 | 语言为 zh | 新文案都有中文条目，配合方案 12 的检查 |

### 5.2 Owner 试用清单
- [ ] 打开 `/hud` → Settings：首屏能看到 Theme、Language、Layout、Notifications、Model text、Decision API，底部有「Advanced（10）」。
- [ ] 展开 Advanced，改 Fold after，再收起：Advanced 行出现 `*`；按 `s` 保存后 `*` 消失，卡片折叠时间生效。
- [ ] 在 Advanced 行按 `r`：只出现提示，不报错；在 Refresh 行按 `r`：Panel 组回到默认值。
- [ ] 在 Models 组按 `t`：Test API 照常工作。
- [ ] 展开 Advanced 并停在 Mouse 行，执行 `npm run build` 触发面板热重载：回到同一行，Advanced 保持展开。

---

## 6. 需要 Owner 拍板的开放问题

| # | 问题 | 推荐默认 |
|---|---|---|
| 1 | 哪些行算低频？ | §3.1 表格中的 10 行。Call cap 因为挂着 Test API 保持可见；Sonic auto-thinking 刚上线，保持可见 |
| 2 | 一个全局「Advanced」，还是每组底部各一个「更多」？ | 一个全局「Advanced」，与 spec 原文一致，实现也最简单 |
| 3 | 展开状态要不要跨次打开 Settings 记住？ | 不记住：每次打开都收起，零新增状态文件 |
