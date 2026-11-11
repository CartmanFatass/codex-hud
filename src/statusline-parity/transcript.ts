/** claude-hud 0.8.0 activity semantics (MIT), with bounded persistent byte cursors.
 * Cold/reset: head + tail first; older blocks backfill newest-to-oldest. All reductions
 * carry absolute byte positions, so older history cannot overwrite a newer snapshot. */
import * as fs from 'node:fs';
import { cached, cachePath, noLinks, record, saveJson } from './storage.js';
import { monitorText } from '../render/monitor-text.js';
export const TRANSCRIPT_CHUNK = 1024 * 1024;
const HEAD = 16 * 1024;
const MAX_LINE = 256 * 1024;
const CAP = 200;
export interface Agent {
  id: string;
  type: string;
  model?: string;
  description: string;
  start: number;
  startPos: number;
  end?: number;
  endPos?: number;
  background: boolean;
  notified?: boolean;
}
export interface Todo {
  content: string;
  status: string;
  id?: string;
}
interface Task {
  id: string;
  createPos?: number;
  createContent?: string;
  content?: string;
  status?: string;
  contentPos: number;
  statusPos: number;
}
interface State {
  version: 1;
  identity: string;
  size: number;
  mtime: number;
  offset: number;
  backfill: number;
  pending: string;
  dropping: boolean;
  sessionStart?: number;
  agents: Agent[];
  todos: Todo[];
  todoPos: number;
  tasks: Task[];
  skills: { name: string; pos: number }[];
  ultracode: boolean;
  effortPos: number;
  compactAt?: number;
  compactPostTokens?: number;
  results: { id: string; pos: number; at?: number; model?: string; notified: boolean }[];
  resultFloor: number;
}
export interface TranscriptView {
  agents: Agent[];
  todos: Todo[];
  skills: string[];
  sessionStart?: number;
  ultracode: boolean;
  bytesRead: number;
  pendingHistory: boolean;
  compactAt?: number;
  compactPostTokens?: number;
}
const safe = (v: unknown, n = 512) => (typeof v === 'string' ? monitorText(v.slice(0, n)).trim() : '');
function status(v: unknown): string | undefined {
  if (['pending', 'not_started'].includes(String(v))) return 'pending';
  if (['in_progress', 'running'].includes(String(v))) return 'in_progress';
  if (['completed', 'complete', 'done'].includes(String(v))) return 'completed';
  return undefined;
}
function reduce(s: State, raw: string, pos: number): void {
  let e: Record<string, unknown>;
  try {
    e = record(JSON.parse(raw));
  } catch {
    return;
  }
  const time = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  if (Number.isFinite(time) && (s.sessionStart === undefined || time < s.sessionStart)) s.sessionStart = time;
  const text = typeof e.content === 'string' ? e.content : '';
  const remember = (id: string, model: string | undefined, notified: boolean) => {
    let r = s.results.find((r) => r.id === id);
    if (!r) {
      r = { id, pos, notified };
      s.results.push(r);
    }
    if (pos >= r.pos) {
      r.pos = pos;
      if (Number.isFinite(time)) r.at = time;
      r.notified ||= notified;
    }
    if (model) r.model = model;
    if (s.results.length > 1000) {
      s.results.sort((a, b) => b.pos - a.pos);
      const removed = s.results.pop()!;
      s.resultFloor = Math.max(s.resultFloor, removed.pos);
    }
    const a = s.agents.find((a) => a.id === id);
    if (a) {
      if (model) a.model = model;
      if (pos >= (a.endPos ?? -1)) {
        a.endPos = pos;
        a.notified ||= notified;
        if (!a.background || notified) a.end = Number.isFinite(time) ? time : undefined;
      }
    }
  };
  // Background completion is not the launch tool_result. Queue notices carry the true end.
  if (e.type === 'queue-operation') {
    const id = /<tool-use-id>([^<]{1,256})<\/tool-use-id>/.exec(text)?.[1];
    if (id && Number.isFinite(time)) remember(id, undefined, true);
  }
  const message = record(e.message);
  if (e.type === 'system' && e.subtype === 'compact_boundary' && Number.isFinite(time) && time >= (s.compactAt ?? 0)) {
    s.compactAt = time;
    const post = record(e.compactMetadata).postTokens;
    s.compactPostTokens = typeof post === 'number' && Number.isFinite(post) && post >= 0 ? post : undefined;
  }
  if (pos >= s.effortPos) {
    const attachment = record(e.attachment).type;
    const command =
      e.type === 'user' && typeof message.content === 'string'
        ? /^<local-command-stdout>Set effort level to (\w+)/.exec(message.content)
        : null;
    if (attachment === 'ultra_effort_enter' || attachment === 'ultra_effort_exit' || command) {
      s.ultracode = command ? command[1].toLowerCase() === 'ultracode' : attachment === 'ultra_effort_enter';
      s.effortPos = pos;
    }
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const item of blocks) {
    const b = record(item),
      input = record(b.input),
      id = safe(b.id, 256),
      name = safe(b.name, 128);
    if (b.type === 'tool_use' && id && name) {
      if (name === 'Skill') {
        const rawSkill = safe(input.skill);
        const skill = rawSkill.length > 64 ? rawSkill.slice(0, 63) + '…' : rawSkill;
        if (skill) {
          const old = s.skills.find((x) => x.name === skill);
          if (old) old.pos = Math.min(old.pos, pos);
          else if (s.skills.length < CAP) s.skills.push({ name: skill, pos });
        }
      } else if (name === 'Task' || name === 'Agent') {
        let a = s.agents.find((a) => a.id === id);
        if (!a && s.agents.length >= CAP) {
          const done = [...s.agents].filter((a) => a.end !== undefined).sort((a, b) => a.startPos - b.startPos)[0];
          if (done && pos > done.startPos) s.agents.splice(s.agents.indexOf(done), 1);
        }
        const completion = s.results.find((r) => r.id === id);
        if (!a && s.agents.length < CAP && (pos >= s.resultFloor || completion)) {
          a = { id, type: 'agent', description: '', start: time, startPos: -1, background: false };
          s.agents.push(a);
        }
        if (a && pos >= a.startPos) {
          Object.assign(a, {
            type: safe(input.subagent_type) || 'agent',
            description: safe(input.description, 512),
            model: a.endPos !== undefined && a.model ? a.model : safe(input.model, 128) || undefined,
            start: Number.isFinite(time) ? time : 0,
            startPos: pos,
            background: input.run_in_background === true,
          });
          if (completion) {
            a.endPos = completion.pos;
            a.notified = completion.notified;
            if (completion.model) a.model = completion.model;
            a.end = !a.background || completion.notified ? completion.at : undefined;
          } else if (a.background && !a.notified) a.end = undefined;
        }
      } else if (name === 'TodoWrite' && Array.isArray(input.todos) && pos >= s.todoPos) {
        const oldIds = new Map<string, string[]>();
        for (const t of view(s, 0).todos) if (t.id) oldIds.set(t.content, [...(oldIds.get(t.content) ?? []), t.id]);
        s.todos = input.todos.slice(0, CAP).map((t) => {
          const v = record(t);
          const content = safe(v.content);
          return { content, status: status(v.status) ?? 'pending', id: oldIds.get(content)?.shift() };
        });
        s.todoPos = pos;
      } else if (name === 'TaskCreate' || name === 'TaskUpdate') {
        const taskId = safe(String(input.taskId ?? (name === 'TaskCreate' ? id : '')), 256);
        if (!taskId) continue;
        let t = s.tasks.find((t) => t.id === taskId);
        if (!t && s.tasks.length < CAP) {
          t = { id: taskId, contentPos: -1, statusPos: -1 };
          s.tasks.push(t);
        }
        if (!t) continue;
        const content =
          safe(input.subject) || safe(input.description) || (name === 'TaskCreate' ? 'Untitled task' : '');
        if (name === 'TaskCreate') {
          t.createPos = pos;
          t.createContent = content;
        }
        if (content && pos >= t.contentPos) {
          t.content = content;
          t.contentPos = pos;
        }
        const st = status(input.status) ?? (name === 'TaskCreate' ? 'pending' : undefined);
        if (st && pos >= t.statusPos) {
          t.status = st;
          t.statusPos = pos;
        }
      }
    }
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const id = safe(b.tool_use_id, 256);
      remember(id, safe(record(e.toolUseResult).resolvedModel, 128) || undefined, false);
    }
  }
}
function view(s: State, bytesRead: number): TranscriptView {
  const todos = s.todos.map((t) => ({ ...t }));
  for (const t of [...s.tasks].sort((a, b) => (a.createPos ?? Infinity) - (b.createPos ?? Infinity))) {
    let i = todos.findIndex((v) => v.id === t.id);
    if (i < 0 && t.createPos !== undefined && t.createPos < s.todoPos) {
      const content = t.contentPos <= s.todoPos ? t.content : t.createContent;
      i = todos.findIndex((v) => !v.id && v.content === content);
      if (i >= 0) todos[i].id = t.id;
    }
    if (i < 0 && /^\d+$/.test(t.id)) i = Number(t.id) - 1;
    if (t.createPos !== undefined && t.createPos > s.todoPos) {
      todos.push({ id: t.id, content: t.content ?? 'Untitled task', status: t.status ?? 'pending' });
    } else if (i >= 0 && i < todos.length) {
      if (t.contentPos > s.todoPos && t.content) todos[i].content = t.content;
      if (t.statusPos > s.todoPos && t.status) todos[i].status = t.status;
    }
  }
  return {
    agents: s.agents.filter((a) => a.startPos >= 0),
    todos,
    skills: [...s.skills].sort((a, b) => a.pos - b.pos).map((x) => x.name),
    sessionStart: s.sessionStart,
    ultracode: s.ultracode,
    bytesRead,
    pendingHistory: s.backfill > 0,
    compactAt: s.compactAt,
    compactPostTokens: s.compactPostTokens,
  };
}
export function collectTranscript(file: string, env: NodeJS.ProcessEnv): TranscriptView {
  const empty: State = {
    version: 1,
    identity: '',
    size: 0,
    mtime: 0,
    offset: 0,
    backfill: 0,
    pending: '',
    dropping: false,
    agents: [],
    todos: [],
    todoPos: -1,
    tasks: [],
    skills: [],
    ultracode: false,
    effortPos: -1,
    results: [],
    resultFloor: -1,
  };
  let fd: number | undefined;
  try {
    noLinks(file);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return view(empty, 0);
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const cache = cachePath(env, 'transcript', file);
    let s = cached<State>(cache);
    const reset =
      !s ||
      !Array.isArray(s.results) ||
      s.identity !== identity ||
      stat.size < s.size ||
      (stat.size === s.size && stat.mtimeMs !== s.mtime);
    if (reset) s = { ...empty, identity };
    if (!s) s = empty;
    let bytesRead = 0;
    const read = (start: number, end: number) => {
      const b = Buffer.alloc(Math.max(0, end - start));
      const n = fs.readSync(fd!, b, 0, b.length, start);
      bytesRead += n;
      return b.subarray(0, n);
    };
    const block = (start: number, end: number, keepTail: boolean) => {
      const b = read(start, end);
      let from = start > 0 ? b.indexOf(10) + 1 : 0;
      if (start > 0 && from === 0) {
        if (keepTail) {
          s!.pending = '';
          s!.dropping = true;
        }
        return;
      }
      let line = from;
      while (from < b.length) {
        if (b[from] === 10) {
          if (from - line <= MAX_LINE) reduce(s!, b.subarray(line, from).toString('utf8'), start + line);
          line = from + 1;
        }
        from++;
      }
      if (keepTail) {
        s!.pending = b.subarray(line).toString('base64');
        s!.dropping = b.length - line > MAX_LINE;
        if (s!.dropping) s!.pending = '';
        else if (b.length > line) reduce(s!, b.subarray(line).toString('utf8'), start + line);
      }
    };
    if (reset) {
      block(0, Math.min(HEAD, stat.size), false);
      const start = Math.max(0, stat.size - TRANSCRIPT_CHUNK);
      block(start, stat.size, true);
      s.offset = stat.size;
      s.backfill = start;
    } else if (stat.size > s.offset) {
      const end = Math.min(stat.size, s.offset + (s.backfill > 0 ? TRANSCRIPT_CHUNK / 2 : TRANSCRIPT_CHUNK));
      const fresh = read(s.offset, end);
      let data = fresh,
        base = s.offset;
      if (s.pending) {
        const old = Buffer.from(s.pending, 'base64');
        data = Buffer.concat([old, fresh]);
        base -= old.length;
      }
      let line = 0;
      for (let i = 0; i < data.length; i++)
        if (data[i] === 10) {
          if (!s.dropping && i - line <= MAX_LINE) reduce(s, data.subarray(line, i).toString('utf8'), base + line);
          s.dropping = false;
          line = i + 1;
        }
      s.dropping = s.dropping || data.length - line > MAX_LINE;
      s.pending = s.dropping ? '' : data.subarray(line).toString('base64');
      if (!s.dropping && end === stat.size && data.length > line)
        reduce(s, data.subarray(line).toString('utf8'), base + line);
      s.offset = end;
    }
    if (!reset && s.backfill > 0 && TRANSCRIPT_CHUNK - bytesRead > MAX_LINE) {
      // Share the same allowance with append work, so live growth cannot starve backfill.
      // Overlap up to one bounded line so a block boundary cannot lose an entry.
      const end = Math.min(stat.size, s.backfill + MAX_LINE);
      const start = Math.max(0, s.backfill - (TRANSCRIPT_CHUNK - bytesRead - MAX_LINE));
      block(start, end, false);
      s.backfill = start;
    }
    s.size = stat.size;
    s.mtime = stat.mtimeMs;
    if (bytesRead || reset) {
      try {
        saveJson(cache, s);
      } catch {
        /* read-only/unavailable cache */
      }
    }
    return view(s, bytesRead);
  } catch {
    return view(empty, 0);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
