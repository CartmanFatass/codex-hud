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

import { WORKBOARD_ZH } from './workboard-i18n.js';

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
  ...WORKBOARD_ZH,
  outcome: '结果',
  kind: '类型',
  category: '类别',
  findings: '发现',
  partial: '部分完成',
  looping: '反复失败',
  ui: '界面',
  'bug fix': '修复缺陷',
  feature: '功能',
  refactor: '重构',
  research: '研究',
  docs: '文档',
  chore: '杂务',
  'design trade-off': '设计权衡',
  clarification: '澄清',
  'owner authorisation': '需要授权',
  'must fix': '必须修复',
  'should fix': '应该修复',
  optional: '可选',
  stopped: '已停止',
  'Model text': '模型文字',
  'Decision API': '决策 API',
  'Home mode': '首页模式',
  'Decision cap': '决策调用上限',
  'Decision calls this hour': '本小时决策调用',
  'Job sentence': '任务句子',
  'Native sentence': '原生句子',
  'Decision title': '决定标题',
  'Home brief': '首页简报',
  Probe: '测试',
  'Question category': '问题类别',
  'Review severity': '评审严重度',
  'Home ranking': '首页排序',
  'Quiet job': '静默任务',
  quiet: '静默判定',
  'still-working': '仍在工作',
  'finished-no-report': '未写报告已结束',
  'needs-human': '需要人工处理',
  wait: '继续等待',
  'prompt-report': '催写报告',
  fail: '标记失败',
  'no key': '无 key',
  cap: '已达上限',
  'max questions': '已达询问上限',
  'prompt failed': '发送提示失败',
  'Earlier format': '早期格式',
  unlimited: '无上限',
  'Summary interval': '总结间隔',
  "How often a running job's sentence and Home's brief may refresh": '运行中任务句子和首页简报可刷新的间隔',
  'LLM calls per hour (sentences, titles, brief)': '每小时 LLM 调用次数（句子、标题、简报）',
  'Decision-API calls per hour (labels, Home ranking)': '每小时决策 API 调用次数（标签、首页排序）',
  'at the cap: labels wait': '已达上限：标签暂不更新',
  Default: '默认',
  Recommended: '模型推荐',
  'Rank Home cards and show a progress brief through models': '模型排序首页卡片并显示进度简报',
  '(no key)': '（无 key）',
  'Primary for Jev and display labels; automatic fallback uses another keyed provider': 'Jev 和显示标签共用的首选 API；自动回退到有 key 的其他提供方',
  'Sends public agent material for display text; off sends nothing': '发送 agent 公开材料以生成显示文字；关闭时不发送',
  'Chat-completions model; edit model in hud-settings.json for another ID':
    '聊天补全模型；在 hud-settings.json 的 model 中填写其他模型 ID',
  truncated: '已截断',
  Close: '关闭',
  Back: '返回',
  'Model summaries unavailable': '模型摘要不可用',
  working: '工作中',
  session: '会话绑定',
  rollout: '会话事件',
  tree: 'Agent 树',
  git: 'Git',
  worktrees: '工作树',
  'TPS sample: timestamp is ahead of observation': '速度采样：时间戳晚于观察时间',
  'Authentication failed': '鉴权失败',
  'Rate limited': '请求被限流',
  'Request timed out': '请求超时',
  'Connection failed': '连接失败',
  'Service unavailable': '服务不可用',
  'Invalid response': '回复格式无效',
  'Reply not in the panel language': '回复不是面板语言',
  'Output limit reached': '输出达到上限',
  'Model output limit reached': '模型输出达到上限',
  'Call cap reached': '调用已达上限',
  'Budget store unavailable': '调用计数不可用',
  'No Codex session bound': '尚未绑定 Codex 会话',
  'Session read failed; showing last data': '会话读取失败，保留上次数据',
  'Herdr bridge not responding': 'Herdr 桥接未响应',
  'Herdr state differs from Codex': 'Herdr 与 Codex 状态不一致',
  'Herdr bridge disconnected': 'Herdr 桥接已断连',
  'Codex state probe retrying': '正在重试读取 Codex 状态',
  'Herdr reconnected; earlier notifications unverified': 'Herdr 已重连，离线期间通知未确认',
  'Model authentication failed': '模型鉴权失败',
  'Model not found': '模型不存在',
  'Model rate limited': '模型请求被限流',
  'Model request timed out': '模型请求超时',
  'Model connection failed': '模型连接失败',
  'Model service unavailable': '模型服务不可用',
  'Model response invalid': '模型回复格式无效',
  'Hourly model call cap reached': '已达每小时模型调用上限',
  'Model budget store unavailable': '模型调用计数不可用',
  'Model request failed': '模型请求失败',
  'Model queue: {n}': '模型排队：{n} 项',
  'Model is still responding': '模型仍在响应',
  'TPS: no sample yet': '输出速度：暂无采样',
  'TPS sample: previous turn': '速度采样：上一轮',
  'TPS sample: current turn, recent': '速度采样：本轮近期',
  'TPS sample: last measurement': '速度采样：上次测量',
  'Estimated output: {rate}': '估算输出：{rate}',
  'Sampled at: {at}': '采样时间：{at}',
  'Sample duration: {seconds}s': '样本时长：{seconds} 秒',
  'Turn estimate includes initial delay and stalls; excludes known tool waits. Not exact request throughput.':
    '按回合估算，包含首字等待和生成停顿，扣除可识别的工具等待；不是精确的单次请求吞吐。',
  'Connection test failed': '连接测试失败',
  waiting: '等待中',
  ok: '通过',
  cancelled: '已取消',
  // Page frame
  Worktrees: '工作树',
  Changes: '改动',
  Inspect: '详情',

  // Agents summary
  failed: '失败',
  run: '运行',
  done: '完成',
  reviews: '评审',
  unknown: '未知',
  '+{n} older': '+{n} 已收起',
  Main: '主会话',

  // Status card
  Status: '状态',
  Quota: '额度',
  Output: '输出',
  Working: '工作中',
  Idle: '空闲',
  Failed: '失败',
  'approval needed': '等待批准',
  'patch approval needed': '补丁待批准',
  'input needed': '等待输入',
  '1 tool': '1 个工具',
  '1 agent': '1 个 agent',
  '1 subtask': '1 个子任务',
  '{list} failed': '{list} 失败',

  // Brief
  paused: '已暂停',
  started: '已开始',
  finished: '已完成',
  Log: '日志',
  'just now': '刚刚',
  'Basis:': '依据：',
  Goal: '目标',
  Done: '已完成',
  Now: '现在',
  Needs: '需要你',
  '{age} ago': '{age}前',
  'Model call cap reached ({n} per hour)': '模型调用已达上限（每小时 {n} 次）',

  // Inspector, agent
  Out: '输出',
  Tokens: '用量',
  in: '输入',
  out: '输出',
  running: '运行中',
  starting: '启动中',
  completed: '已完成',
  error: '出错',
  Task: '任务',

  // Worktrees and changes
  'No readable repository': '没有可读的仓库',
  'Worktree list limited': '工作树列表已截断',
  'Git incomplete': 'Git 信息不完整',
  dirty: '有改动',
  bare: '裸仓库',
  prunable: '可清理',
  unreadable: '不可读',
  stale: '过期',
  clean: '干净',
  detached: '分离',
  locked: '锁定',
  yes: '是',

  // Help
  // Round 3: the prefix, the buttons, the help's sections
  Help: '帮助',
  older: '已收起',
  Resume: '继续',
  Switch: '切换',
  Keys: '按键',
  '↑↓ select  ←→ change': '↑↓ 选择  ←→ 修改',

  // Tree page messages
  'Settings: {reason}': '设置：{reason}',
  'Refresh: {reason}': '刷新：{reason}',
  'Panel preferences could not be saved: {reason}': '面板偏好无法保存：{reason}',
  Saved: '已保存',
  'new build failed to load': '新构建加载失败',
  'Save failed: {reason}': '保存失败：{reason}',

  // Settings page: whether the panel's reads go through
  'Session read': '读取会话',
  Git: 'Git',

  // Settings page frame
  Settings: '设置',

  // Settings groups, labels and help
  Display: '显示',
  Panel: '面板',
  Agents: 'Agent',
  'Panel and everything a model writes': '侧栏和模型写的全部内容',
  agents: '代理',
  main: '主会话',
  'Approvals, failures: tmux, or desktop too': '待批准、失败时提示：tmux，或同时桌面',
  'tmux + desktop': 'tmux + 桌面',
  Theme: '主题',
  'Colours of bar and panel': '状态栏和侧栏的配色',
  Model: '模型',
  Context: '上下文',
  'Bar on launch': '启动时显示状态栏',
  'Next launch: one-line bar': '下次启动时显示单行状态栏',
  Notifications: '通知',
  Hide: '收起',
  Backend: '后端',
  'Call cap': '调用上限',
  Language: '语言',
  Icons: '图标',
  api: 'API',
  '+{n} more': '另 {n} 个',
  Width: '宽度',
  'Panel columns for every client; the agent pane keeps 41': '所有客户端的侧栏列数；智能体窗格至少留 41 列',
  '{n} cols': '{n} 列',
  Mouse: '鼠标',
  'Click and scroll the panel': '在侧栏中点击和滚动',
  'Prefix key': '前缀键',
  'Then a key: a panel command. Codex uses Ctrl+] for Skip Question': '再按一键执行侧栏命令。Codex 用 Ctrl+] 跳过提问',
  Refresh: '刷新',
  'How often the panel reads': '侧栏多久读取一次',

  // Safe settings navigation
  'Save your changes before leaving?': '离开前要保存这些修改吗？',
  'Save and leave': '保存并离开',
  'Discard changes': '放弃修改',
  'Continue editing': '继续编辑',
  Save: '保存',
  Discard: '放弃',
  Stay: '继续',
  'Could not save settings': '无法保存设置',
  'Group defaults ready; Save to apply': '当前分组已恢复默认；保存后生效',
  'Model generation disabled; connection preserved; Save to apply': '模型生成已关闭；保留连接，保存后生效',

  // Presets and group resets
  Preset: '预设',
  minimal: '极简',
  progress: '进度',
  monitor: '监控',
  custom: '自定义',

  // Model summary lifecycle and evidence timestamps
  'Model summary': '模型总结',
  queued: '排队中',
  writing: '生成中',
  'up to date': '已更新',
  'model backend off': '模型后端已关闭',

  // Card display, independent model generators and dependency reasons
  Cards: '卡片',
  Label: '标签',
  Summary: '总结',
  Scope: '范围',
  live: '运行中',
  important: '重要',
  all: '全部',

  // Settings values
  on: '开',
  off: '关',
  focus: '专注',
  balanced: '均衡',
  full: '完整',
  terminal: '终端',
  titanium: '钛金',
  mocha: '摩卡',
  arctic: '极地',
  ember: '余烬',
  contrast: '高对比',
  latte: '拿铁',
  paper: '纸白',
  none: '无',
  glyph: '符号',
  text: '文字',
  both: '两者',
  reduced: '减少',
  used: '已用',
  remaining: '剩余',
  open: '打开',
  closed: '关闭',
  narrow: '窄',
  auto: '自动',
  wide: '宽',
  wider: '更宽',
  en: 'English',
  zh: '中文',
  // The delegation view's state words (design §3.3, §5.5). The bar says them in English.
  approval: '审批',
  question: '提问',
  'needs human': '需要人',
  blocked: '受阻',
  conflict: '记录冲突',
  uncertain: '未确定',
  interrupted: '已中断',
  cancelling: '取消中',
  'not loaded': '未加载',
  exited: '已退出',
  ended: '已结束',
  reported: '已报告',
  // §3.3 row 10 defines the word `idle`; §5.5 left it out of its table (rulings B10b s1, Q2).
  idle: '空闲',
  slots: '槽',
  'to close': '待关闭',
  pane: '窗格',
  headless: '无界面',
  'still running': '仍在运行',
  // The delegation panel (design §3.4, §3.5, §4.2, §4.6, §5.5; rulings B10B-s2).
  handshake: '握手',
  claimed: '已声明',
  bound: '已绑定',
  '{n} not loaded': '{n} 未加载',
  'tree partial': '树不完整',
  parent: '父',
  unconfirmed: '未确认',
  continue: '继续',
  stop: '停止',
  // The control bar's buttons for the selected delegation row, and the keys that go with them (design §3.7, §5.5;
  // rulings B10B-s3). `Switch` and `Log` are the words above.
  Open: '打开',
  Reconcile: '对账',
  // Jobs: facade jobs, their helpers and registered external herdr tasks. Row words first, then the Inspector's sections.
  unavailable: '不可用',
  herdr: 'herdr',
  Job: '任务',
  'role job': '角色任务',
  helper: '辅助',
  'external task': '外部任务',
  Kind: '类型',
  Id: '编号',
  Role: '角色',
  Phase: '阶段',
  Executor: '执行器',
  Harness: '宿主',
  Recipe: '启动方式',
  Decision: '决策',
  Observed: '观测到',
  Checked: '检查于',
  Location: '位置',
  Lifecycle: '生命周期',
  'Runtime phase': '运行阶段',
  Outcome: '结果',
  Created: '创建',
  Closed: '关闭',
  'tab {id}': '标签页 {id}',
  'pane {id}': '窗格 {id}',
  'agent {id}': '代理 {id}',
  'workspace {id}': '工作区 {id}',
  'Judge verdicts': '判定结果',
  pass: '通过',
  deny: '拒绝',
  unsettled: '未定',
  timeout: '超时',
  Requests: '请求',
  unanswered: '未回答',
  'answer written, consumption unconfirmed': '答案已写入，未确认被读取',
  current: '当前',
  historical: '历史',
  Report: '报告',
  Availability: '可读性',
  available: '可读',
  'not written': '尚未写入',
  Freshness: '时效',
  State: '状态',
  Reason: '原因',
  'Last known': '最后已知',
  'Last read': '最近读取',
  Evidence: '依据',
  'Live window': '存活窗口',
  'ends in {age}': '{age}后结束',
  'ended {age} ago': '{age}前已结束',
  Helpers: '辅助任务',
  Diagnostics: '诊断',
  'needs a native session ref': '需要原生会话引用',
  'requires authorization': '需要授权',
  '{label}: {value}': '{label}：{value}',
};

const EN_OVERRIDES: Record<string, string> = {
  // Setting values whose stored form is not a word in either language.
  en: 'English',
  zh: '中文',
};

export function t(text: string, vars?: Record<string, string | number>): string {
  const template = current === 'zh' ? (ZH[text] ?? text) : (EN_OVERRIDES[text] ?? text);
  return vars
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
    : template;
}
