import * as fs from 'node:fs';
import { join } from 'node:path';
import { tryAbstractLock, withAbstractLock } from '../utils/abstract-lock.js';
import { readJsonFile, writeJsonPrivate } from '../utils/atomic-fs.js';
import { claimDelivery, isDeliveryClaimable, type DeliveryNotice } from '../utils/delivery-record.js';
import type { Graph } from './graph.js';

export const runDir = (home: string, id: string) => join(home, 'flows', id);
export const runLock = <T>(home: string, id: string, fn: () => T) => withAbstractLock('flow-state', `${home}\0${id}`, fn, { timeoutMs: 10_000 });
export const driverLock = (home: string, id: string) => tryAbstractLock('flow-runner', `${home}\0${id}`);
export const saveHeader = (home: string, header: { flow: string }, exclusive = false) => writeJsonPrivate(`${runDir(home, header.flow)}.json`, header, { exclusive });
export const freezeGraph = (home: string, id: string, graph: Pick<Graph, 'version' | 'name' | 'steps' | 'policy'>) => writeJsonPrivate(join(runDir(home, id), 'graph.json'), graph, { exclusive: true });

export const isNoticeKey = (key: string) => /^(?:failure-\d+-(?:\d+|[a-z][a-z0-9_-]{0,47})|handback-[a-z][a-z0-9_-]{0,47}|(?:end|pause|error)-\d+)$/.test(key);

// Native/watch/MCP contend on the same delivery state record. Never cache a claim: a refused
// delivery can release it without changing the header.
export type Outbox = { flow: string; state?: string; epoch?: number; notices?: Record<string, string> };
export function currentNoticeKey(run: Outbox, key: string) {
  if (!isNoticeKey(key) || run.state === 'superseded' || (run.state && run.state !== 'paused' && /^(?:pause|error)-/.test(key))) return false;
  const epoch = /^(?:failure|end|pause|error)-(\d+)/.exec(key)?.[1];
  return run.epoch === undefined || epoch === undefined || Number(epoch) === run.epoch;
}
export const noticeMarker = (home: string, flow: string, key: string, all = false, legacyEnd?: string) =>
  `${legacyEnd && key.startsWith('end-') ? legacyEnd : join(runDir(home, flow), key)}.${all ? 'observed' : 'noticed'}`;
export function noticeEvents(home: string, run: Outbox, all = false, legacyEnd?: string, project = (raw: unknown) => raw as Outbox | null) {
  return Object.entries(run.notices ?? {}).flatMap(([key, text]): DeliveryNotice[] => {
    if (!currentNoticeKey(run, key)) return [];
    const marker = noticeMarker(home, run.flow, key, all, legacyEnd), epoch = run.epoch ?? key;
    if (!isDeliveryClaimable(marker, undefined, epoch) || !claimDelivery(marker, epoch)) return [];
    return [{ line: text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), marker, epoch, current: () => {
      try {
        const latest = project(readJsonFile(`${runDir(home, run.flow)}.json`));
        return latest?.flow === run.flow && currentNoticeKey(latest, key) && (latest.epoch ?? key) === epoch && latest.notices?.[key] === text;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    } }];
  });
}

// Keep the legacy intent path so an already-running helper (or a rollback) still sees stop.
const stopFile = (home: string, id: string) => `${runDir(home, id)}.json.cancel`;
export const stopRequested = (home: string, id: string) => fs.existsSync(stopFile(home, id));
export function requestStop(home: string, id: string) {
  fs.closeSync(fs.openSync(stopFile(home, id), 'a', 0o600));
}
