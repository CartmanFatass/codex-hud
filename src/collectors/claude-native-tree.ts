/** Claude's native subagent files only; bounded, signature-cached, no watcher or worker control. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import { readJobFile } from './job-sentences.js';
import { makeSourceId } from '../core/identity.js';
type Row = {
  stamp: string;
  metaStamp: string;
  ino: number;
  meta: Record<string, unknown>;
  node: SubagentTreeNode;
  calls: Set<string>;
};
const safe = (v: unknown, max = 600) => (typeof v === 'string' ? v.slice(0, max) : '');
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
    let reads = 0;
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
        if (row?.stamp !== stamp) {
          if (reads >= 8) {
            this.complete = false;
            if (row) nodes.push({ ...row.node, status: 'unknown', children: [] });
            continue;
          }
          reads += 2;
          const metadata = metaStamp === row?.metaStamp ? undefined : readJobFile(join(directory, name), 8192),
            transcript = readJobFile(file, 32768, true);
          this.bytes += Buffer.byteLength(metadata?.text ?? '') + Buffer.byteLength(transcript.text);
          if ((metadata && !metadata.stamp) || !transcript.stamp) throw Error('unreadable');
          const meta = metadata ? JSON.parse(metadata.text) : row!.meta;
          if (!meta || typeof meta.finished !== 'boolean') throw Error('invalid_meta');
          const id = name.slice(6, -10);
          row = {
            stamp,
            metaStamp,
            ino: stat.ino,
            meta,
            calls: new Set(row?.ino === stat.ino ? row.calls : []),
            node: {
              ...(row?.ino === stat.ino ? row.node : {}),
              id: `claude:${session}:${id}`,
              name: safe(meta.description) || safe(meta.agentType) || id,
              role: safe(meta.agentType) || 'agent',
              task: safe(meta.description),
              status: meta.finished ? 'completed' : 'running',
              statusAt: meta.finished ? new Date(metaStat.mtimeMs) : undefined,
              rolloutPath: file,
              ref: { harness: 'claude', sourceId: makeSourceId('claude', source), sessionId: session, threadId: id },
              depth: 1,
              children: [],
            },
          };
          let call = '';
          for (const line of transcript.text.split('\n')) {
            try {
              const e = JSON.parse(line),
                m = e.message;
              const at = new Date(e.timestamp);
              if (!Number.isFinite(at.getTime()) || !m || !Array.isArray(m.content)) continue;
              if (stat.size <= 32768) row.node.startedAt ??= at;
              row.node.lastEventAt = at;
              for (const b of m.content)
                if (b.type === 'tool_result' && b.tool_use_id === call) row.node.action = undefined;
              if (
                e.type !== 'assistant' ||
                (e.channel && !['final', 'commentary'].includes(e.channel)) ||
                (m.channel && !['final', 'commentary'].includes(m.channel)) ||
                (m.phase && !['final_answer', 'commentary'].includes(m.phase))
              )
                continue;
              row.node.model = safe(m.model, 128) || row.node.model;
              for (const b of m.content) {
                if (b.type === 'tool_use') {
                  call = b.id;
                  if (typeof b.id === 'string' && row.calls.size < 200) row.calls.add(b.id);
                  row.node.action = { name: safe(b.name, 200), text: safe(b.name, 200), at };
                } else if (b.type === 'text' && typeof b.text === 'string') {
                  row.node.lastReport = { text: safe(b.text), at, kind: meta.finished ? 'reply' : 'update' };
                }
              }
            } catch {
              /* Partial JSONL lines are not public evidence. */
            }
          }
          this.rows.set(name, row);
        }
      } catch {
        this.complete = false;
        if (row) row = { ...row, node: { ...row.node, status: 'unknown' } };
      }
      if (row) nodes.push({ ...row.node, children: [] });
    }
    this.cursor = (this.cursor + 4) % Math.max(1, this.names.length);
    const owners = new Map<string, SubagentTreeNode>();
    for (const n of nodes)
      for (const call of this.rows.get(`agent-${n.ref!.threadId}.meta.json`)?.calls ?? []) owners.set(call, n);
    const roots = nodes.filter((n) => {
      const meta = this.rows.get(`agent-${n.ref!.threadId}.meta.json`)!.meta;
      const parent = owners.get(safe(meta.toolUseId, 256));
      if (parent && parent !== n) {
        parent.children.push(n);
        return false;
      }
      if (Number(meta.spawnDepth) > 1) this.complete = false;
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
