/**
 * ANSI color and style utilities for terminal rendering
 * Phase 3: Enhanced to match claude-hud style exactly
 */

// ANSI escape codes
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;

// Foreground colors
export const colors = {
  // Basic colors
  black: (text: string) => `${ESC}30m${text}${RESET}`,
  red: (text: string) => `${ESC}31m${text}${RESET}`,
  green: (text: string) => `${ESC}32m${text}${RESET}`,
  yellow: (text: string) => `${ESC}33m${text}${RESET}`,
  blue: (text: string) => `${ESC}34m${text}${RESET}`,
  magenta: (text: string) => `${ESC}35m${text}${RESET}`,
  cyan: (text: string) => `${ESC}36m${text}${RESET}`,
  white: (text: string) => `${ESC}37m${text}${RESET}`,
  
  // Bright colors
  brightBlack: (text: string) => `${ESC}90m${text}${RESET}`,
  brightRed: (text: string) => `${ESC}91m${text}${RESET}`,
  brightGreen: (text: string) => `${ESC}92m${text}${RESET}`,
  brightYellow: (text: string) => `${ESC}93m${text}${RESET}`,
  brightBlue: (text: string) => `${ESC}94m${text}${RESET}`,
  brightMagenta: (text: string) => `${ESC}95m${text}${RESET}`,
  brightCyan: (text: string) => `${ESC}96m${text}${RESET}`,
  brightWhite: (text: string) => `${ESC}97m${text}${RESET}`,
  
  // Semantic colors
  dim: (text: string) => `${ESC}2m${text}${RESET}`,
  bold: (text: string) => `${ESC}1m${text}${RESET}`,
  italic: (text: string) => `${ESC}3m${text}${RESET}`,
  underline: (text: string) => `${ESC}4m${text}${RESET}`,
};

// Semantic aliases for HUD components (claude-hud style)
export const theme = {
  // Model and primary info
  model: colors.brightCyan,
  modelBracket: colors.cyan,
  
  // Git status (oh-my-zsh style)
  gitBranch: colors.magenta,
  gitClean: colors.green,
  gitDirty: colors.yellow,
  gitAhead: colors.green,
  gitBehind: colors.red,
  gitPrefix: colors.magenta,  // "git:(" prefix
  
  // Project info
  projectName: colors.yellow,  // Changed to yellow like claude-hud
  projectPath: colors.dim,
  
  // Status indicators
  success: colors.green,
  warning: colors.yellow,
  error: colors.red,
  info: colors.cyan,
  
  // Separators and decorations
  separator: colors.dim,
  label: colors.dim,
  value: colors.white,
  dim: colors.dim,
  
  // Context bar colors (based on percentage)
  contextSafe: colors.green,      // < 70%
  contextWarning: colors.yellow,  // 70-84%
  contextDanger: colors.red,      // >= 85%
  
  // Tool activity
  toolRunning: colors.brightYellow,
  toolCompleted: colors.green,
  toolError: colors.red,
  toolName: colors.cyan,
  toolTarget: colors.dim,
  
  // Agent activity
  agentType: colors.brightMagenta,
  agentRunning: colors.brightYellow,
  agentCompleted: colors.green,
  
  // Plan/Todo progress
  planProgress: colors.brightMagenta,
  planStepCompleted: colors.green,
  planStepPending: colors.dim,
  planStepInProgress: colors.yellow,
  
  // Token usage
  tokenCount: colors.brightBlue,
  tokenWarning: colors.yellow,
  tokenDanger: colors.red,
};

// Progress bar characters
export const progressChars = {
  filled: '█',
  empty: '░',
  half: '▓',
};

// Status icons
export const icons = {
  // Git
  dirty: '*',
  ahead: '↑',
  behind: '↓',
  modified: '!',
  added: '+',
  deleted: '✘',
  untracked: '?',
  
  // Activity
  check: '✓',
  cross: '✗',
  running: '▸',
  starting: '·',
  spinner: ['▸', '▹', '▸', '▹'],
  
  // Info
  clock: '⏱️',
  folder: '📁',
  file: '📄',
  tokens: '🎫',
  plan: '📝',
  tools: '🔧',
  arrow: '→',
  bullet: '▸',
  multiply: '×',
  refresh: '↻',  // For compact count indicator
  
  // Separators
  pipe: '|',
  bar: '│',
};

/**
 * Strip ANSI codes to get visual length
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// Terminal display width per code point (wcwidth-style, pragmatic subset of
// Unicode East Asian Width): wide CJK blocks, Hangul, and emoji pictographs
// occupy 2 columns; combining marks and zero-width code points occupy 0;
// everything else 1. "Ambiguous"-width characters count as 1 column.
const ZERO_WIDTH_RANGES: Array<[number, number]> = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x200b, 0x200f], // Zero-width space/joiners and directional marks
  [0x20d0, 0x20f0], // Combining Marks for Symbols
  [0xfe00, 0xfe0f], // Variation Selectors
  [0xfeff, 0xfeff], // BOM
];

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals .. CJK Symbols and Punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical Forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth Signs
  [0x1f300, 0x1f64f], // Emoji Pictographs
  [0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
  [0x20000, 0x2fffd], // CJK Extension B
  [0x30000, 0x3fffd], // CJK Extension G
];

function codePointWidth(codePoint: number): number {
  for (const [lo, hi] of ZERO_WIDTH_RANGES) {
    if (codePoint >= lo && codePoint <= hi) {
      return 0;
    }
  }
  for (const [lo, hi] of WIDE_RANGES) {
    if (codePoint >= lo && codePoint <= hi) {
      return 2;
    }
  }
  return 1;
}

/**
 * Get the display width of text in terminal columns, excluding ANSI SGR
 * sequences. East Asian wide characters and emoji count as 2 columns and
 * combining marks as 0, so CJK nicknames no longer overflow padded or
 * truncated panel lines.
 */
export function visualWidth(text: string): number {
  let width = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\x1b' && text[i + 1] === '[') {
      const end = text.indexOf('m', i + 2);
      if (end === -1) {
        break;
      }
      i = end + 1;
      continue;
    }
    const codePoint = text.codePointAt(i) ?? 0;
    width += codePointWidth(codePoint);
    i += codePoint > 0xffff ? 2 : 1;
  }
  return width;
}

/**
 * Get visual length of text in terminal columns (excluding ANSI codes).
 */
export function visualLength(text: string): number {
  return visualWidth(text);
}

/**
 * Pad text to specified width (accounting for ANSI codes)
 */
export function padEnd(text: string, width: number): string {
  const currentLength = visualLength(text);
  if (currentLength >= width) return text;
  return text + ' '.repeat(width - currentLength);
}

/**
 * Spread segments across the full width (first left, last right).
 */
export function spreadAcross(parts: Array<string | null | undefined>, width: number): string {
  const items = parts.filter((part): part is string => Boolean(part && visualLength(part) > 0));
  if (items.length === 0 || width <= 0) {
    return '';
  }
  if (items.length === 1) {
    return items[0];
  }

  const contentWidth = items.reduce((sum, item) => sum + visualLength(item), 0);
  const gaps = items.length - 1;
  const leftover = width - contentWidth;

  if (leftover < gaps) {
    return truncateAnsi(items.join(' '), width);
  }

  const base = Math.floor(leftover / gaps);
  const extra = leftover % gaps;
  let out = items[0];
  for (let i = 1; i < items.length; i++) {
    out += ' '.repeat(base + (i <= extra ? 1 : 0)) + items[i];
  }
  return out;
}

/**
 * Truncate text to specified width (accounting for ANSI codes)
 */
export function truncate(text: string, maxWidth: number, ellipsis = '…'): string {
  const stripped = stripAnsi(text);
  if (stripped.length <= maxWidth) return text;
  return stripped.slice(0, maxWidth - ellipsis.length) + ellipsis;
}

/**
 * Truncate text to a visual column width while preserving ANSI sequences.
 * Never splits a wide character: the result is at most maxWidth columns
 * including the ellipsis.
 */
export function truncateAnsi(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (visualWidth(text) <= maxWidth) return text;

  const ellipsisWidth = codePointWidth(ellipsis.codePointAt(0) ?? 0);
  const limit = Math.max(0, maxWidth - ellipsisWidth);
  let out = '';
  let visible = 0;
  let i = 0;
  let sawAnsi = false;

  while (i < text.length && visible < limit) {
    const ch = text[i];
    if (ch === '\x1b' && text[i + 1] === '[') {
      const end = text.indexOf('m', i + 2);
      if (end === -1) {
        break;
      }
      out += text.slice(i, end + 1);
      sawAnsi = true;
      i = end + 1;
      continue;
    }
    const codePoint = text.codePointAt(i) ?? 0;
    const charWidth = codePointWidth(codePoint);
    if (visible + charWidth > limit) {
      break;
    }
    const size = codePoint > 0xffff ? 2 : 1;
    out += text.slice(i, i + size);
    visible += charWidth;
    i += size;
  }

  const truncated = out + ellipsis;
  if (!sawAnsi) return truncated;
  return truncated + RESET;
}

/**
 * Get the appropriate color function based on context usage percentage
 */
export function getContextColor(percent: number): (text: string) => string {
  if (percent >= 85) {
    return theme.contextDanger;
  } else if (percent >= 70) {
    return theme.contextWarning;
  }
  return theme.contextSafe;
}

/**
 * Create a colored progress bar with percentage-based coloring
 * Matches claude-hud style exactly
 */
export function coloredBar(percent: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  
  const colorFn = getContextColor(clamped);
  
  const filledStr = progressChars.filled.repeat(filled);
  const emptyStr = progressChars.empty.repeat(empty);
  
  return colorFn(filledStr) + colors.dim(emptyStr);
}

/**
 * Create a progress bar (legacy - for non-context bars)
 */
export function progressBar(percent: number, width: number = 10): string {
  return coloredBar(percent, width);
}

/**
 * Format percentage with color based on threshold
 */
export function coloredPercent(percent: number): string {
  const colorFn = getContextColor(percent);
  return colorFn(`${Math.round(percent)}%`);
}

/**
 * Create a separator line
 */
export function separator(width: number): string {
  return colors.dim('─'.repeat(width));
}

/**
 * Get current spinner frame based on time
 */
export function getSpinnerFrame(frameIndex?: number): string {
  const frames = icons.spinner;
  const idx = frameIndex ?? Math.floor(Date.now() / 100) % frames.length;
  return frames[idx];
}
