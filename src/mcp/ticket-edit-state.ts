import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { archiveFlowCold } from '../roles/cold-archive.js';
import { readJsonFile, readRegularNoFollow, writeJsonPrivate } from '../utils/atomic-fs.js';

export type TicketEdit = {
  receipt: string;
  cwd: string;
  checkout: string;
  project: string;
  pane: string | null;
  origin: string;
  op: 'add' | 'update';
} & (
  | { state: 'queued'; args: Record<string, unknown> }
  | { state: 'applying'; result: object }
  | { state: 'completed'; result: object }
  | { state: 'failed'; error: string }
);

export const isTicketEditId = (id: string) => /^te[0-9a-f]{32}$/.test(id);
export const ticketEditFile = (home: string, id: string) => join(home, 'flows', `${id}.json`);
export const activeTicketEdit = (row: TicketEdit) => row.state === 'queued' || row.state === 'applying';
export const saveTicketEdit = (home: string, row: TicketEdit) =>
  writeJsonPrivate(ticketEditFile(home, row.receipt), row, { fsync: true });

export function readTicketEdit(home: string, id: string): TicketEdit | undefined {
  try { return readJsonFile(ticketEditFile(home, id)) as TicketEdit; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}

export function ticketEditView(row: TicketEdit) {
  const { receipt, state } = row;
  if (state === 'queued' || state === 'applying') return { ok: true, receipt, state: 'queued',
    message: 'No paths or item outcomes yet. Read this receipt with hud_read (job).' };
  if (state === 'failed') return { ok: false, receipt, state, code: row.error.startsWith('invalid_arguments') ? 'invalid_arguments' : 'tool_error', error: row.error };
  return { ...row.result, receipt, state };
}

export function pruneTicketEdit(home: string, id: string) {
  if (!isTicketEditId(id)) throw Error('invalid ticket edit receipt id');
  const path = ticketEditFile(home, id);
  const receipt = readRegularNoFollow(path);
  if (!receipt) throw Error('ticket edit receipt is missing or not a regular file');
  const files = [{ file: path, ...receipt }];
  const markers = [`${path}.noticed`, `${path}.observed`];
  for (const file of markers) {
    const read = readRegularNoFollow(file);
    if (read) files.push({ file, ...read });
  }
  archiveFlowCold(home, id, files.map(({ file, data, stat }) => ({
    name: basename(file), data, mode: 0o600, mtime: Math.floor(stat.mtimeMs / 1000),
  })), receipt.stat.mtimeMs);
  // Also clear any empty notice claim created while the archive write was in progress.
  for (const file of [path, ...markers]) fs.rmSync(file, { force: true });
}
