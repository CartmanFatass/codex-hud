/** Display lifetime only. None of these documents is a job receipt or a caller credential. */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getHudDisplayHome } from '../../hud-home.js';
import { makeSourceId } from '../../core/identity.js';
import type { Harness, SessionRef } from '../../core/types/identity.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import { formatRosterRoot, parseRosterRoot } from '../../roles/selection.js';

export type PanelPhase = 'opening' | 'open' | 'closing' | 'closed' | 'uncertain';
export interface DisplayTarget {
  harness: Harness;
  source: string;
  ref: SessionRef;
  root: string;
}
export interface PaneIdentity {
  pane: string;
  tab: string;
  terminal: string;
  process: ProcessStamp;
  atPrompt?: boolean;
  shell?: ProcessStamp;
  workspace?: string;
}
export interface PanelContext {
  target: DisplayTarget;
  main: ProcessStamp;
  instance: string;
  origin: PaneIdentity;
  runtime: { node: string; entry: string; digest: string };
}
export interface PanelReceipt extends PanelContext {
  schema: 1;
  kind: 'hud-panel-display';
  generation: string;
  token: string;
  phase: PanelPhase;
  panel: PaneIdentity | null;
  /** Retained immediately after split, before shell/process evidence is available. */
  createdPane?: string;
  createdWorkspace?: string;
  reason?: 'split_reply_lost';
}
export const clean = (s: unknown, max = 4096): s is string =>
  typeof s === 'string' && !!s && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
export const absolute = (s: unknown): s is string => clean(s) && isAbsolute(s) && resolve(s) === s;
export const uuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/.test(s);
export function validStamp(s: unknown): s is ProcessStamp {
  if (!s || typeof s !== 'object') return false;
  const p = s as ProcessStamp;
  return (
    Number.isSafeInteger(p.pid) &&
    p.pid > 1 &&
    /^\d+$/.test(p.proc_start) &&
    clean(p.boot_id, 128) &&
    clean(p.pid_domain, 128)
  );
}
export function validPane(s: unknown): s is PaneIdentity {
  if (!s || typeof s !== 'object') return false;
  const p = s as PaneIdentity;
  return (
    [p.pane, p.tab, p.terminal].every((v) => clean(v, 256)) &&
    validStamp(p.process) &&
    (p.shell === undefined || validStamp(p.shell)) &&
    (p.workspace === undefined || clean(p.workspace, 256))
  );
}
export function displayTarget(harness: Harness, session: string, source: string): DisplayTarget {
  if (!['claude', 'pi', 'codex'].includes(harness) || !absolute(source)) throw new Error('panel_target_invalid');
  const sourceId = makeSourceId(harness, source);
  const root = formatRosterRoot(parseRosterRoot(`${sourceId}/${session}`));
  return { harness, source, ref: { harness, sourceId, sessionId: session, threadId: null }, root };
}
export function validateContext(c: PanelContext): void {
  const target = displayTarget(c.target.harness, c.target.ref.sessionId, c.target.source);
  if (
    JSON.stringify(target) !== JSON.stringify(c.target) ||
    !validStamp(c.main) ||
    !validPane(c.origin) ||
    !clean(c.instance, 2048) ||
    !absolute(c.runtime.node) ||
    !absolute(c.runtime.entry) ||
    !/^[0-9a-f]{64}$/.test(c.runtime.digest)
  )
    throw new Error('panel_context_invalid');
}
export function decodeReceipt(raw: unknown): PanelReceipt {
  if (!raw || typeof raw !== 'object') throw new Error('panel_receipt_invalid');
  const r = raw as PanelReceipt;
  validateContext(r);
  if (
    r.schema !== 1 ||
    r.kind !== 'hud-panel-display' ||
    !uuid(r.generation) ||
    !uuid(r.token) ||
    !['opening', 'open', 'closing', 'closed', 'uncertain'].includes(r.phase) ||
    !(r.panel === null || validPane(r.panel)) ||
    r.panel?.pane === r.origin.pane ||
    (r.createdPane !== undefined &&
      (!clean(r.createdPane, 256) ||
        r.createdPane === r.origin.pane ||
        (r.panel !== null && r.panel.pane !== r.createdPane))) ||
    (r.createdWorkspace !== undefined &&
      (!r.createdPane ||
        !clean(r.createdWorkspace, 256) ||
        (r.panel !== null && r.panel.workspace !== r.createdWorkspace))) ||
    (r.reason !== undefined && r.reason !== 'split_reply_lost')
  )
    throw new Error('panel_receipt_invalid');
  return r;
}
export function panelKey(c: Pick<PanelContext, 'main' | 'origin' | 'instance'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        c.main.pid,
        c.main.proc_start,
        c.main.boot_id,
        c.main.pid_domain,
        c.instance,
        c.origin.pane,
        c.origin.terminal,
      ])
    )
    .digest('hex');
}
/** No symlink traversal, including ancestors. Paths need not exist yet. */
export function safePath(file: string): void {
  if (!absolute(file)) throw new Error('panel_path_invalid');
  for (let p = file; ; p = dirname(p)) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) throw new Error('panel_path_unsafe');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (p === dirname(p)) break;
  }
}
export function readJson(file: string): unknown | null {
  safePath(file);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error('panel_file_unsafe');
    const buffer = Buffer.alloc(16385);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (n > 16384) throw new Error('panel_file_oversize');
    return JSON.parse(buffer.subarray(0, n).toString('utf8')) as unknown;
  } finally {
    fs.closeSync(fd);
  }
}
export function saveJson(file: string, value: unknown, exclusive = false): void {
  safePath(file);
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > 16384) throw new Error('panel_file_oversize');
  if (exclusive) {
    fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
    return;
  }
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    safePath(file);
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* renamed */
    }
  }
}
export class PanelStore {
  readonly directory: string;
  constructor(env: NodeJS.ProcessEnv) {
    this.directory = join(getHudDisplayHome(env), 'panels');
    safePath(this.directory);
  }
  file(key: string, suffix = 'receipt'): string {
    if (!/^[0-9a-f]{64}$/.test(key) || !/^[a-z-]+$/.test(suffix)) throw new Error('panel_key_invalid');
    return join(this.directory, `${key}.${suffix}.json`);
  }
  read(key: string): PanelReceipt | null {
    const raw = readJson(this.file(key));
    // The pre-split intent survives receipt loss. A separate permanent used-slot
    // marker makes loss of BOTH documents fail closed, never a new allocation.
    const intent = raw ?? readJson(this.file(key, 'intent'));
    return intent === null ? null : decodeReceipt(intent);
  }
  write(r: PanelReceipt): void {
    decodeReceipt(r);
    saveJson(this.file(panelKey(r)), r);
  }
  registration(token: string): string {
    if (!uuid(token)) throw new Error('panel_token_invalid');
    return join(this.directory, `registration-${token}.json`);
  }
  private fencePath(r: PanelReceipt): string {
    if (!uuid(r.generation)) throw new Error('panel_generation_invalid');
    return join(this.directory, `${panelKey(r)}.close-${r.generation}.json`);
  }
  fenced(r: PanelReceipt): boolean {
    return readJson(this.fencePath(r)) === r.generation;
  }
  fence(r: PanelReceipt): void {
    // A delayed old close cannot overwrite the new generation's fence.
    saveJson(this.fencePath(r), r.generation);
  }
}
