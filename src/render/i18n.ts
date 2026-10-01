/**
 * The tree panel's words in English or Chinese.
 *
 * The English text is the key: `t('No subagents yet')` returns it as written
 * in English, or its Chinese entry below. A missing entry falls back to the
 * English, so an untranslated string shows up in English rather than broken.
 * `{name}` placeholders are filled from `vars` after the lookup.
 *
 * Like the display config, the language is module state set once per launch
 * (and again when settings are saved): rendering is synchronous and every
 * caller wants the same answer.
 */

export type Language = 'en' | 'zh';
export type LanguageSetting = 'auto' | Language;

let current: Language = 'en';

/** `auto` follows the locale: Chinese for any zh_* locale, English otherwise. */
export function resolveLanguage(setting: LanguageSetting, env: NodeJS.ProcessEnv = process.env): Language {
  if (setting === 'en' || setting === 'zh') return setting;
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return /^zh/i.test(locale) ? 'zh' : 'en';
}

/** Sets the language and returns the previous one, so a test can restore it. */
export function setLanguage(language: Language): Language {
  const previous = current;
  current = language;
  return previous;
}

export function language(): Language {
  return current;
}

const ZH: Record<string, string> = {
  // Page frame
  ' ← Main session': ' ← 主会话',
  ' ← Main': ' ← 主会话',
  ', Settings  ?': ', 设置  ?',
  ', Settings  ? keys  1–4': ', 设置  ? 按键  1–4',
  '1 Agents': '1 Agents',
  '2 Worktrees': '2 工作树',
  '3 Changes': '3 改动',
  '4 Inspector': '4 详情',
  'Worktrees': '工作树',
  'WT': '工作树',
  'Changes': '改动',
  'Inspect': '详情',

  // Agents summary
  'failed': '失败',
  'run': '运行',
  'done': '完成',
  'unknown': '未知',
  'hide old': '收起',
  '−old': '−收起',
  '+{n} older': '+{n} 已收起',
  'No subagents yet': '还没有 subagent',
  'Reading session…': '正在读取会话…',

  // Status card
  'Status': '状态',
  ', Settings  ? keys': ', 设置  ? 按键',
  ', Settings': ', 设置',
  ', ?': ', ?',
  'Quota': '额度',
  'Output': '输出',
  'Tasks': '任务',
  'Working': '工作中',
  'Idle': '空闲',
  'Interrupted': '已中断',
  'Failed': '失败',
  'Sync delayed': '同步延迟',
  '{n}% left': '剩 {n}%',
  'reset due': '待重置',
  'approval needed': '等待批准',
  'patch approval needed': '补丁待批准',
  'input needed': '等待输入',
  '1 tool failed': '1 个工具失败',
  '{n} tools failed': '{n} 个工具失败',
  '1 agent failed': '1 个 agent 失败',
  '{n} agents failed': '{n} 个 agent 失败',
  'All finished · a shows': '全部已完成 · 按 a 显示',
  'No matching agents': '没有匹配的 agent',

  // Brief
  '─ Brief': '─ 简报',
  'writing…': '生成中…',
  'paused': '已暂停',
  'b pause': 'b 暂停',
  'b resume': 'b 继续',
  'b pause / resume brief': 'b 暂停 / 继续简报',

  // Inspector, agent
  'Select an agent': '选择一个 agent',
  'Ctx': '上下文',
  'running': '运行中',
  'starting': '启动中',
  'completed': '已完成',
  'error': '出错',
  'Previous turn': '上一轮',
  'Latest update': '最新说明',
  'Task': '任务',
  'Turn age: {age}': '本轮时长：{age}',
  'Last activity: {age}': '最近活动：{age}',
  ' (quiet)': '（静默）',
  'Nickname: {name}': '昵称：{name}',
  'Role: {role}': '角色：{role}',
  'Turn start: {at}': '本轮开始：{at}',
  'v More': 'v 更多',
  'v Less': 'v 收起',

  // Worktrees and changes
  'Reading worktrees…': '正在读取工作树…',
  'No readable repository': '没有可读的仓库',
  'Set worktreeRoot': '请设置 worktreeRoot',
  'Worktree list limited': '工作树列表已截断',
  'No worktrees recorded': '没有工作树记录',
  'Reading selected worktree…': '正在读取所选工作树…',
  'Git incomplete': 'Git 信息不完整',
  'No selected worktree': '未选择工作树',
  '! {n} conflicts': '! {n} 处冲突',
  '{n} files · {s} staged · {u} unstaged': '{n} 个文件 · {s} 已暂存 · {u} 未暂存',
  'Status unknown': '状态未知',
  'Working tree clean': '工作树干净',
  'Select a worktree': '选择一个工作树',
  'Branch: {branch}': '分支：{branch}',
  'Status: {status}': '状态：{status}',
  'Locked: {reason}': '已锁定：{reason}',
  'Prunable: {reason}': '可清理：{reason}',
  '{s} staged / {u} unstaged': '{s} 已暂存 / {u} 未暂存',
  '{n} untracked / {c} conflicts': '{n} 未跟踪 / {c} 冲突',
  'Ahead {a} / behind {b}': '领先 {a} / 落后 {b}',
  'Workspace status, not agent ownership': '这是工作区状态，不代表归属哪个 agent',
  'No selected file': '未选择文件',
  'Reading diff…': '正在读取 diff…',
  'bare': '裸仓库',
  'prunable': '可清理',
  'unreadable': '不可读',
  'stale': '过期',
  'clean': '干净',
  '{n} mod': '{n} 改动',
  'detached': '分离',
  'yes': '是',

  // Help
  'Monitor keys': '快捷键',
  '↑↓ {at}/{total} Esc back': '↑↓ {at}/{total} Esc 返回',
  '1 Agents  2 Worktrees': '1 Agents  2 工作树',
  '3 Changes  4 Inspector': '3 改动  4 详情',
  'x close pane  - fold': 'x 关闭面板  - 折叠',
  '2–4 open a pane': '2–4 打开面板',
  'Tab next visible pane': 'Tab 下一个面板',
  'j/k select  o switch': 'j/k 选择  o 切换会话',
  'Click agent: switch': '点击 agent：切换会话',
  'm return Main': 'm 回到主会话',
  'a show/hide older': 'a 显示/收起已完成',
  'Enter / v inspect': 'Enter / v 查看详情',
  'v more / less details': 'v 展开 / 收起详情',
  'z zoom  Esc back': 'z 放大  Esc 返回',
  'q close tree  , settings': 'q 关闭侧栏  , 设置',
  '✓ = turn completed': '✓ = 本轮已完成',
  '? = no status evidence': '? = 没有状态依据',
  '! = needs a look': '! = 需要留意',
  '{clocks} turn <1m, the quarter hour, 1h+': '{clocks} 本轮 <1分钟、所在刻钟、1小时+',
  'yellow clock = quiet 5m+': '黄色时钟 = 静默 5 分钟以上',
  '━╸─ = agent context used': '━╸─ = agent 已用上下文',
  'dim name = done 1m+ ago': '名字变暗 = 完成已超 1 分钟',
  'mod / Δ = changed files': 'mod / Δ = 改动的文件',
  'S staged · U unstaged': 'S 已暂存 · U 未暂存',
  'L = locked worktree': 'L = 已锁定的工作树',
  'stale = >30s since read': '过期 = 超过 30 秒未读取',

  // Tree page messages
  'Switching Codex session…': '正在切换 Codex 会话…',
  'Switch failed: {reason}': '切换失败：{reason}',
  'Settings: {reason}': '设置：{reason}',
  'Refresh: {reason}': '刷新：{reason}',
  'Panel preferences could not be saved: {reason}': '面板偏好无法保存：{reason}',
  'Saved': '已保存',
  'Save failed: {reason}': '保存失败：{reason}',
  'Defaults ready; Save to apply': '已恢复默认值，保存后生效',

  // Settings page frame
  '[Back]': '[返回]',
  '[Save]': '[保存]',
  '[Reset]': '[重置]',
  'Settings': '设置',
  '↑↓ select ←→ change s save': '↑↓ 选择 ←→ 修改 s 保存',
  '↑↓ select  ←→ change  s save  r reset  Esc back': '↑↓ 选择  ←→ 修改  s 保存  r 重置  Esc 返回',

  // Settings groups, labels and help
  'Status bar': '状态栏',
  'Panel': '面板',
  'Density': '密度',
  'How much the bar shows': '状态栏显示多少内容',
  'Theme': '主题',
  'Colours of bar and panel': '状态栏和侧栏的配色',
  'Model label': '模型标签',
  'Model': '模型',
  'Model as glyph, text, both': '模型显示为符号、文字或两者',
  'Motion': '动效',
  'Reduced keeps spinners still': '减少后转圈动画不动',
  'Context': '上下文',
  'Meter counts used or left': '计量显示已用或剩余',
  'Bar on launch': '启动时显示状态栏',
  'Bar': '状态栏',
  'Next launch: one-line bar': '下次启动时显示单行状态栏',
  'Order': '排序',
  'Running first, or by age': '运行中优先，或按创建时间',
  'Hide finished': '收起已完成',
  'Hide': '收起',
  'Done agents hide after this': '完成后多久收起',
  'Brief': '简报',
  'Model brief under the tree': 'tree 下方的模型简报',
  'Brief every': '简报间隔',
  'Every': '间隔',
  'At most this often, on change': '有变化时，最多这么频繁',
  'Language': '语言',
  'Lang': '语言',
  'Panel and brief language': '侧栏和简报的语言',
  'Decoration': '装饰',
  'Art': '装饰',
  'Picture in empty space; codex-hud-art sets it': '空白处的字符画；用 codex-hud-art 设置图片',
  'dots': '点阵',
  'color': '彩色点阵',
  'ascii': 'ASCII',
  'api': 'API',
  '2 Trees': '2 工作树',
  '3 Files': '3 改动',
  '4 Info': '4 详情',
  'Open, folded, or closed': '打开、折叠或关闭',
  'Width': '宽度',
  'Panel columns': '侧栏宽度',
  'Mouse': '鼠标',
  'Click and scroll the panel': '在侧栏中点击和滚动',
  'Refresh': '刷新',
  'How often the panel reads': '侧栏多久读取一次',

  // Settings values
  'on': '开',
  'off': '关',
  'never': '从不',
  'focus': '专注',
  'balanced': '均衡',
  'full': '完整',
  'terminal': '终端',
  'none': '无',
  'glyph': '符号',
  'text': '文字',
  'both': '两者',
  'reduced': '减少',
  'used': '已用',
  'remaining': '剩余',
  'active': '运行优先',
  'created': '创建时间',
  'open': '打开',
  'folded': '折叠',
  'closed': '关闭',
  'narrow': '窄',
  'auto': '自动',
  'wide': '宽',
  'wider': '更宽',
  'en': 'English',
  'zh': '中文',
};

const EN_OVERRIDES: Record<string, string> = {
  // Setting values whose stored form is not a word in either language.
  en: 'English',
  zh: '中文',
};

export function t(text: string, vars?: Record<string, string | number>): string {
  const template = current === 'zh' ? ZH[text] ?? text : EN_OVERRIDES[text] ?? text;
  return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match) : template;
}
