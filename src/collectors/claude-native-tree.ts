/** Claude's native subagent files only; bounded, signature-cached, no watcher or worker control. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import { readJobFile } from './read-job-file.js';
import { makeSourceId } from '../core/identity.js';
import { headTail } from './agent-stages.js';
const CHUNK = 1024 * 1024;
const MAX_LINE = 4 * CHUNK;
const TAIL = 64 * 1024;
const FORWARD_FILES = 4;
const PREVIEW_FILES = 16;
type TranscriptDisplay = Pick<SubagentTreeNode, 'action' | 'lastReport' | 'model' | 'lastEventAt'> & {
  actionIsLatest?: boolean;
  endTurn?: Date;
};
type Row = {
  stamp: string;
  metaStamp: string;
  ino: number;
  size: number;
  mtime: number;
  offset: number;
  pending: Buffer;
  skipping: boolean;
  omitted: boolean;
  meta: Record<string, unknown>;
  node: SubagentTreeNode;
  calls: Set<string>;
  openTools: Set<string>;
  resumed: boolean;
  forward: TranscriptDisplay;
  previewed: boolean;
  preview?: { display: TranscriptDisplay; end: number; birthtime: number };
};
const safe = (v: unknown, max = 600) => (typeof v === 'string' ? v.slice(0, max) : '');
/** A growing transcript is activity even before replay reaches its newest lines (as a Codex rollout's mtime is). */
const newer = (at: Date | undefined, mtime: number) =>
  Number.isFinite(mtime) && (!at || mtime > at.getTime()) ? new Date(mtime) : at;

/** Consume complete public records. Only forward replay carries lifecycle and nesting state. */
function applyLines(body: Buffer, start: number, display: TranscriptDisplay, forward?: Row): number {
  let call: unknown = '';
  for (let end; (end = body.indexOf(10, start)) !== -1; start = end + 1) {
    const line = body.subarray(start, end);
    if (forward && (forward.skipping || line.length > MAX_LINE)) {
      forward.skipping = false;
      forward.omitted = true;
      continue;
    }
    try {
      const e = JSON.parse(line.toString('utf8')),
        m = e.message;
      const at = new Date(e.timestamp);
      if (!Number.isFinite(at.getTime()) || !m || !Array.isArray(m.content)) continue;
      if (forward) forward.node.startedAt ??= at;
      display.lastEventAt = at;
      if (
        (e.channel && !['final', 'commentary'].includes(e.channel)) ||
        (m.channel && !['final', 'commentary'].includes(m.channel)) ||
        (m.phase && !['final_answer', 'commentary'].includes(m.phase))
      )
        continue;
      display.endTurn = e.type === 'assistant' && m.stop_reason === 'end_turn' ? at : undefined;
      for (const b of m.content)
        if (b.type === 'tool_result') {
          forward?.openTools.delete(b.tool_use_id);
          if (b.tool_use_id === call) display.action = undefined;
        }
      if (e.type !== 'assistant') continue;
      display.model = safe(m.model, 128) || display.model;
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          call = b.id;
          if (forward && typeof b.id === 'string') {
            forward.openTools.add(b.id);
            if (['Agent', 'Task'].includes(b.name)) forward.calls.add(b.id);
          }
          display.action = { name: safe(b.name, 200), text: safe(b.name, 200), at };
          display.actionIsLatest = true;
        } else if (b.type === 'text' && typeof b.text === 'string') {
          display.lastReport = { text: headTail(b.text, 8000), at, kind: 'update' };
          display.actionIsLatest = false;
        }
      }
    } catch {
      /* Partial JSONL lines are not public evidence. */
    }
  }
  return start;
}

function displayNode(row: Row, mtime = row.mtime, deferred = false): SubagentTreeNode {
  // Keep the preview separate: old forward chunks cannot overwrite it, nor can
  // preview text or end_turn become authoritative when replay finishes.
  const { action, actionIsLatest, lastReport, model, lastEventAt } = row.preview?.display ?? row.forward;
  const step = (actionIsLatest && action?.text) || lastReport?.text;
  return {
    ...row.node,
    action,
    lastReport: lastReport && { ...lastReport, kind: row.node.status === 'completed' ? 'reply' : 'update' },
    model,
    lastEventAt: newer(lastEventAt, mtime),
    replaying: deferred || row.offset < row.size || !!row.pending.length || row.skipping,
    transcriptStep: row.previewed ? step : undefined,
    children: [],
  };
}

export class ClaudeNativeTree {
  private rows = new Map<string, Row>();
  private listing = '';
  private names: string[] = [];
  private cursor = 0;
  complete = false;
  bytes = 0;
  refresh(source: string, session: string): SubagentTree {
    this.complete = false;
    this.bytes = 0;
    const nodes: SubagentTreeNode[] = [];
    const tree = { rootId: session, nodes, totalCount: 0, updatedAt: new Date(), incomplete: true };
    if (!/^[\w-]+$/.test(session)) return tree;
    const directory = join(source, session, 'subagents');
    try {
      const st = fs.lstatSync(directory);
      if (!st.isDirectory() || fs.realpathSync(directory) !== directory) return tree;
      const signature = `${directory}:${st.ino}:${st.mtimeMs}`;
      if (signature !== this.listing) {
        const names: string[] = [],
          dir = fs.opendirSync(directory);
        let count = 0;
        try {
          for (let e; (e = dir.readSync()) && count++ < 401;)
            if (/^agent-[\w-]+\.meta\.json$/.test(e.name)) names.push(e.name);
        } finally {
          dir.closeSync();
        }
        this.names = names.slice(0, 200);
        this.listing = count > 400 || names.length > 200 ? '' : signature;
      }
      this.complete = !!this.listing;
    } catch (error) {
      this.complete = (error as NodeJS.ErrnoException).code === 'ENOENT';
      this.rows.clear();
      return { ...tree, incomplete: !this.complete };
    }
    const live = new Set(this.names);
    for (const key of this.rows.keys()) if (!live.has(key)) this.rows.delete(key);
    let reads = 0,
      previews = 0,
      replaying = false;
    for (let i = 0; i < this.names.length; i++) {
      const name = this.names[(this.cursor + i) % this.names.length];
      const file = join(directory, name.replace('.meta.json', '.jsonl'));
      let row = this.rows.get(name);
      try {
        const metaStat = fs.lstatSync(join(directory, name)),
          stat = fs.lstatSync(file);
        if (!metaStat.isFile() || !stat.isFile() || fs.realpathSync(file) !== file) throw Error('unsafe');
        const metaStamp = `${directory}:${metaStat.ino}:${metaStat.size}:${metaStat.mtimeMs}`;
        const stamp = `${metaStamp}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        if (
          row &&
          (row.ino !== stat.ino ||
            row.node.rolloutPath !== file ||
            stat.size < row.size ||
            (stat.size === row.size && stat.mtimeMs !== row.mtime))
        ) {
          this.rows.delete(name);
          row = undefined;
        }
        if (row?.stamp !== stamp || row.offset < stat.size) {
          // Give new long files their tail now and schedule their forward read
          // on a later tick, without spending the existing four-file budget.
          const tailFirst = !row && stat.size > TAIL;
          if (tailFirst ? previews >= PREVIEW_FILES : reads >= FORWARD_FILES) {
            replaying = true;
            this.complete = false;
            if (row) nodes.push(displayNode(row, stat.mtimeMs, true));
            continue;
          }
          if (tailFirst) previews++;
          else reads++;
          const metadata = metaStamp === row?.metaStamp ? undefined : readJobFile(join(directory, name), 8192);
          this.bytes += Buffer.byteLength(metadata?.text ?? '');
          if (metadata && !metadata.stamp) throw Error('unreadable');
          const meta = metadata ? JSON.parse(metadata.text) : row!.meta;
          if (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
            (meta.finished !== undefined && typeof meta.finished !== 'boolean')) throw Error('invalid_meta');
          const id = name.slice(6, -10);
          const previous = row;
          row = {
            stamp,
            metaStamp,
            ino: stat.ino,
            size: stat.size,
            mtime: stat.mtimeMs,
            offset: previous?.offset ?? 0,
            pending: previous?.pending ?? Buffer.alloc(0),
            skipping: previous?.skipping ?? false,
            omitted: previous?.omitted ?? false,
            meta,
            calls: new Set(previous?.calls),
            openTools: new Set(previous?.openTools),
            resumed: previous?.resumed ?? false,
            forward: { ...previous?.forward },
            previewed: previous?.previewed ?? tailFirst,
            preview: previous?.preview,
            node: {
              ...previous?.node,
              id: `claude:${session}:${id}`,
              name: safe(meta.description) || safe(meta.agentType) || id,
              role: safe(meta.agentType) || 'agent',
              task: safe(meta.description),
              status: previous?.node.status ?? (meta.finished ? 'completed' : 'running'),
              statusAt: previous ? previous.node.statusAt : meta.finished ? new Date(metaStat.mtimeMs) : undefined,
              rolloutPath: file,
              ref: { harness: 'claude', sourceId: makeSourceId('claude', source), sessionId: session, threadId: id },
              depth: 1,
              children: [],
            },
          };
          // A finished flag can describe an interim reply before background work resumes.
          if (previous && stat.size > previous.size && (previous.node.status === 'completed' || row.resumed)) {
            row.resumed = true;
            row.forward.endTurn = undefined;
            row.node.status = 'running';
            row.node.statusAt = undefined;
          }
          if (metadata) {
            row.node.status = meta.finished ? 'completed' : 'running';
            row.node.statusAt = meta.finished ? new Date(metaStat.mtimeMs) : undefined;
            row.resumed = !meta.finished && (row.resumed || previous?.node.status === 'completed');
          }
          let fd: number | undefined;
          let chunk: Buffer;
          try {
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            const opened = fs.fstatSync(fd);
            if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size < stat.size)
              throw Error('changed');
            const position = tailFirst ? stat.size - TAIL : row.offset;
            chunk = Buffer.alloc(Math.min(CHUNK, stat.size - position));
            const n = chunk.length ? fs.readSync(fd, chunk, 0, chunk.length, position) : 0;
            this.bytes += n;
            chunk = chunk.subarray(0, n);
            if (fs.lstatSync(file).ino !== stat.ino) throw Error('changed');
          } finally {
            if (fd !== undefined) fs.closeSync(fd);
          }
          if (tailFirst) {
            const display: TranscriptDisplay = {},
              firstBreak = chunk.indexOf(10);
            // Both the line crossing the window start and an unterminated last line are not evidence.
            if (firstBreak !== -1) applyLines(chunk, firstBreak + 1, display);
            row.preview = {
              display,
              end: stat.size,
              birthtime: metaStat.birthtimeMs > 0 ? metaStat.birthtimeMs : Infinity,
            };
          } else {
            row.offset += chunk.length;
            const body = Buffer.concat([row.pending, chunk]);
            row.pending = Buffer.from(body.subarray(applyLines(body, 0, row.forward, row)));
            if (row.pending.length > MAX_LINE) {
              row.pending = Buffer.alloc(0);
              row.skipping = row.omitted = true;
            }
            if (row.preview && row.offset >= row.preview.end) row.preview = undefined;
            if (row.resumed && row.offset === stat.size && !row.pending.length && row.forward.endTurn && !row.openTools.size) {
              row.node.status = 'completed';
              row.node.statusAt = row.forward.endTurn;
              row.resumed = false;
            }
          }
          this.rows.set(name, row);
        }
        if (row && row.offset < stat.size) replaying = true;
        if (row && (row.offset < stat.size || row.pending.length || row.skipping || row.omitted)) this.complete = false;
      } catch {
        this.complete = false;
        if (row) {
          row = { ...row, stamp: '', node: { ...row.node, status: 'unknown' } };
          this.rows.set(name, row);
        }
      }
      if (row) nodes.push(displayNode(row));
    }
    this.cursor = (this.cursor + FORWARD_FILES) % Math.max(1, this.names.length);
    // The read cursor rotates; the rows must not, or Home reshuffles every refresh.
    const rowFor = (n: SubagentTreeNode) => this.rows.get(`agent-${n.ref!.threadId}.meta.json`)!;
    const started = (n: SubagentTreeNode) => n.startedAt?.getTime() ?? rowFor(n).preview?.birthtime ?? Infinity;
    nodes.sort((a, b) => started(a) - started(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const owners = new Map<string, SubagentTreeNode>();
    for (const n of nodes) for (const call of rowFor(n).calls) owners.set(call, n);
    const roots = nodes.filter((n) => {
      const { meta } = rowFor(n);
      const parent = owners.get(safe(meta.toolUseId, 256));
      if (parent && parent !== n) {
        parent.children.push(n);
        return false;
      }
      if (Number(meta.spawnDepth) > 1) {
        this.complete = false;
        if (replaying) return false;
      }
      return true;
    });
    const seen = new Set<string>();
    const depth = (n: SubagentTreeNode, d: number) => {
      seen.add(n.id);
      n.depth = d;
      n.children = n.children.filter((c) => !seen.has(c.id));
      for (const c of n.children) depth(c, d + 1);
    };
    for (const n of roots) depth(n, 1);
    if (seen.size !== nodes.length) this.complete = false;
    return { ...tree, nodes: roots, totalCount: nodes.length, incomplete: !this.complete };
  }
}
