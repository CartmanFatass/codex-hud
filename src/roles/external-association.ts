/** Explicit observation registration only. No Herdr execution or discovery. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseRosterRoot, rosterSelectionKey } from './selection.js';
import { dispatchText } from './pi-dispatch.js';

export const EXTERNAL_MAX_BYTES = 4096;
export const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const locator = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,100}$/.test(v);
export interface ExternalAssociation {
  readonly schema: 1;
  readonly root: string;
  readonly id: string;
  readonly agent: string;
  readonly pane: string;
  readonly tab: string;
  readonly workspace: string | null;
  readonly label: string;
  readonly registered_at: string;
}
export function externalRootHash(root: string): string {
  return rosterSelectionKey(parseRosterRoot(root));
}
export function externalAssociationPath(home: string, root: string, id: string): string {
  if (!EXTERNAL_ID.test(id)) throw new Error('invalid_id');
  return join(home, 'assoc-external', externalRootHash(root), `${id}.json`);
}
export function parseExternalAssociation(value: unknown): ExternalAssociation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  try {
    parseRosterRoot(String(v.root));
  } catch {
    return null;
  }
  if (
    v.schema !== 1 ||
    typeof v.id !== 'string' ||
    !EXTERNAL_ID.test(v.id) ||
    !locator(v.agent) ||
    !locator(v.pane) ||
    !locator(v.tab) ||
    !(v.workspace === null || locator(v.workspace)) ||
    typeof v.label !== 'string' ||
    !v.label.trim() ||
    v.label.length > 240 ||
    /[\u0000-\u001f]/.test(v.label) ||
    typeof v.registered_at !== 'string' ||
    !Number.isFinite(Date.parse(v.registered_at))
  )
    return null;
  return {
    schema: 1,
    root: String(v.root),
    id: v.id,
    agent: v.agent,
    pane: v.pane,
    tab: v.tab,
    workspace: v.workspace,
    label: v.label,
    registered_at: v.registered_at,
  };
}
function directory(path: string, create: boolean): void {
  try {
    const s = fs.lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(path) !== path || s.uid !== process.getuid?.())
      throw new Error('unsafe_path');
    if ((s.mode & 0o077) !== 0) throw new Error('unsafe_path');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw e;
    try {
      fs.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      directory(path, false);
    }
  }
}
export function registerExternal(
  home: string,
  input: Omit<ExternalAssociation, 'schema' | 'registered_at'>,
  nowMs = Date.now()
): ExternalAssociation {
  const record = parseExternalAssociation({ ...input, schema: 1, registered_at: new Date(nowMs).toISOString() });
  if (!record) throw new Error('invalid_registration');
  const text = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(text) > EXTERNAL_MAX_BYTES) throw new Error('registration_too_large');
  const file = externalAssociationPath(home, record.root, record.id);
  directory(home, false);
  directory(join(home, 'assoc-external'), true);
  directory(join(file, '..'), true);
  const compare = (previous: string): ExternalAssociation => {
    let raw: unknown;
    try {
      raw = JSON.parse(previous);
    } catch {
      throw new Error('invalid_registration');
    }
    const old = parseExternalAssociation(raw);
    if (!old) throw new Error('invalid_registration');
    const { registered_at: _a, ...a } = old;
    const { registered_at: _b, ...b } = record;
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('registration_conflict');
    return old;
  };
  let previous: string | null = null;
  try {
    fs.lstatSync(file);
    previous = dispatchText(file, EXTERNAL_MAX_BYTES);
    if (previous === null) throw new Error('unsafe_path');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (previous !== null) return compare(previous);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
    try {
      fs.linkSync(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = dispatchText(file, EXTERNAL_MAX_BYTES);
      if (existing === null) throw new Error('unsafe_path');
      return compare(existing);
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* Not created. */
    }
  }
  return record;
}
export function removeExternal(home: string, root: string, id: string): void {
  const file = externalAssociationPath(home, root, id);
  directory(home, false);
  try {
    directory(join(home, 'assoc-external'), false);
    directory(join(file, '..'), false);
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('unsafe_path');
    fs.unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
