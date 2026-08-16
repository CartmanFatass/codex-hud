/**
 * Activity Line Renderer
 * Renders: ◐ Edit: file.ts | ✓ Read ×3
 * Shows current and recent tool/agent activity
 */

import { theme, colors, icons, getSpinnerFrame, truncate } from '../colors.js';
import type { HudData, ToolActivity, ToolCall, PlanProgress } from '../../types.js';

/**
 * Truncate a target string for display
 */
function truncateTarget(target: string, maxLen: number = 20): string {
  if (target.length <= maxLen) {
    return target;
  }
  // For file paths, show the end
  if (target.includes('/')) {
    const parts = target.split('/');
    const filename = parts[parts.length - 1];
    if (filename.length <= maxLen) {
      return '…/' + filename;
    }
    return '…' + filename.slice(-(maxLen - 1));
  }
  return target.slice(0, maxLen - 1) + '…';
}

/**
 * Group consecutive calls by tool name and count them
 * Returns array of { name, count, status }
 */
function groupToolCalls(calls: ToolCall[]): Array<{ name: string; count: number; status: 'completed' | 'error' }> {
  const groups: Array<{ name: string; count: number; status: 'completed' | 'error' }> = [];
  
  // Only look at completed/error calls for grouping
  const finishedCalls = calls.filter(c => c.status === 'completed' || c.status === 'error');
  
  for (const call of finishedCalls) {
    const last = groups[groups.length - 1];
    const status = call.status === 'error' ? 'error' : 'completed';
    
    if (last && last.name === call.name && last.status === status) {
      last.count++;
    } else {
      groups.push({ name: call.name, count: 1, status });
    }
  }
  
  return groups;
}

/**
 * Render the tools activity line
 * Format: ◐ Edit: file.ts | ✓ Read ×3 | ✓ Bash ×2
 */
export function renderToolsLine(toolActivity: ToolActivity | undefined): string | null {
  if (!toolActivity || toolActivity.recentCalls.length === 0) {
    return null;
  }
  
  const parts: string[] = [];
  
  // Currently running tool (if any)
  const running = toolActivity.recentCalls.filter(c => c.status === 'running');
  if (running.length > 0) {
    const current = running[running.length - 1];
    const spinner = getSpinnerFrame();
    const targetStr = current.target ? `: ${truncateTarget(current.target)}` : '';
    parts.push(theme.toolRunning(`${spinner} ${current.name}${targetStr}`));
  }
  
  // Group completed calls
  const groups = groupToolCalls(toolActivity.recentCalls);
  
  // Render grouped calls (limit to last 5 groups)
  const recentGroups = groups.slice(-5);
  for (const group of recentGroups) {
    const icon = group.status === 'error' ? icons.cross : icons.check;
    const colorFn = group.status === 'error' ? theme.error : theme.success;
    
    if (group.count > 1) {
      parts.push(colorFn(`${icon} ${group.name} ${icons.multiply}${group.count}`));
    } else {
      parts.push(colorFn(`${icon} ${group.name}`));
    }
  }
  
  // Show total if more calls exist
  if (toolActivity.totalCalls > toolActivity.recentCalls.length) {
    parts.push(colors.dim(`(${toolActivity.totalCalls} total)`));
  }
  
  if (parts.length === 0) {
    return null;
  }
  
  return parts.join(` ${colors.dim(icons.bar)} `);
}

/**
 * Render the todos/plan progress line
 * Format: 📝 3/7 steps | ✓ Task 1 | ◐ Task 2
 */
export function renderTodosLine(planProgress: PlanProgress | undefined): string | null {
  if (!planProgress) {
    return null;
  }
  
  const parts: string[] = [];
  
  // Overall progress (if steps exist)
  if (planProgress.totalSteps > 0) {
    const { completedSteps, totalSteps } = planProgress;
    parts.push(theme.planProgress(`${icons.plan} ${completedSteps}/${totalSteps}`));
  }
  
  // Current step (if in progress)
  const inProgressSteps = planProgress.steps.filter(s => s.status === 'in_progress');
  if (inProgressSteps.length > 0) {
    const current = inProgressSteps[0];
    const spinner = getSpinnerFrame();
    const stepText = truncate(current.step, 30);
    parts.push(theme.planStepInProgress(`${spinner} ${stepText}`));
  }
  
  // Recent completed steps (last 2)
  const completedSteps = planProgress.steps.filter(s => s.status === 'completed').slice(-2);
  for (const step of completedSteps) {
    const stepText = truncate(step.step, 20);
    parts.push(theme.planStepCompleted(`${icons.check} ${stepText}`));
  }
  
  if (parts.length === 0) {
    return null;
  }
  
  return parts.join(` ${colors.dim(icons.bar)} `);
}

/**
 * Collect all activity lines (tools + todos)
 */
export function formatTokenCount(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return value.toString();
}

/**
 * Render a colored progress bar for context usage
 */
function renderContextProgressBar(percent: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  
  const filledChar = '█';
  const emptyChar = '░';
  
  let colorFn: (s: string) => string;
  if (clamped >= 85) {
    colorFn = theme.error;
  } else if (clamped >= 70) {
    colorFn = theme.warning;
  } else {
    colorFn = theme.success;
  }
  
  const filledStr = filledChar.repeat(filled);
  const emptyStr = emptyChar.repeat(empty);
  
  return colorFn(filledStr) + colors.dim(emptyStr);
}

function formatSessionId(sessionId: string): string {
  if (sessionId.length <= 8) {
    return sessionId;
  }
  if (sessionId.length <= 12) {
    return sessionId.slice(0, 8);
  }
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}

function formatWindowLabel(minutes?: number): string {
  if (!minutes || minutes <= 0) {
    return '';
  }
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

function renderRateWindow(usedPercent: number, windowMinutes?: number, barWidth: number = 8): string {
  const percent = Math.max(0, Math.min(100, Math.round(usedPercent)));
  const bar = renderContextProgressBar(percent, barWidth);
  const percentDisplay = percent >= 85
    ? theme.error(`${percent}%`)
    : percent >= 70
      ? theme.warning(`${percent}%`)
      : theme.success(`${percent}%`);
  const windowLabel = formatWindowLabel(windowMinutes);
  return windowLabel
    ? `${bar} ${percentDisplay} ${colors.dim(windowLabel)}`
    : `${bar} ${percentDisplay}`;
}

export function renderPlanQuota(data: HudData): string | null {
  const limits = data.rateLimits;
  if (!limits) {
    return null;
  }

  const windows = [limits.primary, limits.secondary].filter(
    (window): window is NonNullable<typeof window> =>
      Boolean(window && typeof window.used_percent === 'number')
  );

  if (windows.length === 0) {
    return null;
  }

  const rendered = windows.map((window) =>
    renderRateWindow(window.used_percent ?? 0, window.window_minutes, windows.length > 1 ? 6 : 8)
  );
  return colors.dim('Plan: ') + rendered.join(` ${colors.dim('·')} `);
}

export function renderTokenLine(data: HudData): string | null {
  const usage = data.tokenUsage?.total_token_usage ?? data.tokenUsage?.last_token_usage;
  if (!usage) {
    return null;
  }

  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const cacheRate = input > 0 ? Math.round((cached / input) * 100) : null;
  const totalLabel = theme.tokenCount(`Tokens: ${formatTokenCount(usage.total_tokens ?? 0)}`);
  return cacheRate === null
    ? totalLabel
    : `${totalLabel} ${colors.dim(`(cache ${cacheRate}%)`)}`;
}

export function renderSessionDetailLine(data: HudData): string | null {
  const parts: string[] = [];
  
  // Always show session info if we have a session
  const session = data.session;
  
  // Show working directory
  const cwd = session?.cwd || data.project.cwd;
  if (cwd) {
    const home = process.env.HOME || '';
    let displayPath = cwd;
    if (home && cwd.startsWith(home)) {
      displayPath = '~' + cwd.slice(home.length);
    }
    if (displayPath.length > 50) {
      displayPath = '…' + displayPath.slice(-49);
    }
    parts.push(colors.dim('Dir: ') + theme.value(displayPath));
  }

  // Show session ID if available
  if (session?.id) {
    parts.push(colors.dim('Session: ') + theme.info(formatSessionId(session.id)));
  }

  if (session?.modelProvider && session.modelProvider !== 'openai') {
    parts.push(colors.dim('Provider: ') + theme.value(session.modelProvider));
  }

  return parts.length > 0 ? parts.join(` ${colors.dim(icons.bar)} `) : null;
}

export function collectActivityLines(data: HudData): string[] {
  const lines: string[] = [];

  const tokenLine = renderTokenLine(data);
  if (tokenLine) {
    lines.push(tokenLine);
  }

  const sessionLine = renderSessionDetailLine(data);
  if (sessionLine) {
    lines.push(sessionLine);
  }

  // Tools line
  const toolsLine = renderToolsLine(data.toolActivity);
  if (toolsLine) {
    lines.push(toolsLine);
  }
  
  // Todos/plan line
  const todosLine = renderTodosLine(data.planProgress);
  if (todosLine) {
    lines.push(todosLine);
  }
  
  return lines;
}
