/**
 * Each subagent's stages, read from its own rollout as the tree's scan reads
 * it, a line at a time and never twice.
 *
 * A stage is one turn: `task_started` to `task_complete` (or `turn_aborted`).
 * Codex writes three things about it in plain text, even where the task itself
 * reaches the agent encrypted:
 *
 * - who asked: the header of the message that came in, `Message Type:
 *   NEW_TASK` and its `Sender`, the payload after it encrypted;
 * - how the agent took it on: its first public update of the turn, in its own
 *   words. A stand-in for the task, never the task itself;
 * - what it returned: the turn's final answer, `last_agent_message`.
 *
 * Besides the stages, the tool call the agent has open (what it is doing this
 * minute) and the messages it had from other agents, by sender, from which
 * the panel tells which agent a helper works for. Nothing here is inferred:
 * each field is what one record said. Bounded: the newest stages only, each
 * text cut.
 */
import type { AgentAction, AgentStage } from '../types.js';

/** Stages kept per agent, the newest; `count` keeps the total. */
export const STAGES_KEPT = 8;
/** A final answer kept to this many characters, its head and its tail. */
export const STAGE_RESULT_CHARS = 8000;
/** The first update of a stage, cut to this. */
export const STAGE_INTENT_CHARS = 400;
/** Open tool calls tracked at once; a call whose output never came does not pile up. */
const OPEN_CALLS = 16;

export interface AgentLedger {
  /** The newest stages, oldest first. */
  stages: AgentStage[];
  /** Every stage seen, kept or not. */
  count: number;
  /** Tool calls without an output yet, by call id. */
  open: Map<string, AgentAction>;
  /** Messages from other agents, by the sender's task path, over the whole session. */
  peers: Map<string, number>;
  /** A message's header that came in while no stage ran: the next stage's cause. */
  pending?: { type: string; sender: string };
}

export function newLedger(): AgentLedger {
  return { stages: [], count: 0, open: new Map(), peers: new Map() };
}

type Entry = { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };

const HEADER = /Message Type:\s*(\w+)[\s\S]*?Sender:\s*(\S+)/;

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A text cut to `max` characters, its head and its tail, the cut marked. */
export function headTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '\n[…]\n';
  const head = Math.ceil((max - marker.length) * 0.6);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (max - marker.length - head))}`;
}

function clip(text: string, max: number): string {
  const chars = Array.from(flat(text));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function time(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at : undefined;
}

function args(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

/**
 * What a tool call is doing, in a few words: the command a shell call runs
 * (the first one a script runs), the agent a collaboration call is about,
 * else the tool's name. Never a message body: those are encrypted anyway.
 */
export function actionText(name: string, raw: unknown): string {
  const given = args(raw);
  const command = text(given.cmd) ?? text(given.command) ?? (Array.isArray(given.command) ? given.command.filter(part => typeof part === 'string').join(' ') : undefined);
  if (command) return clip(command, 200);
  if (typeof raw === 'string' && !raw.trimStart().startsWith('{')) {
    // A script (the `exec` tool): the first command it runs, else the first
    // tool it calls, else its first line that is not a comment.
    const quoted = /\bcmd["']?\s*:\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/.exec(raw);
    if (quoted) return clip(quoted[2].replace(/\\[nt]/g, ' ').replace(/\\([\s\S])/g, '$1'), 200);
    const tool = /\btools\.(\w+)\s*\(/.exec(raw);
    if (tool) return tool[1];
    const first = raw.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('//'));
    if (first) return clip(first, 200);
  }
  if (name === 'spawn_agent') return [text(given.task_name), text(given.agent_type) && `(${given.agent_type as string})`].filter(Boolean).join(' ') || name;
  const target = text(given.target);
  if (target) return `→ ${target}`;
  return name;
}

function current(ledger: AgentLedger): AgentStage | undefined {
  const last = ledger.stages.at(-1);
  return last?.status === 'running' ? last : undefined;
}

function startStage(ledger: AgentLedger, at: Date, turnId: string | undefined): AgentStage {
  const stage: AgentStage = { startedAt: at, status: 'running', ...(turnId ? { turnId } : {}) };
  if (ledger.pending) { stage.by = ledger.pending; ledger.pending = undefined; }
  ledger.stages.push(stage);
  ledger.count++;
  if (ledger.stages.length > STAGES_KEPT) ledger.stages.splice(0, ledger.stages.length - STAGES_KEPT);
  return stage;
}

/** Stop tracking the open calls: a turn that ended is running nothing. */
function settle(ledger: AgentLedger): void {
  ledger.open.clear();
}

/**
 * One rollout record into the ledger. Records of other kinds, and malformed
 * ones, are left alone.
 */
export function applyLedgerEntry(entry: Entry, ledger: AgentLedger): void {
  const payload = entry.payload;
  if (!payload) return;
  const at = time(entry.timestamp);
  const kind = payload.type;
  if (entry.type === 'event_msg') {
    if (!at) return;
    const turnId = text(payload.turn_id);
    if (kind === 'task_started' || kind === 'turn_started') {
      const open = current(ledger);
      // A turn that started again without ending is the same stage, read twice.
      if (open && turnId && open.turnId === turnId) return;
      if (open) { open.status = 'aborted'; open.endedAt = at; }
      startStage(ledger, at, turnId);
      settle(ledger);
    } else if (kind === 'task_complete' || kind === 'turn_complete' || kind === 'turn_aborted' || kind === 'task_failed') {
      let stage = current(ledger);
      if (stage && turnId && stage.turnId && stage.turnId !== turnId) stage = undefined;
      // An end with no start read (the rollout begins mid-turn): a stage of its own, its start from the record when it has one.
      if (!stage) {
        const started = typeof payload.started_at === 'number' && Number.isFinite(payload.started_at) ? new Date(payload.started_at * 1000) : at;
        stage = startStage(ledger, started, turnId);
      }
      stage.endedAt = at;
      stage.status = kind === 'turn_aborted' ? 'aborted' : kind === 'task_failed' ? 'failed' : 'done';
      const answer = text(payload.last_agent_message);
      if (answer) stage.result = headTail(answer.trim(), STAGE_RESULT_CHARS);
      settle(ledger);
    }
    return;
  }
  if (entry.type !== 'response_item') return;
  if (kind === 'agent_message') {
    // From another agent: only the header is plain text.
    const first = Array.isArray(payload.content) ? payload.content[0] as { text?: unknown } | undefined : undefined;
    const header = typeof first?.text === 'string' ? HEADER.exec(first.text) : null;
    const sender = header?.[2] ?? text(payload.author);
    if (!sender) return;
    ledger.peers.set(sender, (ledger.peers.get(sender) ?? 0) + 1);
    const stage = current(ledger);
    const by = { type: header?.[1] ?? 'MESSAGE', sender };
    if (stage) {
      stage.peers = { ...stage.peers, [sender]: (stage.peers?.[sender] ?? 0) + 1 };
      // The message that came in before the agent said anything is what the stage is for.
      if (!stage.by && !stage.intent) stage.by = by;
    } else ledger.pending = by;
    return;
  }
  if (kind === 'message' && payload.role === 'assistant' && payload.phase === 'commentary') {
    const stage = current(ledger);
    if (!stage || stage.intent) return;
    const said = Array.isArray(payload.content)
      ? payload.content.map(part => typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : '').join(' ') : '';
    if (said.trim()) stage.intent = clip(said, STAGE_INTENT_CHARS);
    return;
  }
  if ((kind === 'function_call' || kind === 'custom_tool_call') && typeof payload.call_id === 'string' && at) {
    const name = text(payload.name) ?? 'tool';
    ledger.open.set(payload.call_id, { name, text: actionText(name, kind === 'custom_tool_call' ? payload.input : payload.arguments), at });
    if (ledger.open.size > OPEN_CALLS) ledger.open.delete(ledger.open.keys().next().value!);
    return;
  }
  if ((kind === 'function_call_output' || kind === 'custom_tool_call_output') && typeof payload.call_id === 'string') {
    ledger.open.delete(payload.call_id);
  }
}

/** The tool call the agent opened last and has not had an answer to, if any. */
export function currentAction(ledger: AgentLedger): AgentAction | undefined {
  let newest: AgentAction | undefined;
  for (const action of ledger.open.values()) if (!newest || action.at >= newest.at) newest = action;
  return newest;
}
