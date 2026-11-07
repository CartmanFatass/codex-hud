/** Labels for the opt-in native first line only; never global display configuration. */
export type StatuslineLanguage = 'en' | 'zh';

export const STATUSLINE_LABELS = {
  en: {
    model: 'model',
    used: 'ctx',
    cost: 'cost',
    directory: 'cwd',
    remaining: 'left',
    input: 'in',
    output: 'out',
    window: 'window',
    cacheRead: 'cache read',
    cacheWrite: 'cache write',
    duration: 'session',
    apiDuration: 'api',
    lines: 'lines',
    tokens: 'tokens',
  },
  zh: {
    model: '模型',
    used: '上下文',
    cost: '费用',
    directory: '目录',
    remaining: '剩余',
    input: '输入',
    output: '输出',
    window: '容量',
    cacheRead: '缓存读',
    cacheWrite: '缓存写',
    duration: '会话时长',
    apiDuration: 'API时长',
    lines: '改动',
    tokens: '词元',
  },
} as const;
