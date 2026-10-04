/**
 * How an agent is headed wherever a header stands for it: its card's top
 * rule and its block in the compact log. Every header reads it from here, so
 * how an agent is named changes in one place.
 *
 * The header identifies the agent: Codex's own name, the one its
 * `/subagents` picker prints, with a glyph for the kind of work when the
 * labels feature gave one. The model never supplies the glyph, only the kind,
 * and `other` has none. What the agent is doing goes under the header: the
 * model-written name when there is one, else the task it was given, so it
 * says something with every model feature off.
 */
import type { AgentTaskKind, SubagentTreeNode } from '../types.js';
import { monitorText } from './monitor.js';

/**
 * All six are one column wide, CJK terminals included, and none is a model,
 * effort, status or clock glyph (≡ is Terra's, so a summary is ∑).
 */
export const KIND_GLYPHS: Readonly<Record<AgentTaskKind, string>> = {
  research: '⌕', experiment: '⚗', fix: '⚒', review: '◈', writing: '✎', summary: '∑', other: '',
};

export interface AgentTitle {
  /** The kind-of-work glyph; absent for `other`, or before a label has arrived. */
  icon?: string;
  /** Codex's name for the agent, sanitized: safe to measure and paint. */
  name: string;
  /** What the agent is for: the model's name for it, else its task text, sanitized; absent when there is neither. */
  task?: string;
  /** True when `task` is the model's name rather than the task text. */
  renamed: boolean;
}

export function agentTitle(node: SubagentTreeNode): AgentTitle {
  const icon = node.taskKind ? KIND_GLYPHS[node.taskKind] || undefined : undefined;
  const renamed = Boolean(node.label) && node.label !== node.name;
  const task = renamed ? node.label! : node.task?.replace(/\s+/g, ' ').trim();
  return { ...(icon ? { icon } : {}), name: monitorText(node.name), ...(task ? { task: monitorText(task) } : {}), renamed };
}
