import * as fs from 'node:fs';
import { join } from 'node:path';
import { tryAbstractLock, withAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import type { Graph } from './graph.js';

export const runDir = (home: string, id: string) => join(home, 'flows', id);
export const runLock = <T>(home: string, id: string, fn: () => T) => withAbstractLock('flow-state', `${home}\0${id}`, fn);
export const driverLock = (home: string, id: string) => tryAbstractLock('flow-runner', `${home}\0${id}`);
export const saveHeader = (home: string, header: { flow: string }) => writeJsonPrivate(`${runDir(home, header.flow)}.json`, header);
export const freezeGraph = (home: string, id: string, graph: Pick<Graph, 'version' | 'name' | 'steps' | 'policy'>) => writeJsonPrivate(join(runDir(home, id), 'graph.json'), graph, { exclusive: true });

// Native/watch/MCP contend on exactly the same marker. Never cache a claim: a failed
// delivery can release it without changing the header. existsSync avoids exceptions on quiet scans.
export function noticeEvents(home: string, run: { flow: string; notices: Record<string, string> }, all = false) {
  const events = [] as { line: string; marker: string }[];
  for (const [key, text] of Object.entries(run.notices)) {
    if (!/^(?:failure-\d+-(?:\d+|[a-z][a-z0-9_-]{0,47})|(?:end|pause|error)-\d+)$/.test(key)) continue;
    const marker = join(runDir(home, run.flow), `${key}.${all ? 'observed' : 'noticed'}`);
    if (fs.existsSync(marker)) continue;
    try { fs.closeSync(fs.openSync(marker, 'wx', 0o600)); }
    catch (e) { if (['EEXIST','ENOENT'].includes((e as NodeJS.ErrnoException).code ?? '')) continue; throw e; }
    events.push({ line: text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), marker });
  }
  return events;
}
